// handlers/llm.ts — LLM (Anthropic) functions

import type { FollowupEntry } from "../types/index.ts";

// ============================================================================
// Types
// ============================================================================

export type LlmSummary = {
  summary: string;
  recommendation: "file_ticket" | "try_steps";
  next_actions?: string[]; // 3-6 actionable bullets
};

export type Ranked = {
  chunk: {
    pageId: string;
    pageTitle: string;
    sectionTitle: string;
    text: string;
    url: string;
    ticketRefs: string[];
    codeSignals: number;
  };
  score: number;
};

// ============================================================================
// Utilities
// ============================================================================

function safeParseJson<T>(s: string): T | null {
  try {
    // Try to extract JSON from markdown code blocks if present
    const jsonMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    let toParse = jsonMatch ? jsonMatch[1].trim() : s.trim();

    // Try to extract JSON object if there's extra text around it
    const objectMatch = toParse.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      toParse = objectMatch[0];
    }

    const parsed = JSON.parse(toParse);

    // Basic validation that it's an object
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * Sanitize user input for use in prompts.
 * Removes control characters and truncates to reasonable length.
 */
function sanitizeInput(input: string, maxLength = 1000): string {
  // Remove control characters except newlines and tabs
  const cleaned = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Truncate to max length
  return cleaned.slice(0, maxLength);
}

// ============================================================================
// Anthropic API
// ============================================================================

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const SUMMARIZE_TIMEOUT_MS = 15000; // 15 second timeout for summarization (safe with two-endpoint pattern)

async function callAnthropic(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 500
): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  const model = Deno.env.get("ANTHROPIC_MODEL") || DEFAULT_MODEL;
  console.log(`[llm/summarize] Calling Anthropic (model=${model})...`);
  const startTime = Date.now();

  // Create AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error("Anthropic API error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const content = data?.content?.[0]?.text;
    console.log(`[llm/summarize] API complete in ${Date.now() - startTime}ms, response length: ${content?.length || 0}`);
    return content || null;
  } catch (e) {
    clearTimeout(timeoutId);
    if ((e as Error).name === "AbortError") {
      console.error(`[llm/summarize] Timeout after ${SUMMARIZE_TIMEOUT_MS}ms`);
      return null;
    }
    console.error("Anthropic call failed:", e);
    return null;
  }
}

// ============================================================================
// LLM Summarize
// ============================================================================

/**
 * LLM summarize with support for no-context mode.
 */
export async function llmSummarize(
  question: string,
  hits: Ranked[],
  noContextReason?: string
): Promise<LlmSummary> {
  const startTime = Date.now();
  console.log(`[llmSummarize] Starting, hits=${hits.length}, noContextReason=${noContextReason || 'none'}`);
  const hasContext = hits.length > 0 && !noContextReason;

  // Fallback if no API key
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    if (hasContext) {
      return {
        summary: `Check the "${hits[0].chunk.pageTitle}" runbook for steps to address this issue.`,
        recommendation: "try_steps",
        next_actions: [
          `Review the "${hits[0].chunk.pageTitle}" runbook`,
          "Follow the documented troubleshooting steps",
          "Gather required information before escalating",
        ],
      };
    }
    return {
      summary: noContextReason
        ? `I couldn't search the runbooks (${noContextReason}). Please describe the issue in more detail or check with your team lead.`
        : "I couldn't find a clear match. Please provide more details about the issue.",
      recommendation: "file_ticket",
      next_actions: [
        "Provide more specific details about the issue",
        "Include any error messages or screenshots",
        "Note the customer name and test/survey URL",
        "Consider escalating if the issue is time-sensitive",
      ],
    };
  }

  // Build context from top hits
  let contextSection: string;
  if (hasContext) {
    contextSection = hits
      .slice(0, 3)
      .map((h, i) => {
        const excerpt = h.chunk.text.slice(0, 400).replaceAll("\n", " ");
        return `[${i + 1}] Title: ${h.chunk.pageTitle} | Section: ${h.chunk.sectionTitle}\nExcerpt: ${excerpt}`;
      })
      .join("\n\n");
  } else {
    contextSection = noContextReason
      ? `NO RUNBOOK CONTEXT AVAILABLE. Reason: ${noContextReason}`
      : "NO RUNBOOK MATCHES FOUND for this query.";
  }

  const systemPrompt = `You are a CS support assistant. Based on runbook excerpts (if available), provide a brief summary, recommendation, and actionable next steps.
Respond ONLY with valid JSON in this exact format:
{"summary": "...", "recommendation": "try_steps" or "file_ticket", "next_actions": ["action 1", "action 2", ...]}

Rules:
- summary: 2-5 sentences summarizing the situation and what to do. Max 600 chars.
- If runbook context is available: summarize the steps from the runbook.
- If NO runbook context: be SUPPORTIVE and ACTION-ORIENTED. Suggest gathering specific info.
- recommendation: "try_steps" if there are actionable CS steps, "file_ticket" if it needs engineering.
- next_actions: 3-6 specific, actionable bullet points. Each should be a clear action the CS agent can take.
- Be supportive and helpful, never dismissive.
- Do not reveal internal systems, secrets, or code snippets.`;

  const userMessage = `User question: ${question}\n\nRunbook context:\n${contextSection}`;

  const raw = await callAnthropic(systemPrompt, userMessage, 700);
  if (!raw) {
    if (hasContext) {
      return {
        summary: `Refer to "${hits[0]?.chunk.pageTitle || "runbook"}" for guidance.`,
        recommendation: "try_steps",
        next_actions: [
          `Review the "${hits[0]?.chunk.pageTitle}" runbook`,
          "Follow the documented steps",
          "Gather customer details before proceeding",
        ],
      };
    }
    return {
      summary: "Unable to generate summary. Please describe the issue in detail for manual review.",
      recommendation: "file_ticket",
      next_actions: [
        "Describe the issue in more detail",
        "Include error messages or screenshots",
        "Note customer name and relevant URLs",
      ],
    };
  }

  const parsed = safeParseJson<LlmSummary>(raw);
  if (parsed && parsed.summary && parsed.recommendation) {
    const summary =
      parsed.summary.length > 600 ? parsed.summary.slice(0, 597) + "..." : parsed.summary;
    const rec = parsed.recommendation === "file_ticket" ? "file_ticket" : "try_steps";
    const nextActions = Array.isArray(parsed.next_actions)
      ? parsed.next_actions.slice(0, 6).map((a) => String(a).slice(0, 200))
      : undefined;
    console.log(`[llmSummarize] Complete in ${Date.now() - startTime}ms, rec=${rec}, actions=${nextActions?.length || 0}`);
    return { summary, recommendation: rec, next_actions: nextActions };
  }

  const truncated = raw.length > 600 ? raw.slice(0, 597) + "..." : raw;
  console.log(`[llmSummarize] Complete (raw fallback) in ${Date.now() - startTime}ms`);
  return { summary: truncated, recommendation: hasContext ? "try_steps" : "file_ticket" };
}

// ============================================================================
// LLM Summarize Followup
// ============================================================================

/**
 * LLM summarize for follow-up questions.
 */
export async function llmSummarizeFollowup(
  rootQuestion: string,
  followups: FollowupEntry[],
  currentFollowup: string,
  hits: Ranked[]
): Promise<LlmSummary> {
  const hasContext = hits.length > 0;

  // Fallback if no API key
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    if (hasContext) {
      return {
        summary: `Based on the "${hits[0].chunk.pageTitle}" runbook, here's what I found for your follow-up.`,
        recommendation: "try_steps",
      };
    }
    return {
      summary: "I couldn't find specific runbook content for your follow-up question.",
      recommendation: "file_ticket",
    };
  }

  // Build conversation history
  const recentFollowups = followups.slice(-3);
  const historySection =
    recentFollowups.length > 0
      ? recentFollowups.map((f, i) => `[Follow-up ${i + 1}]: ${f.text}`).join("\n")
      : "(no previous follow-ups)";

  // Build context from top hits
  const contextSection = hasContext
    ? hits
        .slice(0, 3)
        .map((h, i) => {
          const excerpt = h.chunk.text.slice(0, 400).replaceAll("\n", " ");
          return `[${i + 1}] Title: ${h.chunk.pageTitle} | Section: ${h.chunk.sectionTitle}\nExcerpt: ${excerpt}`;
        })
        .join("\n\n")
    : "NO RUNBOOK MATCHES FOUND for this query.";

  const systemPrompt = `You are a helpful CS support assistant answering a follow-up question in a conversation thread.

Context:
- The user originally asked about a customer issue
- They are now asking a follow-up to clarify, dig deeper, or explore options
- You have access to runbook excerpts (if available) AND your general knowledge

Respond ONLY with valid JSON in this exact format:
{"summary": "...", "recommendation": "try_steps" or "file_ticket"}

Rules:
- summary: 1-4 sentences answering the follow-up question thoughtfully. Max 800 chars.
- For specific technical questions: reference runbook sources when applicable.
- For open-ended questions (e.g., "what options do we have?", "what else could we try?"): use your knowledge of CS best practices, troubleshooting strategies, and customer communication to provide helpful suggestions.
- Be creative and helpful - don't just say "check the runbook" if the user is asking for brainstorming or options.
- Build on the conversation context - don't repeat basic info already covered.
- recommendation: "try_steps" if there are actionable CS steps or suggestions, "file_ticket" only if it clearly needs engineering intervention.
- Keep it practical and actionable.`;

  const userMessage = `Original question: ${rootQuestion}

Previous follow-ups:
${historySection}

Current follow-up question: ${currentFollowup}

Runbook context:
${contextSection}`;

  const raw = await callAnthropic(systemPrompt, userMessage);
  if (!raw) {
    return {
      summary: hasContext
        ? `Refer to "${hits[0]?.chunk.pageTitle || "runbook"}" for more details.`
        : "Unable to generate follow-up response.",
      recommendation: hasContext ? "try_steps" : "file_ticket",
    };
  }

  const parsed = safeParseJson<LlmSummary>(raw);
  if (parsed && parsed.summary && parsed.recommendation) {
    const summary =
      parsed.summary.length > 800 ? parsed.summary.slice(0, 797) + "..." : parsed.summary;
    const rec = parsed.recommendation === "file_ticket" ? "file_ticket" : "try_steps";
    return { summary, recommendation: rec };
  }

  const truncated = raw.length > 800 ? raw.slice(0, 797) + "..." : raw;
  return { summary: truncated, recommendation: hasContext ? "try_steps" : "file_ticket" };
}

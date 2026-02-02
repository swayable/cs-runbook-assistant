// handlers/llm.ts — LLM (Anthropic) functions

import type { FollowupEntry } from "../types/index.ts";

// ============================================================================
// Types
// ============================================================================

export type LlmSummary = {
  summary: string;
  recommendation: "file_ticket" | "try_steps";
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
    const jsonMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    const toParse = jsonMatch ? jsonMatch[1].trim() : s.trim();
    return JSON.parse(toParse) as T;
  } catch {
    return null;
  }
}

// ============================================================================
// Anthropic API
// ============================================================================

const DEFAULT_MODEL = "claude-3-5-sonnet-20240620";

async function callAnthropic(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 500
): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  const model = Deno.env.get("ANTHROPIC_MODEL") || DEFAULT_MODEL;

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
    });

    if (!res.ok) {
      console.error("Anthropic API error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const content = data?.content?.[0]?.text;
    return content || null;
  } catch (e) {
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
  const hasContext = hits.length > 0 && !noContextReason;

  // Fallback if no API key
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    if (hasContext) {
      return {
        summary: `Check the "${hits[0].chunk.pageTitle}" runbook for steps to address this issue.`,
        recommendation: "try_steps",
      };
    }
    return {
      summary: noContextReason
        ? `I couldn't search the runbooks (${noContextReason}). Please describe the issue in more detail or check with your team lead.`
        : "I couldn't find a clear match. Please provide more details about the issue.",
      recommendation: "file_ticket",
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

  const systemPrompt = `You are a CS support assistant. Based on runbook excerpts (if available), provide a brief summary and recommendation.
Respond ONLY with valid JSON in this exact format:
{"summary": "...", "recommendation": "try_steps" or "file_ticket"}

Rules:
- summary: 1-3 sentences summarizing what to do. Max 600 chars.
- If runbook context is available: summarize the steps from the runbook.
- If NO runbook context: acknowledge this and suggest next steps (gather info, escalate, etc.)
- recommendation: "try_steps" if there are actionable CS steps, "file_ticket" if it needs engineering or no steps are clear.
- Keep it concise and actionable.
- Do not reveal internal systems, secrets, or code snippets.`;

  const userMessage = `User question: ${question}\n\nRunbook context:\n${contextSection}`;

  const raw = await callAnthropic(systemPrompt, userMessage);
  if (!raw) {
    if (hasContext) {
      return {
        summary: `Refer to "${hits[0]?.chunk.pageTitle || "runbook"}" for guidance.`,
        recommendation: "try_steps",
      };
    }
    return {
      summary: "Unable to generate summary. Please describe the issue in detail for manual review.",
      recommendation: "file_ticket",
    };
  }

  const parsed = safeParseJson<LlmSummary>(raw);
  if (parsed && parsed.summary && parsed.recommendation) {
    const summary =
      parsed.summary.length > 600 ? parsed.summary.slice(0, 597) + "..." : parsed.summary;
    const rec = parsed.recommendation === "file_ticket" ? "file_ticket" : "try_steps";
    return { summary, recommendation: rec };
  }

  const truncated = raw.length > 600 ? raw.slice(0, 597) + "..." : raw;
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

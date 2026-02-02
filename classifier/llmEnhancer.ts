// classifier/llmEnhancer.ts — LLM-enhanced classification
//
// Uses LLM to:
// 1. Generate better CS-safe step descriptions
// 2. Provide clearer reasoning
// 3. Extract additional context
//
// IMPORTANT: LLM CANNOT override engineer_required decisions from heuristics

import type { Chunk, ClassifierResult, EvidenceItem } from "../types/index.ts";

const DEFAULT_MODEL = "claude-3-5-haiku-20241022"; // Haiku is faster and good enough for step extraction
const ENHANCE_TIMEOUT_MS = 8000; // 8 second timeout (Haiku is fast)
const ENHANCE_MAX_RETRIES = 3; // Max retries for enhancement
const ENHANCE_RETRY_DELAY_MS = 500; // Base delay between retries

// ============================================================================
// Anthropic API caller with retry
// ============================================================================

async function callAnthropicOnce(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  model: string
): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.log(`[enhanceWithLLM/api] No API key`);
    return null;
  }

  console.log(`[enhanceWithLLM/api] Starting fetch to Anthropic (model=${model}, timeout=${ENHANCE_TIMEOUT_MS}ms)...`);
  const fetchStartTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log(`[enhanceWithLLM/api] Timeout triggered after ${ENHANCE_TIMEOUT_MS}ms`);
    controller.abort();
  }, ENHANCE_TIMEOUT_MS);

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
    console.log(`[enhanceWithLLM/api] Fetch complete in ${Date.now() - fetchStartTime}ms, status=${res.status}`);

    if (!res.ok) {
      const errText = await res.text();
      console.error("[enhanceWithLLM/api] API error:", res.status, errText);
      throw new Error(`API error ${res.status}: ${errText.slice(0, 100)}`);
    }

    const data = await res.json();
    const text = data?.content?.[0]?.text || null;
    console.log(`[enhanceWithLLM/api] Response parsed, text length=${text?.length || 0}`);
    return text;
  } catch (e) {
    clearTimeout(timeoutId);
    console.log(`[enhanceWithLLM/api] Catch block hit after ${Date.now() - fetchStartTime}ms: ${(e as Error).name} - ${(e as Error).message}`);
    if ((e as Error).name === "AbortError") {
      throw new Error(`Timeout after ${ENHANCE_TIMEOUT_MS}ms`);
    }
    throw e;
  }
}

async function callAnthropic(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 800
): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  // Use dedicated env var, don't let ANTHROPIC_MODEL override (that's for summarizer)
  const model = Deno.env.get("LLM_ENHANCER_MODEL") || DEFAULT_MODEL;

  for (let attempt = 0; attempt < ENHANCE_MAX_RETRIES; attempt++) {
    try {
      return await callAnthropicOnce(systemPrompt, userMessage, maxTokens, model);
    } catch (e) {
      const isLastAttempt = attempt === ENHANCE_MAX_RETRIES - 1;
      if (isLastAttempt) {
        console.warn(`LLM enhancement failed after ${ENHANCE_MAX_RETRIES} attempts:`, (e as Error).message);
        return null;
      }
      const delay = ENHANCE_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.warn(`LLM enhancement attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}

function safeParseJson<T>(s: string): T | null {
  try {
    // Try to extract JSON from markdown code blocks if present
    const jsonMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    const toParse = jsonMatch ? jsonMatch[1].trim() : s.trim();
    return JSON.parse(toParse) as T;
  } catch {
    return null;
  }
}

// ============================================================================
// LLM Enhancement Types
// ============================================================================

type LLMEnhancement = {
  enhanced_cs_steps: string[];
  additional_reasons: string[];
  summary: string;
};

// ============================================================================
// Enhance classification with LLM
// ============================================================================

export async function enhanceWithLLM(
  question: string,
  chunks: Chunk[],
  baseResult: ClassifierResult
): Promise<ClassifierResult> {
  const startTime = Date.now();
  console.log(`[enhanceWithLLM] Starting enhancement...`);

  // If no API key, return base result
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    console.log(`[enhanceWithLLM] No API key, returning base result`);
    return baseResult;
  }

  // Build context from chunks
  const context = chunks.slice(0, 3).map((c, i) => {
    const excerpt = c.text.slice(0, 500).replace(/\n+/g, " ");
    return `[${i + 1}] Page: ${c.pageTitle}\nSection: ${c.sectionTitle}\nURL: ${c.url}\nContent: ${excerpt}`;
  }).join("\n\n");
  console.log(`[enhanceWithLLM] Built context from ${Math.min(chunks.length, 3)} chunks`);

  const systemPrompt = `You are a CS support assistant that analyzes runbooks to extract actionable steps for Customer Support agents.

CRITICAL RULES:
1. CS agents CANNOT use: CLI commands, shell scripts, database consoles, SSH, kubectl, or any terminal operations
2. CS agents CAN ONLY use: Web UIs, admin dashboards, clicking buttons, navigating pages, filling forms
3. You must cite which runbook excerpt each step comes from
4. If a step requires CLI/DB/scripts, DO NOT include it - instead note it requires engineering

The base classification has already determined: can_cs_handle=${baseResult.can_cs_handle}
You CANNOT change this decision. Your job is only to enhance the steps and reasoning.

Respond with STRICT JSON only:
{
  "enhanced_cs_steps": ["Step 1 description (from excerpt N)", "Step 2..."],
  "additional_reasons": ["Reason 1", "Reason 2"],
  "summary": "Brief 1-2 sentence summary of what CS should do"
}

Rules for enhanced_cs_steps:
- Only include steps that CS can actually do via UI
- Each step must reference which excerpt it came from
- Maximum 6 steps
- If can_cs_handle is false, return empty array for enhanced_cs_steps
- Steps must be actionable: "Click X", "Navigate to Y", "Select Z from dropdown"`;

  const userMessage = `User question: ${question}

Base classification:
- can_cs_handle: ${baseResult.can_cs_handle}
- reasons: ${baseResult.reasons.join("; ")}
- current cs_safe_steps: ${baseResult.cs_safe_steps.join("; ") || "(none)"}

Runbook excerpts:
${context}

Enhance this classification with better step descriptions and reasoning. Remember: you CANNOT change can_cs_handle.`;

  console.log(`[enhanceWithLLM] Calling Anthropic API...`);
  const raw = await callAnthropic(systemPrompt, userMessage);
  console.log(`[enhanceWithLLM] API call complete, raw response length: ${raw?.length || 0}`);

  if (!raw) {
    console.log(`[enhanceWithLLM] No response from API, returning base result after ${Date.now() - startTime}ms`);
    return baseResult;
  }

  const enhancement = safeParseJson<LLMEnhancement>(raw);
  if (!enhancement) {
    console.log(`[enhanceWithLLM] Failed to parse JSON, returning base result after ${Date.now() - startTime}ms`);
    return baseResult;
  }
  console.log(`[enhanceWithLLM] Parsed enhancement: ${enhancement.enhanced_cs_steps?.length || 0} steps`);

  // Merge LLM enhancements with base result
  // IMPORTANT: Never override the core can_cs_handle decision
  const result: ClassifierResult = {
    ...baseResult,
    reasons: [
      ...baseResult.reasons,
      ...filterNewReasons(enhancement.additional_reasons, baseResult.reasons),
    ].slice(0, 6),
  };

  // Only use enhanced steps if can_cs_handle is true and we got valid steps
  if (baseResult.can_cs_handle && enhancement.enhanced_cs_steps?.length > 0) {
    // Filter out any steps that accidentally contain CLI/DB patterns
    const safeSteps = enhancement.enhanced_cs_steps.filter((step) => {
      const lowerStep = step.toLowerCase();
      const hasCliPattern = /\b(ssh|curl|kubectl|mongo|psql|npm|pip|bash|script|terminal)\b/i.test(step);
      const hasDbPattern = /\b(db\.|updateMany|deleteMany|ObjectId|aggregate)\b/i.test(step);
      return !hasCliPattern && !hasDbPattern;
    });

    if (safeSteps.length > 0) {
      result.cs_safe_steps = safeSteps.slice(0, 6);
    }
  }

  console.log(`[enhanceWithLLM] Complete in ${Date.now() - startTime}ms`);
  return result;
}

function filterNewReasons(newReasons: string[], existingReasons: string[]): string[] {
  if (!Array.isArray(newReasons)) return [];
  const existing = new Set(existingReasons.map((r) => r.toLowerCase()));
  return newReasons.filter((r) => {
    if (typeof r !== "string") return false;
    return !existing.has(r.toLowerCase()) && r.length > 5 && r.length < 200;
  });
}

// ============================================================================
// Full enhanced pipeline
// ============================================================================

export async function classifyWithLLM(
  question: string,
  chunks: Chunk[],
  baseClassify: (q: string, c: Chunk[]) => ClassifierResult
): Promise<ClassifierResult> {
  // Step 1: Run deterministic classification first
  const baseResult = baseClassify(question, chunks);

  // Step 2: Enhance with LLM (cannot override base decision)
  const enhanced = await enhanceWithLLM(question, chunks, baseResult);

  return enhanced;
}

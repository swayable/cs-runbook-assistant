// director/llmDirector.ts — LLM-powered query intent classification

import type { DirectorDecision } from "./types.ts";
import type { RunbookMetadata } from "./metadata.ts";
import { formatMetadataForPrompt } from "./metadata.ts";
import {
  LLM_DIRECTOR_ENABLED,
  LLM_DIRECTOR_TIMEOUT_MS,
  LLM_DIRECTOR_MODEL,
  LLM_DIRECTOR_MAX_TOKENS,
  LLM_DIRECTOR_RETRIES,
} from "../env.ts";

const DIRECTOR_SYSTEM_PROMPT = `You are a query classifier for a Customer Support (CS) runbook assistant. Your job is to analyze user queries and determine:

1. INTENT - What type of question is this?
   - troubleshooting: Something is broken/not working ("stuck", "error", "won't load", "failed")
   - how_to: Steps to accomplish something ("how do I", "steps to", "process for")
   - info_gathering: Looking up information ("what is", "where can I find", "what does X mean")
   - out_of_scope: Not related to our CS runbooks at all
   - help: Asking about the bot's capabilities ("what can you do", "help")

2. IN_SCOPE - Is this query likely covered by our runbooks?
   - Look at the runbook titles and keywords provided
   - If no runbook seems related, mark as out_of_scope

3. QUERY EXPANSION (optional) - If the query is vague, suggest a clearer reformulation

IMPORTANT RULES:
- CS runbooks cover: test/survey issues, analysis states, tracker problems, data exports, customer-facing UI issues, delivery issues
- Out of scope examples: general coding questions, internal engineering tools, non-work topics, weather, personal questions
- When uncertain, default to in_scope=true (let the RAG system decide)
- Be concise - this runs on every query

Respond with STRICT JSON only:
{
  "intent": "troubleshooting" | "how_to" | "info_gathering" | "out_of_scope" | "help",
  "confidence": "high" | "medium" | "low",
  "in_scope": true | false,
  "expanded_query": "optional clearer query if original is vague",
  "out_of_scope_reason": "optional brief reason if out_of_scope",
  "matched_topics": ["optional", "matching", "runbook", "titles"]
}`;

/**
 * Parse JSON from LLM response, handling markdown code blocks and trailing text
 */
function safeParseJson<T>(s: string): T | null {
  try {
    // Try to extract JSON from markdown code blocks if present
    const jsonMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1].trim()) as T;
    }

    // Try to extract first JSON object (model sometimes adds notes after)
    const objectMatch = s.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]) as T;
    }

    return JSON.parse(s.trim()) as T;
  } catch {
    return null;
  }
}

/**
 * Timeout wrapper for promises
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout: ${label} after ${ms}ms`)),
      ms
    ) as unknown as number;
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs = 500
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e as Error;
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(`Director LLM attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Call Anthropic API with Haiku model for fast classification
 */
async function callDirectorLLM(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number
): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_DIRECTOR_MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!res.ok) {
      console.error("Director LLM error:", res.status);
      return null;
    }

    const data = await res.json();
    return data?.content?.[0]?.text || null;
  } catch (e) {
    console.error("Director LLM call failed:", e);
    return null;
  }
}

/**
 * Validate that parsed decision has required fields
 */
function isValidDecision(d: unknown): d is DirectorDecision {
  if (!d || typeof d !== "object") return false;
  const obj = d as Record<string, unknown>;
  return (
    typeof obj.intent === "string" &&
    ["troubleshooting", "how_to", "info_gathering", "out_of_scope", "help"].includes(
      obj.intent
    ) &&
    typeof obj.confidence === "string" &&
    ["high", "medium", "low"].includes(obj.confidence) &&
    typeof obj.in_scope === "boolean"
  );
}

/**
 * Run LLM director to classify query intent and scope.
 * Returns null if disabled, times out, or fails (graceful degradation).
 */
export async function runLLMDirector(
  question: string,
  metadata: RunbookMetadata | null
): Promise<{ decision: DirectorDecision | null; latencyMs: number }> {
  const startTime = Date.now();

  if (!LLM_DIRECTOR_ENABLED) {
    return { decision: null, latencyMs: 0 };
  }

  const metadataContext = metadata
    ? formatMetadataForPrompt(metadata)
    : "Runbook metadata not available.";

  const userMessage = `User query: "${question}"

${metadataContext}

Classify this query.`;

  try {
    const raw = await withRetry(
      () => withTimeout(
        callDirectorLLM(DIRECTOR_SYSTEM_PROMPT, userMessage, LLM_DIRECTOR_MAX_TOKENS),
        LLM_DIRECTOR_TIMEOUT_MS,
        "director_llm"
      ),
      LLM_DIRECTOR_RETRIES
    );

    const latencyMs = Date.now() - startTime;

    if (!raw) {
      return { decision: null, latencyMs };
    }

    const parsed = safeParseJson<DirectorDecision>(raw);
    if (!isValidDecision(parsed)) {
      console.warn(`Director LLM returned invalid JSON (len=${raw.length}):`, raw.slice(0, 500));
      return { decision: null, latencyMs };
    }

    return { decision: parsed, latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - startTime;
    console.warn("Director LLM failed after retries:", String((e as Error)?.message || e));
    return { decision: null, latencyMs };
  }
}

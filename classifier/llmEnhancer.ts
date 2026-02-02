// classifier/llmEnhancer.ts — LLM-enhanced classification
//
// Uses LLM to:
// 1. Generate better CS-safe step descriptions
// 2. Provide clearer reasoning
// 3. Extract additional context
//
// IMPORTANT: LLM CANNOT override engineer_required decisions from heuristics

import type { Chunk, ClassifierResult, EvidenceItem } from "../types/index.ts";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

// ============================================================================
// Anthropic API caller
// ============================================================================

async function callAnthropic(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 800
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
    return data?.content?.[0]?.text || null;
  } catch (e) {
    console.error("Anthropic call failed:", e);
    return null;
  }
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
  // If no API key, return base result
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return baseResult;
  }

  // Build context from chunks
  const context = chunks.slice(0, 3).map((c, i) => {
    const excerpt = c.text.slice(0, 500).replace(/\n+/g, " ");
    return `[${i + 1}] Page: ${c.pageTitle}\nSection: ${c.sectionTitle}\nURL: ${c.url}\nContent: ${excerpt}`;
  }).join("\n\n");

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

  const raw = await callAnthropic(systemPrompt, userMessage);
  if (!raw) return baseResult;

  const enhancement = safeParseJson<LLMEnhancement>(raw);
  if (!enhancement) return baseResult;

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

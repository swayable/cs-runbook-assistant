// classifier/classify.ts — Main classification logic
//
// Implements the CS vs Engineer classification with:
// 1. Deterministic heuristics (run FIRST, cannot be overridden)
// 2. Optional LLM for summarization and step extraction

import type { Chunk, Ranked, ClassifierResult, EvidenceItem, Confidence } from "../types/index.ts";
import { detectHeuristics, extractCSSafeSteps, chunkHasEngineerSignals } from "./heuristics.ts";
import { rank } from "../retrieval/rank.ts";

// ============================================================================
// Evidence extraction
// ============================================================================

function buildEvidence(chunks: Chunk[], maxItems = 5): EvidenceItem[] {
  return chunks.slice(0, maxItems).map((c) => ({
    pageTitle: c.pageTitle,
    sectionTitle: c.sectionTitle,
    url: c.url,
    excerpt: c.text.slice(0, 300),
  }));
}

// ============================================================================
// Escalation info templates
// ============================================================================

function getEscalationInfo(question: string): string[] {
  const q = question.toLowerCase();
  const baseInfo = [
    "Test/survey URL(s) or diagnostics links",
    "Test ID(s) and client/org name",
    "Expected vs observed behavior",
    "Timestamp(s) with timezone",
    "Screenshots of relevant UI state",
    "Whether this blocks delivery + deadline",
  ];

  // Add context-specific info requests
  if (q.includes("pending") || q.includes("finalize")) {
    return ["Diagnostics URL showing Pending/Finalize state", ...baseInfo];
  }
  if (q.includes("error") || q.includes("fail")) {
    return ["Full error message/stack trace if visible", ...baseInfo];
  }
  if (q.includes("sync") || q.includes("sync error")) {
    return ["When did the sync last succeed?", "What changed recently?", ...baseInfo];
  }
  if (q.includes("tracker") || q.includes("monthly")) {
    return ["Tracker URL", "Requested breakdown/time buckets", "Exact metrics needed", ...baseInfo];
  }

  return baseInfo;
}

// ============================================================================
// Main classifier
// ============================================================================

export function classify(question: string, relevantChunks: Chunk[]): ClassifierResult {
  // Case: No relevant chunks found
  if (relevantChunks.length === 0) {
    return {
      can_cs_handle: false,
      confidence: "low",
      reasons: ["No relevant runbook content found for this query"],
      cs_safe_steps: [],
      escalation_info_needed: getEscalationInfo(question),
      evidence: [],
    };
  }

  // Step 1: Run deterministic heuristics (CANNOT BE OVERRIDDEN)
  const heuristics = detectHeuristics(relevantChunks);

  // Step 2: Build evidence from chunks
  const evidence = buildEvidence(relevantChunks);

  // Step 3: Determine classification based on heuristics
  // Engineer-required signals ALWAYS win
  if (heuristics.engineerRequired) {
    return {
      can_cs_handle: false,
      confidence: determineConfidence(heuristics, relevantChunks),
      reasons: heuristics.engineerReasons,
      cs_safe_steps: [], // No CS steps if engineer required
      escalation_info_needed: getEscalationInfo(question),
      evidence,
    };
  }

  // Step 4: If CS-handlable, extract safe steps
  const allText = relevantChunks.map((c) => c.text).join("\n");
  const csSafeSteps = extractCSSafeSteps(allText);

  // If we have CS signals and at least some steps, it's CS-handlable
  if (heuristics.csHandlable && csSafeSteps.length >= 1) {
    return {
      can_cs_handle: true,
      confidence: determineConfidence(heuristics, relevantChunks),
      reasons: heuristics.csReasons,
      cs_safe_steps: csSafeSteps,
      escalation_info_needed: getEscalationInfo(question),
      evidence,
    };
  }

  // Step 5: Ambiguous case - be conservative
  // Check if chunks have mixed signals
  const hasAnyEngineerChunks = relevantChunks.some(chunkHasEngineerSignals);

  if (hasAnyEngineerChunks) {
    return {
      can_cs_handle: false,
      confidence: "medium",
      reasons: [
        "Runbook contains mixed CS and engineering steps",
        "Some steps may require engineer access",
        ...heuristics.engineerReasons,
      ],
      cs_safe_steps: csSafeSteps, // Still provide CS-safe steps if any exist
      escalation_info_needed: getEscalationInfo(question),
      evidence,
    };
  }

  // If no engineer signals but also no clear CS workflow patterns
  if (csSafeSteps.length === 0) {
    return {
      can_cs_handle: false,
      confidence: "low",
      reasons: [
        "Could not extract clear CS-actionable steps from runbook",
        "Recommend engineer review of this case",
      ],
      cs_safe_steps: [],
      escalation_info_needed: getEscalationInfo(question),
      evidence,
    };
  }

  // Has CS steps but no clear UI workflow patterns - medium confidence
  return {
    can_cs_handle: true,
    confidence: "medium",
    reasons: [
      "Found actionable steps without engineer-only requirements",
      ...heuristics.csReasons,
    ],
    cs_safe_steps: csSafeSteps,
    escalation_info_needed: getEscalationInfo(question),
    evidence,
  };
}

// ============================================================================
// Confidence determination
// ============================================================================

function determineConfidence(
  heuristics: ReturnType<typeof detectHeuristics>,
  chunks: Chunk[]
): Confidence {
  // High confidence cases:
  // - Multiple strong engineer signals
  // - Multiple strong CS signals with clear UI steps
  const totalEngineerSignals =
    heuristics.detectedPatterns.cli.length +
    heuristics.detectedPatterns.scripts.length +
    heuristics.detectedPatterns.database.length +
    heuristics.detectedPatterns.dangerous.length;

  const totalCSSignals = heuristics.detectedPatterns.uiWorkflow.length;

  if (heuristics.engineerRequired && totalEngineerSignals >= 3) {
    return "high";
  }
  if (heuristics.csHandlable && totalCSSignals >= 3) {
    return "high";
  }

  // Medium confidence: some signals but not overwhelming
  if (totalEngineerSignals >= 1 || totalCSSignals >= 1) {
    return "medium";
  }

  // Low confidence: unclear
  return "low";
}

// ============================================================================
// Full pipeline: retrieve + classify
// ============================================================================

export function retrieveAndClassify(
  question: string,
  allChunks: Chunk[],
  topK = 5
): ClassifierResult {
  // Step 1: Retrieve relevant chunks
  const ranked = rank(question, allChunks, topK);
  const relevantChunks = ranked.map((r) => r.chunk);

  // Step 2: Classify
  return classify(question, relevantChunks);
}

// Export types used externally
export type { ClassifierResult };

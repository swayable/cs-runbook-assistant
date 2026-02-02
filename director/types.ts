// director/types.ts — LLM Director types

/**
 * Intent classification for user queries
 */
export type IntentType =
  | "troubleshooting" // "X is broken", "X isn't working", error states
  | "how_to" // "How do I...", "Steps to...", process questions
  | "info_gathering" // "What is X?", "Where do I find...", lookups
  | "out_of_scope" // Unrelated to CS runbooks
  | "help"; // Asking about the bot's capabilities

/**
 * LLM Director decision output
 */
export type DirectorDecision = {
  intent: IntentType;
  confidence: "high" | "medium" | "low";
  in_scope: boolean;
  expanded_query?: string; // Reformulated query for better RAG
  out_of_scope_reason?: string; // Why we think this is out of scope
  matched_topics?: string[]; // Which runbook topics seem relevant
};

/**
 * Director configuration
 */
export type DirectorConfig = {
  enabled: boolean;
  timeoutMs: number;
  model: string;
  maxTokens: number;
};

// llm/summarize.ts — LLM summarization (placeholder)
//
// This file is a placeholder for future Anthropic-based summarization.
// Currently, the bot uses keyword-based retrieval without LLM calls.
//
// To add LLM summarization:
// 1. Import Anthropic SDK or use fetch to call the API
// 2. Implement llmSummarize() that takes chunks and a question
// 3. Return a structured summary

export type LlmSummary = {
  likelyIssue: string;
  steps: string[];
  confidence: number;
};

// Placeholder — returns null (no LLM summary available)
export async function llmSummarize(
  _question: string,
  _chunks: { text: string; pageTitle: string }[],
): Promise<LlmSummary | null> {
  // Not implemented — retrieval-only mode
  return null;
}

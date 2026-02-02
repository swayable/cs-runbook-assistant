// director/metadata.ts — Runbook metadata extraction for LLM context

import type { Chunk, ChunkWithEmbedding } from "../types/index.ts";

/**
 * Compact runbook metadata for LLM director context
 */
export type RunbookMetadata = {
  runbookTitles: string[];
  topicKeywords: string[];
  totalChunks: number;
  hasEngineeringContent: boolean;
};

/**
 * Extract compact metadata from index chunks for LLM context.
 * Designed to fit in ~500 tokens for the director prompt.
 */
export function extractRunbookMetadata(
  chunks: Chunk[] | ChunkWithEmbedding[]
): RunbookMetadata {
  if (!chunks || chunks.length === 0) {
    return {
      runbookTitles: [],
      topicKeywords: [],
      totalChunks: 0,
      hasEngineeringContent: false,
    };
  }

  const titles = new Set<string>();
  const sections = new Set<string>();
  let engineeringChunks = 0;

  for (const chunk of chunks) {
    titles.add(chunk.pageTitle);
    if (chunk.sectionTitle && chunk.sectionTitle !== "Page Summary") {
      sections.add(chunk.sectionTitle);
    }
    if (chunk.codeSignals >= 6) engineeringChunks++;
  }

  // Extract topic keywords from titles and sections
  const topicKeywords = extractTopicKeywords([...titles], [...sections]);

  return {
    runbookTitles: [...titles].slice(0, 30), // Cap at 30 for token budget
    topicKeywords: topicKeywords.slice(0, 50),
    totalChunks: chunks.length,
    hasEngineeringContent: engineeringChunks > chunks.length * 0.2,
  };
}

/**
 * Extract meaningful topic keywords from runbook titles and sections
 */
function extractTopicKeywords(titles: string[], sections: string[]): string[] {
  const allText = [...titles, ...sections].join(" ");
  const words = allText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && w.length <= 20);

  // Common stop words to filter out
  const stopWords = new Set([
    "that",
    "this",
    "with",
    "from",
    "have",
    "will",
    "been",
    "were",
    "they",
    "their",
    "what",
    "when",
    "where",
    "which",
    "there",
    "about",
    "into",
    "more",
    "some",
    "could",
    "would",
    "should",
    "being",
    "after",
    "before",
    "between",
    "through",
    "during",
    "without",
    "within",
    "along",
    "following",
    "across",
    "behind",
    "beyond",
    "plus",
    "except",
    "upon",
    "toward",
    "page",
    "section",
    "summary",
    "overview",
    "steps",
    "step",
  ]);

  // Count frequency, return top keywords
  const freq = new Map<string, number>();
  for (const w of words) {
    if (!stopWords.has(w)) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }

  return [...freq.entries()]
    .filter(([_, count]) => count >= 1) // Include even single occurrences for variety
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .slice(0, 50);
}

/**
 * Format metadata as compact text for LLM prompt.
 */
export function formatMetadataForPrompt(metadata: RunbookMetadata): string {
  if (metadata.totalChunks === 0) {
    return "Runbook index not available.";
  }

  const titlesList = metadata.runbookTitles.map((t) => `- ${t}`).join("\n");
  const keywords = metadata.topicKeywords.slice(0, 30).join(", ");

  return `Available Runbooks (${metadata.totalChunks} chunks from ${metadata.runbookTitles.length} pages):
${titlesList}

Topic Keywords: ${keywords}`;
}

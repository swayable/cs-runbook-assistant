// retrieval/rank.ts — Scoring and ranking

import type { Chunk, Ranked, ChunkWithEmbedding } from "../types/index.ts";
import { normalizeQuery, tokenize, uniq } from "../util/text.ts";
import { cosineSimilarity, embedText } from "./embeddings.ts";
import { HYBRID_SEARCH_ENABLED } from "../env.ts";

// Hybrid search weights
const KEYWORD_WEIGHT = 0.4;
const EMBEDDING_WEIGHT = 0.6;
const HYBRID_THRESHOLD = 0.15;

// Query embedding cache (reduces API calls for repeated queries)
const QUERY_EMBED_CACHE = new Map<string, { vec: number[]; ts: number }>();
const QUERY_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const QUERY_CACHE_MAX_SIZE = 100;

export function score(queryRaw: string, chunk: Chunk): number {
  const q = normalizeQuery(queryRaw);
  const hay = (chunk.pageTitle + "\n" + chunk.sectionTitle + "\n" + chunk.text)
    .toLowerCase();
  const terms = uniq(tokenize(q));

  let s = 0;
  for (const t of terms) if (hay.includes(t)) s += 1;

  for (const t of terms) {
    if (chunk.pageTitle.toLowerCase().includes(t)) s += 3;
    if (chunk.sectionTitle.toLowerCase().includes(t)) s += 2;
  }

  // Intent boosts
  if (q.includes("pending") || q.includes("finalize")) {
    const title = chunk.pageTitle.toLowerCase();
    if (title.includes("pending")) s += 4;
    if (title.includes("finalize")) s += 4;
    if (title.includes("preprocess")) s += 2;
  }

  // Code penalty
  if (chunk.codeSignals >= 6) s -= 4;
  if (chunk.codeSignals >= 12) s -= 8;

  return s;
}

export function rank(queryRaw: string, chunks: Chunk[], k = 6): Ranked[] {
  const scored = chunks
    .map((c) => ({ chunk: c, score: score(queryRaw, c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // Dedupe by pageTitle
  const out: Ranked[] = [];
  const seenPages = new Set<string>();
  for (const item of scored) {
    if (seenPages.has(item.chunk.pageTitle)) continue;
    out.push(item);
    seenPages.add(item.chunk.pageTitle);
    if (out.length >= k) break;
  }
  return out;
}

export function isEngineeringOnly(chunks: Chunk[]): boolean {
  if (!chunks.length) return true;
  const avg = chunks.reduce((s, c) => s + c.codeSignals, 0) / chunks.length;
  return avg >= 8;
}

// --- Hybrid Search Functions ---

/**
 * Get query embedding with caching to reduce API calls.
 */
export async function embedQueryCached(query: string): Promise<number[]> {
  const key = query.toLowerCase().trim();

  // Check cache
  const cached = QUERY_EMBED_CACHE.get(key);
  if (cached && Date.now() - cached.ts < QUERY_CACHE_TTL_MS) {
    return cached.vec;
  }

  // Generate new embedding
  const vec = await embedText(query);

  // Evict oldest if over limit
  if (QUERY_EMBED_CACHE.size >= QUERY_CACHE_MAX_SIZE) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of QUERY_EMBED_CACHE.entries()) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey) QUERY_EMBED_CACHE.delete(oldestKey);
  }

  // Store in cache
  QUERY_EMBED_CACHE.set(key, { vec, ts: Date.now() });
  return vec;
}

/**
 * Clear the query embedding cache (useful for testing).
 */
export function clearQueryCache(): void {
  QUERY_EMBED_CACHE.clear();
}

/**
 * Normalize keyword score to 0-1 range.
 */
export function keywordScoreNormalized(queryRaw: string, chunk: Chunk): number {
  const raw = score(queryRaw, chunk);
  return Math.min(Math.max(raw, 0) / 10, 1); // normalize to 0-1, cap at 10
}

/**
 * Compute hybrid score combining keyword and embedding similarity.
 */
export function hybridScore(
  queryEmbedding: number[],
  queryRaw: string,
  chunk: ChunkWithEmbedding
): number {
  const kwNorm = keywordScoreNormalized(queryRaw, chunk);

  // If chunk has no embedding, fall back to keyword-only
  if (!chunk.embedding || chunk.embedding.length === 0) {
    return kwNorm;
  }

  const embScore = cosineSimilarity(queryEmbedding, chunk.embedding);

  let hybrid = KEYWORD_WEIGHT * kwNorm + EMBEDDING_WEIGHT * embScore;

  // Code penalty (preserved from existing logic)
  if (chunk.codeSignals >= 12) {
    hybrid -= 0.2;
  } else if (chunk.codeSignals >= 6) {
    hybrid -= 0.1;
  }

  return hybrid;
}

/**
 * Hybrid ranking function that combines keyword and embedding scores.
 * Falls back to keyword-only ranking when embeddings unavailable.
 */
export async function rankHybrid(
  queryRaw: string,
  chunks: ChunkWithEmbedding[] | Chunk[],
  k = 6
): Promise<{ results: Ranked[]; embeddingUsed: boolean }> {
  // Check if hybrid search is enabled and chunks have embeddings
  const firstChunk = chunks[0] as ChunkWithEmbedding | undefined;
  const hasEmbeddings = firstChunk && "embedding" in firstChunk && firstChunk.embedding?.length > 0;

  if (!HYBRID_SEARCH_ENABLED || !hasEmbeddings) {
    return { results: rank(queryRaw, chunks as Chunk[], k), embeddingUsed: false };
  }

  // Get query embedding (cached)
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedQueryCached(queryRaw);
  } catch (e) {
    console.warn("Query embedding failed, falling back to keyword:", String((e as any)?.message || e));
    return { results: rank(queryRaw, chunks as Chunk[], k), embeddingUsed: false };
  }

  // Score all chunks using hybrid scoring
  const scored = (chunks as ChunkWithEmbedding[])
    .map((c) => ({ chunk: c, score: hybridScore(queryEmbedding, queryRaw, c) }))
    .filter((x) => x.score > HYBRID_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  // Dedupe by pageTitle
  const out: Ranked[] = [];
  const seenPages = new Set<string>();
  for (const item of scored) {
    if (seenPages.has(item.chunk.pageTitle)) continue;
    out.push(item);
    seenPages.add(item.chunk.pageTitle);
    if (out.length >= k) break;
  }

  return { results: out, embeddingUsed: true };
}

# Hybrid Embedding Search Implementation Plan

**Status:** Proposed
**Author:** Claude Code
**Created:** 2026-02-01
**Target Completion:** 1 week

## Overview

This document breaks down the implementation of hybrid keyword + embedding retrieval for the CS Helper bot into discrete tasks with acceptance criteria.

### Problem Statement

The current keyword-based ranker (`retrieval/rank.ts`) uses substring matching on tokenized terms. This fails when user phrasing differs from runbook terminology:

| User Query | Runbook Title | Current Result |
|------------|---------------|----------------|
| "stuck analysis" | "Resolving Pending State" | No match |
| "survey won't complete" | "Finalize Blocked" | No match |
| "tracker broken" | "Monthly Reporting Issues" | No match |

### Solution

Introduce embedding-based semantic search alongside the existing keyword ranker, with a hybrid scoring formula:

```
hybrid_score = 0.4 * normalized_keyword_score + 0.6 * embedding_similarity - code_penalty
```

### Expected Outcomes

- Recall improvement: 60-70% → 85-95%
- "No match" rate reduced significantly
- First-try success rate increased
- Monthly cost: < $5

---

## Task Breakdown

### Phase 1: Infrastructure Setup

#### Task 1.1: Add OpenAI Embeddings Client

**Description:** Create a new module for embedding generation using OpenAI's `text-embedding-3-small` model.

**Files to create:**
- `retrieval/embeddings.ts`

**Implementation:**
```typescript
// retrieval/embeddings.ts
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

export async function embedText(text: string): Promise<number[]> {
  // Call OpenAI embeddings API
  // Return 1536-dim vector
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  // Batch embed up to 100 texts at once
}

export function cosineSimilarity(a: number[], b: number[]): number {
  // Compute cosine similarity between two vectors
}
```

**Acceptance Criteria:**
- [ ] `embedText("test query")` returns a 1536-dimension number array
- [ ] `embedBatch()` handles up to 100 texts in a single API call
- [ ] `cosineSimilarity([1,0,0], [1,0,0])` returns `1.0`
- [ ] `cosineSimilarity([1,0,0], [0,1,0])` returns `0.0`
- [ ] API errors throw with descriptive message
- [ ] Missing `OPENAI_API_KEY` throws clear error
- [ ] Function handles empty string input gracefully

**Estimated effort:** 2 hours

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 1.1</strong></summary>

```
Create a new file `retrieval/embeddings.ts` for the CS Helper bot that provides OpenAI embedding functionality.

## Context
This is part of adding hybrid keyword + embedding search to improve retrieval quality. The bot runs on Val Town (Deno runtime).

## Requirements

1. Create these exported functions:

- `embedText(text: string): Promise<number[]>` - Embed a single text, return 1536-dim vector
- `embedBatch(texts: string[]): Promise<number[][]>` - Batch embed up to 100 texts in one API call
- `cosineSimilarity(a: number[], b: number[]): number` - Compute cosine similarity between two vectors

2. Use OpenAI's `text-embedding-3-small` model (1536 dimensions)

3. Read API key from `Deno.env.get("OPENAI_API_KEY")`

4. Handle errors gracefully:
   - Throw descriptive error if API key is missing
   - Throw descriptive error on API failures
   - Handle empty string input (return zero vector or throw)

5. Add constants:
   - `EMBEDDING_MODEL = "text-embedding-3-small"`
   - `EMBEDDING_DIMS = 1536`

## Acceptance Criteria
- [ ] `embedText("test query")` returns a 1536-dimension number array
- [ ] `embedBatch()` handles up to 100 texts in a single API call
- [ ] `cosineSimilarity([1,0,0], [1,0,0])` returns `1.0`
- [ ] `cosineSimilarity([1,0,0], [0,1,0])` returns `0.0`
- [ ] API errors throw with descriptive message
- [ ] Missing `OPENAI_API_KEY` throws clear error
- [ ] Function handles empty string input gracefully
- [ ] Code passes `deno check retrieval/embeddings.ts`
```

</details>

---

#### Task 1.2: Add Environment Variables

**Description:** Add new configuration for embedding support.

**Files to modify:**
- `env.ts`

**New variables:**
```typescript
export const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
export const BLOB_KEY_V2 = Deno.env.get("BLOB_KEY_V2") || "cs_runbook_index_v2";
export const HYBRID_SEARCH_ENABLED = Deno.env.get("HYBRID_SEARCH_ENABLED") !== "0";
export const MAX_EMBED_CHUNKS = Number(Deno.env.get("MAX_EMBED_CHUNKS") || 1000);
export const EMBEDDING_TIMEOUT_MS = Number(Deno.env.get("EMBEDDING_TIMEOUT_MS") || 5000);
```

**Acceptance Criteria:**
- [ ] `OPENAI_API_KEY` is readable from environment
- [ ] `BLOB_KEY_V2` defaults to `"cs_runbook_index_v2"`
- [ ] `HYBRID_SEARCH_ENABLED` defaults to `true` (enabled)
- [ ] `HYBRID_SEARCH_ENABLED=0` disables hybrid search
- [ ] `MAX_EMBED_CHUNKS` defaults to `1000`
- [ ] `EMBEDDING_TIMEOUT_MS` defaults to `5000`
- [ ] `mustEnv()` does NOT require `OPENAI_API_KEY` (graceful degradation)

**Estimated effort:** 30 minutes

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 1.2</strong></summary>

```
Update `env.ts` to add new environment variables for embedding support in the CS Helper bot.

## Context
We're adding hybrid keyword + embedding search. These env vars control the embedding feature.

## Requirements

Add these new exports to `env.ts`:

1. `OPENAI_API_KEY` - OpenAI API key for embeddings (default: "")
2. `BLOB_KEY_V2` - Blob key for v2 index with embeddings (default: "cs_runbook_index_v2")
3. `HYBRID_SEARCH_ENABLED` - Boolean, true unless env var is "0" (default: true)
4. `MAX_EMBED_CHUNKS` - Number, max chunks to embed (default: 1000)
5. `EMBEDDING_TIMEOUT_MS` - Number, timeout for embedding API calls (default: 5000)

## Important
- Do NOT add `OPENAI_API_KEY` to the `mustEnv()` required list - embedding is optional
- Follow the existing patterns in env.ts for parsing numbers and booleans

## Acceptance Criteria
- [ ] `OPENAI_API_KEY` is readable from environment
- [ ] `BLOB_KEY_V2` defaults to `"cs_runbook_index_v2"`
- [ ] `HYBRID_SEARCH_ENABLED` defaults to `true` (enabled)
- [ ] `HYBRID_SEARCH_ENABLED=0` disables hybrid search (returns false)
- [ ] `MAX_EMBED_CHUNKS` defaults to `1000`
- [ ] `EMBEDDING_TIMEOUT_MS` defaults to `5000`
- [ ] `mustEnv()` does NOT require `OPENAI_API_KEY` (graceful degradation)
- [ ] Code passes `deno check env.ts`
```

</details>

---

#### Task 1.3: Add Type Definitions

**Description:** Add TypeScript types for embeddings and v2 index schema.

**Files to modify:**
- `types/index.ts`

**New types:**
```typescript
export type ChunkWithEmbedding = Chunk & {
  embedding: number[]; // 1536 dims for text-embedding-3-small
};

export type IndexPayloadV2 = {
  version: 2;
  builtAtMs: number;
  diag: IndexDiagnostics & {
    embeddingModel: string;
    embeddingDims: number;
    chunksEmbedded: number;
  };
  chunks: ChunkWithEmbedding[];
};

// Discriminated union for index payloads
export type AnyIndexPayload = IndexPayload | IndexPayloadV2;

export function isV2Index(payload: AnyIndexPayload): payload is IndexPayloadV2 {
  return 'version' in payload && payload.version === 2;
}
```

**Acceptance Criteria:**
- [ ] `ChunkWithEmbedding` extends `Chunk` with `embedding: number[]`
- [ ] `IndexPayloadV2` has `version: 2` discriminator
- [ ] `isV2Index()` type guard correctly identifies v2 payloads
- [ ] Types compile without errors (`deno check types/index.ts`)

**Estimated effort:** 30 minutes

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 1.3</strong></summary>

```
Update `types/index.ts` to add TypeScript types for the v2 index schema with embeddings.

## Context
We're adding embedding support. The v2 index schema extends chunks with embedding vectors.

## Requirements

Add these new types:

1. `ChunkWithEmbedding` - Extends `Chunk` with:
   - `embedding: number[]` (1536 dims for text-embedding-3-small)

2. `IndexPayloadV2` - New index format:
   - `version: 2` (literal type for discriminated union)
   - `builtAtMs: number`
   - `diag: any` (extend with `embeddingModel`, `embeddingDims`, `chunksEmbedded`)
   - `chunks: ChunkWithEmbedding[]`

3. `AnyIndexPayload` - Union type: `IndexPayload | IndexPayloadV2`

4. `isV2Index(payload: AnyIndexPayload): payload is IndexPayloadV2` - Type guard function
   - Returns true if payload has `version === 2`

## Acceptance Criteria
- [ ] `ChunkWithEmbedding` extends `Chunk` with `embedding: number[]`
- [ ] `IndexPayloadV2` has `version: 2` discriminator
- [ ] `isV2Index()` type guard correctly identifies v2 payloads
- [ ] Types compile without errors (`deno check types/index.ts`)
```

</details>

---

### Phase 2: Index Schema Migration

#### Task 2.1: Modify Index Builder to Generate Embeddings

**Description:** Update `buildIndex()` to generate embeddings for each chunk during rebuild.

**Files to modify:**
- `storage/indexStore.ts`

**Implementation details:**
1. After chunking, prepare text for embedding: `Title: {pageTitle}\nSection: {sectionTitle}\nContent: {text}`
2. Batch embed chunks (100 at a time with 100ms delay)
3. Store embeddings in chunk objects
4. Write to both v1 (without embeddings) and v2 (with embeddings) blob keys

**Acceptance Criteria:**
- [ ] `/rebuild` generates embeddings for all chunks when `OPENAI_API_KEY` is set
- [ ] `/rebuild` skips embedding generation when `OPENAI_API_KEY` is missing (logs warning)
- [ ] Embedding text includes pageTitle, sectionTitle, and truncated content (max 800 chars)
- [ ] Chunks are processed in batches of 100 with 100ms delay between batches
- [ ] v1 blob (`cs_runbook_index_v1`) is written WITHOUT embeddings (backward compat)
- [ ] v2 blob (`cs_runbook_index_v2`) is written WITH embeddings
- [ ] `/rebuild` latency increases by < 30s for 500 chunks
- [ ] Diagnostics include `embeddingModel`, `embeddingDims`, `chunksEmbedded`
- [ ] Respects `MAX_EMBED_CHUNKS` limit (truncates if exceeded)
- [ ] Handles embedding API failures gracefully (logs error, continues with keyword-only)

**Estimated effort:** 3 hours

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 2.1</strong></summary>

```
Modify `storage/indexStore.ts` to generate embeddings for chunks during the `/rebuild` process.

## Context
We're adding hybrid search. During rebuild, we need to:
1. Generate embeddings for all chunks
2. Write to BOTH v1 (without embeddings) and v2 (with embeddings) blob keys for backward compatibility

## Prerequisites
- Task 1.1 complete: `retrieval/embeddings.ts` exists with `embedBatch()`
- Task 1.2 complete: `env.ts` has `OPENAI_API_KEY`, `BLOB_KEY_V2`, `MAX_EMBED_CHUNKS`
- Task 1.3 complete: `types/index.ts` has `ChunkWithEmbedding`, `IndexPayloadV2`

## Requirements

1. Import from `retrieval/embeddings.ts` and `env.ts`

2. After chunking in `buildIndex()`, if `OPENAI_API_KEY` is set:
   - Prepare embedding text for each chunk: `Title: {pageTitle}\nSection: {sectionTitle}\nContent: {text.slice(0, 800)}`
   - Batch embed chunks (100 at a time with 100ms delay between batches)
   - Respect `MAX_EMBED_CHUNKS` limit
   - Store embeddings in chunk objects

3. Write to BOTH blob keys:
   - v1 (`BLOB_KEY`): chunks WITHOUT embeddings (strip `embedding` field)
   - v2 (`BLOB_KEY_V2`): chunks WITH embeddings

4. Update diagnostics to include:
   - `embeddingModel: "text-embedding-3-small"` (or null if not used)
   - `embeddingDims: 1536` (or null)
   - `chunksEmbedded: number` (count of chunks with embeddings)

5. Handle failures gracefully:
   - If `OPENAI_API_KEY` missing: log warning, continue without embeddings, only write v1
   - If embedding API fails: log error, continue without embeddings, only write v1

## Acceptance Criteria
- [ ] `/rebuild` generates embeddings for all chunks when `OPENAI_API_KEY` is set
- [ ] `/rebuild` skips embedding generation when `OPENAI_API_KEY` is missing (logs warning)
- [ ] Embedding text includes pageTitle, sectionTitle, and truncated content (max 800 chars)
- [ ] Chunks are processed in batches of 100 with 100ms delay between batches
- [ ] v1 blob (`cs_runbook_index_v1`) is written WITHOUT embeddings (backward compat)
- [ ] v2 blob (`cs_runbook_index_v2`) is written WITH embeddings
- [ ] `/rebuild` latency increases by < 30s for 500 chunks
- [ ] Diagnostics include `embeddingModel`, `embeddingDims`, `chunksEmbedded`
- [ ] Respects `MAX_EMBED_CHUNKS` limit (truncates if exceeded)
- [ ] Handles embedding API failures gracefully (logs error, continues with keyword-only)
- [ ] Code passes `deno check storage/indexStore.ts`
```

</details>

---

#### Task 2.2: Update Index Loader for V2 Schema

**Description:** Update `buildIndex()` to prefer v2 index when available, fall back to v1.

**Files to modify:**
- `storage/indexStore.ts`

**Implementation details:**
```typescript
export async function blobGetIndex(): Promise<AnyIndexPayload | null> {
  // Try v2 first
  const v2 = await blob.getJSON(BLOB_KEY_V2) as IndexPayloadV2 | null;
  if (v2 && isV2Index(v2)) return v2;

  // Fall back to v1
  const v1 = await blob.getJSON(BLOB_KEY) as IndexPayload | null;
  return v1;
}
```

**Acceptance Criteria:**
- [ ] `blobGetIndex()` returns v2 index when both v1 and v2 exist
- [ ] `blobGetIndex()` returns v1 index when only v1 exists
- [ ] `blobGetIndex()` returns null when neither exists
- [ ] `buildIndex()` correctly identifies source as "blob-v2" or "blob-v1" in return value
- [ ] Memory cache correctly stores and returns v2 index with embeddings

**Estimated effort:** 1 hour

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 2.2</strong></summary>

```
Update `storage/indexStore.ts` to prefer v2 index when loading, with fallback to v1.

## Context
We now have two blob keys:
- v1 (`cs_runbook_index_v1`): chunks without embeddings
- v2 (`cs_runbook_index_v2`): chunks with embeddings

The loader should prefer v2 when available.

## Prerequisites
- Task 1.3 complete: `types/index.ts` has `AnyIndexPayload`, `isV2Index()`
- Task 1.2 complete: `env.ts` has `BLOB_KEY_V2`

## Requirements

1. Modify `blobGetIndex()` to:
   - Try v2 blob first (`BLOB_KEY_V2`)
   - If v2 exists and is valid (passes `isV2Index()`), return it
   - Otherwise, fall back to v1 blob (`BLOB_KEY`)
   - Return null if neither exists

2. Update `buildIndex()` return value to indicate source:
   - Add `indexVersion: 1 | 2` to return type
   - Set based on which blob was loaded (or "notion" for fresh crawl)

3. Ensure memory cache (`CACHE`) correctly stores and returns v2 index with embeddings intact

## Acceptance Criteria
- [ ] `blobGetIndex()` returns v2 index when both v1 and v2 exist
- [ ] `blobGetIndex()` returns v1 index when only v1 exists
- [ ] `blobGetIndex()` returns null when neither exists
- [ ] `buildIndex()` correctly identifies source as "blob-v2" or "blob-v1" in return value
- [ ] Memory cache correctly stores and returns v2 index with embeddings
- [ ] Code passes `deno check storage/indexStore.ts`
```

</details>

---

### Phase 3: Hybrid Ranker Implementation

#### Task 3.1: Implement Hybrid Scoring Function

**Description:** Create a hybrid scoring function that combines keyword and embedding scores.

**Files to modify:**
- `retrieval/rank.ts`

**Implementation:**
```typescript
const KEYWORD_WEIGHT = 0.4;
const EMBEDDING_WEIGHT = 0.6;
const HYBRID_THRESHOLD = 0.15;

export function keywordScoreNormalized(queryRaw: string, chunk: Chunk): number {
  const raw = score(queryRaw, chunk); // existing function
  return Math.min(raw / 10, 1); // normalize to 0-1, cap at 10
}

export function hybridScore(
  queryEmbedding: number[],
  queryRaw: string,
  chunk: ChunkWithEmbedding
): number {
  const kwNorm = keywordScoreNormalized(queryRaw, chunk);
  const embScore = cosineSimilarity(queryEmbedding, chunk.embedding);

  let hybrid = KEYWORD_WEIGHT * kwNorm + EMBEDDING_WEIGHT * embScore;

  // Code penalty (preserved from existing logic)
  if (chunk.codeSignals >= 6) hybrid -= 0.1;
  if (chunk.codeSignals >= 12) hybrid -= 0.2;

  return hybrid;
}
```

**Acceptance Criteria:**
- [ ] `keywordScoreNormalized()` returns value in range [0, 1]
- [ ] `hybridScore()` returns value in range [-0.2, 1] (accounting for penalties)
- [ ] Keyword weight is 0.4, embedding weight is 0.6
- [ ] Code penalty of -0.1 applied when codeSignals >= 6
- [ ] Code penalty of -0.2 applied when codeSignals >= 12
- [ ] Identical query and chunk text produces high score (> 0.8)
- [ ] Semantically similar query and chunk produce medium-high score (> 0.5)
- [ ] Unrelated query and chunk produce low score (< 0.3)

**Estimated effort:** 2 hours

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 3.1</strong></summary>

```
Add hybrid scoring functions to `retrieval/rank.ts` that combine keyword and embedding scores.

## Context
We're implementing hybrid search that combines:
- Existing keyword matching (40% weight)
- New embedding similarity (60% weight)

## Prerequisites
- Task 1.1 complete: `retrieval/embeddings.ts` has `cosineSimilarity()`
- Task 1.3 complete: `types/index.ts` has `ChunkWithEmbedding`

## Requirements

1. Add constants at top of file:
   - `KEYWORD_WEIGHT = 0.4`
   - `EMBEDDING_WEIGHT = 0.6`
   - `HYBRID_THRESHOLD = 0.15`

2. Add `keywordScoreNormalized(queryRaw: string, chunk: Chunk): number`
   - Call existing `score()` function
   - Normalize result to 0-1 range: `Math.min(rawScore / 10, 1)`

3. Add `hybridScore(queryEmbedding: number[], queryRaw: string, chunk: ChunkWithEmbedding): number`
   - Compute normalized keyword score
   - Compute embedding similarity using `cosineSimilarity()`
   - Combine: `KEYWORD_WEIGHT * kwNorm + EMBEDDING_WEIGHT * embScore`
   - Apply code penalties (preserve existing logic):
     - If `codeSignals >= 6`: subtract 0.1
     - If `codeSignals >= 12`: subtract 0.2 (not cumulative)
   - Return final hybrid score

## Acceptance Criteria
- [ ] `keywordScoreNormalized()` returns value in range [0, 1]
- [ ] `hybridScore()` returns value in range [-0.2, 1] (accounting for penalties)
- [ ] Keyword weight is 0.4, embedding weight is 0.6
- [ ] Code penalty of -0.1 applied when codeSignals >= 6
- [ ] Code penalty of -0.2 applied when codeSignals >= 12
- [ ] Identical query and chunk text produces high score (> 0.8)
- [ ] Semantically similar query and chunk produce medium-high score (> 0.5)
- [ ] Unrelated query and chunk produce low score (< 0.3)
- [ ] Code passes `deno check retrieval/rank.ts`
```

</details>

---

#### Task 3.2: Implement Query Embedding Cache

**Description:** Cache query embeddings to reduce API calls and latency.

**Files to modify:**
- `retrieval/embeddings.ts`

**Implementation:**
```typescript
const QUERY_EMBED_CACHE = new Map<string, { vec: number[]; ts: number }>();
const QUERY_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const QUERY_CACHE_MAX_SIZE = 100;

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
    const oldest = [...QUERY_EMBED_CACHE.entries()]
      .sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) QUERY_EMBED_CACHE.delete(oldest[0]);
  }

  // Store in cache
  QUERY_EMBED_CACHE.set(key, { vec, ts: Date.now() });
  return vec;
}

export function clearQueryCache(): void {
  QUERY_EMBED_CACHE.clear();
}
```

**Acceptance Criteria:**
- [ ] First call to `embedQueryCached("test")` makes API call
- [ ] Second call within 15 min returns cached result (no API call)
- [ ] Call after 15 min makes new API call
- [ ] Cache stores max 100 entries
- [ ] Oldest entry is evicted when cache is full
- [ ] Cache keys are case-insensitive and trimmed
- [ ] `clearQueryCache()` empties the cache

**Estimated effort:** 1 hour

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 3.2</strong></summary>

```
Add query embedding caching to `retrieval/embeddings.ts` to reduce API calls and latency.

## Context
Query embeddings are called on every search. Caching repeated queries reduces:
- API costs
- Latency (cache hit is instant vs ~200ms API call)

## Prerequisites
- Task 1.1 complete: `embedText()` function exists

## Requirements

1. Add module-level cache:
   - `QUERY_EMBED_CACHE = new Map<string, { vec: number[]; ts: number }>()`
   - `QUERY_CACHE_TTL_MS = 15 * 60 * 1000` (15 minutes)
   - `QUERY_CACHE_MAX_SIZE = 100`

2. Add `embedQueryCached(query: string): Promise<number[]>`
   - Normalize cache key: `query.toLowerCase().trim()`
   - Check cache: if entry exists and not expired (< TTL), return cached vec
   - If miss: call `embedText()`, store result with timestamp
   - Before storing: if cache size >= MAX_SIZE, evict oldest entry
   - Return the vector

3. Add `clearQueryCache(): void`
   - Clear the entire cache map
   - Useful for testing

## Acceptance Criteria
- [ ] First call to `embedQueryCached("test")` makes API call
- [ ] Second call within 15 min returns cached result (no API call)
- [ ] Call after 15 min makes new API call
- [ ] Cache stores max 100 entries
- [ ] Oldest entry is evicted when cache is full
- [ ] Cache keys are case-insensitive and trimmed
- [ ] `clearQueryCache()` empties the cache
- [ ] Code passes `deno check retrieval/embeddings.ts`
```

</details>

---

#### Task 3.3: Implement Hybrid Rank Function

**Description:** Create the main hybrid ranking function that orchestrates scoring and deduplication.

**Files to modify:**
- `retrieval/rank.ts`

**Implementation:**
```typescript
export async function rankHybrid(
  queryRaw: string,
  chunks: ChunkWithEmbedding[],
  k = 6
): Promise<Ranked[]> {
  // Check if hybrid search is enabled and chunks have embeddings
  if (!HYBRID_SEARCH_ENABLED || !chunks[0]?.embedding) {
    return rank(queryRaw, chunks as Chunk[], k); // fallback to keyword
  }

  // Get query embedding (cached)
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedQueryCached(queryRaw);
  } catch (e) {
    console.warn("Query embedding failed, falling back to keyword:", e);
    return rank(queryRaw, chunks as Chunk[], k);
  }

  // Score all chunks
  const scored = chunks
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

  return out;
}
```

**Acceptance Criteria:**
- [ ] Returns up to k results (default 6)
- [ ] Results are sorted by hybrid score descending
- [ ] Results are deduplicated by pageTitle
- [ ] Falls back to `rank()` when `HYBRID_SEARCH_ENABLED=0`
- [ ] Falls back to `rank()` when chunks don't have embeddings
- [ ] Falls back to `rank()` when query embedding fails
- [ ] Filters out results with score <= 0.15 (HYBRID_THRESHOLD)
- [ ] Logs warning on embedding failure

**Estimated effort:** 2 hours

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 3.3</strong></summary>

```
Add the main `rankHybrid()` function to `retrieval/rank.ts` that orchestrates hybrid scoring with fallbacks.

## Context
This is the main entry point for hybrid search. It must:
- Use hybrid scoring when embeddings are available
- Fall back to keyword-only when embeddings unavailable or fail
- Preserve existing behavior (deduplication, filtering, sorting)

## Prerequisites
- Task 1.2 complete: `env.ts` has `HYBRID_SEARCH_ENABLED`
- Task 3.1 complete: `hybridScore()` function exists
- Task 3.2 complete: `embedQueryCached()` function exists

## Requirements

1. Add `rankHybrid(queryRaw: string, chunks: ChunkWithEmbedding[], k = 6): Promise<Ranked[]>`

2. Early fallback to keyword-only `rank()` if:
   - `HYBRID_SEARCH_ENABLED` is false
   - First chunk doesn't have `embedding` field

3. Get query embedding:
   - Call `embedQueryCached(queryRaw)`
   - If it throws, log warning and fall back to keyword-only `rank()`

4. Score all chunks using `hybridScore()`

5. Filter: keep only chunks with `score > HYBRID_THRESHOLD` (0.15)

6. Sort by score descending

7. Deduplicate by `pageTitle` (same logic as existing `rank()`)

8. Return top k results

## Acceptance Criteria
- [ ] Returns up to k results (default 6)
- [ ] Results are sorted by hybrid score descending
- [ ] Results are deduplicated by pageTitle
- [ ] Falls back to `rank()` when `HYBRID_SEARCH_ENABLED=0`
- [ ] Falls back to `rank()` when chunks don't have embeddings
- [ ] Falls back to `rank()` when query embedding fails
- [ ] Filters out results with score <= 0.15 (HYBRID_THRESHOLD)
- [ ] Logs warning on embedding failure
- [ ] Code passes `deno check retrieval/rank.ts`
```

</details>

---

### Phase 4: Integration

#### Task 4.1: Update handleQuestion to Use Hybrid Ranker

**Description:** Modify the main question handler to use hybrid ranking when available.

**Files to modify:**
- `main.ts`

**Changes:**
1. Import `rankHybrid` from `retrieval/rank.ts`
2. Replace `rank()` calls with `rankHybrid()` (async)
3. Add try/catch with fallback to keyword-only

**Acceptance Criteria:**
- [ ] `/search?q=stuck+analysis` uses hybrid ranking when v2 index available
- [ ] `/search?q=stuck+analysis` falls back to keyword when v2 unavailable
- [ ] `/slack/command` uses hybrid ranking when v2 index available
- [ ] Follow-up handler uses hybrid ranking when v2 index available
- [ ] Error in hybrid ranking doesn't break the request (fallback works)
- [ ] Response time stays under 3s for Slack (P95)

**Estimated effort:** 1 hour

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 4.1</strong></summary>

```
Update `main.ts` to use the new `rankHybrid()` function for all search operations.

## Context
We need to replace `rank()` calls with `rankHybrid()` in all places where runbook search happens:
- `/search` endpoint
- `/slack/command` handler (via `handleQuestion`)
- Follow-up handler

## Prerequisites
- Task 3.3 complete: `rankHybrid()` function exists in `retrieval/rank.ts`

## Requirements

1. Import `rankHybrid` from `retrieval/rank.ts`

2. In `handleQuestion()` function (~line 1322):
   - Replace `rank(question, chunks, 5)` with `await rankHybrid(question, chunks, 5)`
   - Note: `rankHybrid` is async, so ensure the call is awaited

3. In `handleFollowupInThread()` function (~line 1541):
   - Replace `rank(combinedQuery, chunks, 5)` with `await rankHybrid(combinedQuery, chunks, 5)`

4. Wrap in try/catch if not already:
   - On error, fall back to keyword-only `rank()` and log warning
   - This ensures the request never fails due to embedding issues

5. The existing `rank()` function should remain exported for fallback use

## Acceptance Criteria
- [ ] `/search?q=stuck+analysis` uses hybrid ranking when v2 index available
- [ ] `/search?q=stuck+analysis` falls back to keyword when v2 unavailable
- [ ] `/slack/command` uses hybrid ranking when v2 index available
- [ ] Follow-up handler uses hybrid ranking when v2 index available
- [ ] Error in hybrid ranking doesn't break the request (fallback works)
- [ ] Response time stays under 3s for Slack (P95)
- [ ] Code passes `deno check main.ts`
```

</details>

---

#### Task 4.2: Update Health Endpoint

**Description:** Add embedding status to health endpoint.

**Files to modify:**
- `main.ts`

**New fields in /health response:**
```json
{
  "embedding_enabled": true,
  "embedding_model": "text-embedding-3-small",
  "index_version": 2,
  "chunks_with_embeddings": 450
}
```

**Acceptance Criteria:**
- [ ] `/health` includes `embedding_enabled: true/false`
- [ ] `/health` includes `index_version: 1 or 2`
- [ ] `/health` includes `embedding_model` when v2 index present
- [ ] `/health` includes `chunks_with_embeddings` count

**Estimated effort:** 30 minutes

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 4.2</strong></summary>

```
Update the `/health` endpoint in `main.ts` to include embedding status information.

## Context
Operators need to know:
- Whether embedding search is enabled and working
- Which index version is loaded (v1 or v2)
- How many chunks have embeddings

## Prerequisites
- Task 1.3 complete: `isV2Index()` type guard exists
- Task 2.2 complete: Index loader returns version info

## Requirements

1. In `handleHealth()` function (~line 1846):

2. Add new fields to the JSON response:
   - `embedding_enabled: boolean` - true if `HYBRID_SEARCH_ENABLED` is true AND v2 index is loaded
   - `index_version: 1 | 2 | null` - which index version is currently loaded
   - `embedding_model: string | null` - e.g., "text-embedding-3-small" (from v2 diag) or null
   - `chunks_with_embeddings: number` - count of chunks that have `embedding` field, or 0

3. To determine these values:
   - Check if loaded index passes `isV2Index()`
   - Read `diag.embeddingModel` and `diag.chunksEmbedded` from v2 index
   - Import `HYBRID_SEARCH_ENABLED` from `env.ts`

## Acceptance Criteria
- [ ] `/health` includes `embedding_enabled: true/false`
- [ ] `/health` includes `index_version: 1 or 2` (or null if no index)
- [ ] `/health` includes `embedding_model` when v2 index present
- [ ] `/health` includes `chunks_with_embeddings` count
- [ ] Code passes `deno check main.ts`
```

</details>

---

### Phase 5: Observability & Testing

#### Task 5.1: Add Logging for Retrieval Quality

**Description:** Add structured logging to measure retrieval quality before/after.

**Files to modify:**
- `main.ts`
- `retrieval/rank.ts`

**Log format:**
```typescript
console.log(JSON.stringify({
  event: "search",
  query: queryRaw.slice(0, 100),
  topScore: hits[0]?.score || 0,
  topHitPage: hits[0]?.chunk.pageTitle || null,
  hitCount: hits.length,
  ragUsed: ragUsed,
  indexVersion: indexVersion,
  embeddingUsed: embeddingUsed,
  latencyMs: Date.now() - startTime,
}));
```

**Acceptance Criteria:**
- [ ] Every `/search` and `/slack/command` logs retrieval metrics
- [ ] Logs include query (truncated), top score, top hit page
- [ ] Logs include whether embedding was used
- [ ] Logs include index version (1 or 2)
- [ ] Logs include latency in ms
- [ ] Logs are JSON formatted for easy parsing

**Estimated effort:** 1 hour

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 5.1</strong></summary>

```
Add structured logging to `main.ts` to measure retrieval quality before and after hybrid search rollout.

## Context
We need to measure:
- How often hybrid search is used vs keyword fallback
- Top hit scores (to track quality improvement)
- Latency impact
- "No match" rate

## Requirements

1. Create a helper function `logSearchMetrics(params: {...}): void`

2. Log JSON to console in this format:
   {
     "event": "search",
     "query": string (truncated to 100 chars),
     "topScore": number | null,
     "topHitPage": string | null,
     "hitCount": number,
     "ragUsed": boolean,
     "indexVersion": 1 | 2 | null,
     "embeddingUsed": boolean,
     "latencyMs": number,
     "source": "web" | "slack_command" | "slack_followup"
   }

3. Call `logSearchMetrics()` at the end of:
   - `/search` endpoint handler
   - `handleQuestion()` (for Slack commands)
   - `handleFollowupInThread()` (for follow-ups)

4. To track latency:
   - Record `startTime = Date.now()` at start of handler
   - Compute `latencyMs = Date.now() - startTime` before logging

5. To determine `embeddingUsed`:
   - True if v2 index was used AND `HYBRID_SEARCH_ENABLED` is true
   - Can pass this from `rankHybrid()` or infer from index version

## Acceptance Criteria
- [ ] Every `/search` request logs retrieval metrics
- [ ] Every `/slack/command` request logs retrieval metrics
- [ ] Every follow-up request logs retrieval metrics
- [ ] Logs include query (truncated), top score, top hit page
- [ ] Logs include whether embedding was used
- [ ] Logs include index version (1 or 2)
- [ ] Logs include latency in ms
- [ ] Logs are JSON formatted (one line per event)
- [ ] Code passes `deno check main.ts`
```

</details>

---

#### Task 5.2: Add Manual Test Cases

**Description:** Create a test file with semantic matching test cases.

**Files to create:**
- `tests/hybrid_search_test_cases.json`

**Test cases:**
```json
[
  {
    "query": "stuck analysis",
    "expectedMatches": ["Pending", "Analysis"],
    "minScore": 0.5,
    "description": "Semantic match: stuck -> pending"
  },
  {
    "query": "survey won't complete",
    "expectedMatches": ["Finalize"],
    "minScore": 0.4,
    "description": "Semantic match: complete -> finalize"
  },
  {
    "query": "pending state",
    "expectedMatches": ["Pending"],
    "minScore": 0.7,
    "description": "Direct keyword match should score higher"
  }
]
```

**Acceptance Criteria:**
- [ ] Test file contains at least 10 semantic matching test cases
- [ ] Test file contains at least 5 keyword matching test cases
- [ ] Each test case has query, expected matches, min score, description
- [ ] `/search` endpoint can be used to manually verify test cases
- [ ] Document how to run manual tests in README or this file

**Estimated effort:** 1 hour

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 5.2</strong></summary>

```
Create a test cases file `tests/hybrid_search_test_cases.json` for validating semantic search quality.

## Context
We need test cases to verify:
- Semantic matching works (e.g., "stuck" matches "pending")
- Keyword matching still works (no regression)
- Score thresholds are appropriate

## Requirements

1. Create directory `tests/` if it doesn't exist

2. Create `tests/hybrid_search_test_cases.json` with this structure:
   [
     {
       "query": "search query",
       "expectedMatches": ["word1", "word2"],  // at least one must appear in top result title
       "minScore": 0.5,
       "description": "What this tests"
     }
   ]

3. Include at least 10 SEMANTIC matching test cases (query differs from expected):
   - "stuck analysis" -> should match "Pending"
   - "survey won't complete" -> should match "Finalize"
   - "tracker broken" -> should match "Reporting" or "Monthly"
   - "export not working" -> should match "Export" or "CSV"
   - "can't see results" -> should match "Results" or "Analysis"
   - Add 5 more based on common CS queries

4. Include at least 5 KEYWORD matching test cases (direct matches):
   - "pending state" -> should match "Pending" with high score (> 0.7)
   - "finalize blocked" -> should match "Finalize" with high score
   - Add 3 more

5. Include 2-3 NEGATIVE test cases:
   - Queries that should NOT match well (score < 0.3)
   - e.g., "weather forecast" should not match any runbook

6. Add a README section at top of file (as a comment or separate .md file) explaining how to run tests manually using the `/search` endpoint

## Acceptance Criteria
- [ ] Test file contains at least 10 semantic matching test cases
- [ ] Test file contains at least 5 keyword matching test cases
- [ ] Test file contains at least 2 negative test cases
- [ ] Each test case has query, expectedMatches, minScore, description
- [ ] File is valid JSON
- [ ] Document how to run manual tests (either in file or separate README)
```

</details>

---

### Phase 6: Rollout

#### Task 6.1: Staged Rollout Plan

**Description:** Document and execute the staged rollout.

**Week 1: Shadow Mode**
- Deploy with `HYBRID_SEARCH_ENABLED=0`
- Run `/rebuild` to generate v2 index
- Verify v2 index is created correctly
- Compare v1 vs v2 search results offline

**Week 2: Web Only**
- Set `HYBRID_SEARCH_ENABLED=1`
- Monitor `/search` endpoint only
- Check latency and result quality
- Rollback if issues

**Week 3: Slack Enabled**
- Slack commands use hybrid search
- Monitor for latency issues (< 3s P95)
- Check user feedback

**Week 4: Full Rollout**
- Remove v1 writes (keep v1 reads for rollback)
- Document final configuration
- Update CLAUDE.md

**Acceptance Criteria:**
- [ ] Week 1: v2 index generated, no production impact
- [ ] Week 2: Web search uses hybrid, latency acceptable
- [ ] Week 3: Slack uses hybrid, P95 latency < 3s
- [ ] Week 4: v1 writes removed, system stable

**Estimated effort:** Monitoring time, minimal code changes

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 6.1</strong></summary>

```
This is a PROCESS task, not a code task. Execute the staged rollout plan for hybrid search.

## Week 1: Shadow Mode

### Actions:
1. Deploy all code changes with `HYBRID_SEARCH_ENABLED=0` (disabled)
2. Set `OPENAI_API_KEY` in Val Town secrets
3. Run `/rebuild` endpoint to generate v2 index with embeddings
4. Verify v2 index created: check `/health` endpoint for `index_version: 2`
5. Manually test `/search?q=stuck+analysis` with both settings:
   - With `HYBRID_SEARCH_ENABLED=0`: verify keyword-only results
   - Temporarily set `HYBRID_SEARCH_ENABLED=1`: verify hybrid results
6. Compare results, document any issues
7. Reset to `HYBRID_SEARCH_ENABLED=0`

### Verification:
- [ ] v2 index generated successfully
- [ ] `/health` shows embedding metadata
- [ ] No production impact (keyword search still works)
- [ ] Hybrid results look reasonable in manual testing

---

## Week 2: Web Only

### Actions:
1. Set `HYBRID_SEARCH_ENABLED=1` in Val Town secrets
2. Monitor `/search` endpoint for 3-5 days
3. Check logs for:
   - Latency (should be < 500ms P95)
   - Error rates (should be ~0%)
   - "embeddingUsed": true in logs
4. Sample 10-20 queries, verify result quality
5. If issues: set `HYBRID_SEARCH_ENABLED=0` immediately

### Verification:
- [ ] Web search latency acceptable (< 500ms P95)
- [ ] No errors in logs
- [ ] Result quality improved (manual check)
- [ ] Rollback tested and working

---

## Week 3: Slack Enabled

### Actions:
1. Slack commands now use hybrid search (same flag)
2. Monitor for 1 week:
   - Slack response time (must be < 3s P95)
   - User feedback (any complaints?)
   - Error rates
3. Check thread follow-ups still work
4. If issues: rollback to `HYBRID_SEARCH_ENABLED=0`

### Verification:
- [ ] Slack P95 latency < 3s
- [ ] Follow-ups work correctly
- [ ] No user complaints
- [ ] Embedding cache working (check for cache hits in logs)

---

## Week 4: Full Rollout

### Actions:
1. Remove v1 writes from `buildIndex()` (optional, can keep for safety)
2. Update CLAUDE.md with new env vars
3. Document final configuration
4. Close rollout tracking

### Verification:
- [ ] System stable for 1+ week
- [ ] Documentation updated
- [ ] Team trained on rollback procedure
```

</details>

---

#### Task 6.2: Rollback Plan

**Description:** Document rollback procedure.

**Immediate rollback (< 1 minute):**
1. Set `HYBRID_SEARCH_ENABLED=0` in Val Town secrets
2. System immediately falls back to keyword-only

**Full rollback (< 5 minutes):**
1. Set `HYBRID_SEARCH_ENABLED=0`
2. Delete v2 blob: `await blob.delete("cs_runbook_index_v2")`
3. System uses v1 index exclusively

**Acceptance Criteria:**
- [ ] Rollback procedure documented
- [ ] `HYBRID_SEARCH_ENABLED=0` tested and confirmed working
- [ ] v1 index continues to be written during rollout period
- [ ] Team knows rollback procedure

**Estimated effort:** 30 minutes documentation

<details>
<summary><strong>📋 Copy-Paste Prompt for Task 6.2</strong></summary>

```
Document the rollback procedure for hybrid search in the CS Helper bot.

## Context
We need clear, tested rollback procedures so any team member can quickly disable hybrid search if issues arise.

## Requirements

1. Create or update `docs/ROLLBACK.md` with:

### Immediate Rollback (< 1 minute)
**When to use:** Slack responses slow, errors spiking, wrong results

**Steps:**
1. Go to Val Town secrets dashboard
2. Set `HYBRID_SEARCH_ENABLED=0`
3. Verify: Next search should show `"embeddingUsed": false` in logs
4. Notify team in Slack

**What happens:**
- System immediately falls back to keyword-only search
- No restart needed
- v2 index stays in place (unused)
- Can re-enable by setting `HYBRID_SEARCH_ENABLED=1`

---

### Full Rollback (< 5 minutes)
**When to use:** v2 index corrupted, need to remove all embedding code

**Steps:**
1. Set `HYBRID_SEARCH_ENABLED=0`
2. Delete v2 blob:
   - Go to Val Town blob storage
   - Delete key: `cs_runbook_index_v2`
   - OR run: `await blob.delete("cs_runbook_index_v2")`
3. Verify: `/health` should show `index_version: 1`
4. Notify team

**What happens:**
- System uses v1 index exclusively
- Next `/rebuild` will only create v1 (if code reverted)

---

### Code Rollback (if needed)
**When to use:** Bug in hybrid code that can't be fixed quickly

**Steps:**
1. Revert to previous commit before hybrid changes
2. Push to Val Town
3. Run `/rebuild` to regenerate v1 index
4. Verify system working

---

2. Test the rollback procedure:
   - In staging/test environment
   - Verify `HYBRID_SEARCH_ENABLED=0` works
   - Verify deleting v2 blob works
   - Document any gotchas

3. Share rollback doc with team

## Acceptance Criteria
- [ ] Rollback procedure documented in `docs/ROLLBACK.md`
- [ ] Immediate rollback tested and confirmed working
- [ ] Full rollback tested and confirmed working
- [ ] Team knows where to find rollback docs
- [ ] Contact/escalation info included (who to notify)
```

</details>

---

## Cost Estimates

### Embedding Costs (OpenAI text-embedding-3-small)

| Operation | Tokens | Cost per 1M tokens | Estimated Cost |
|-----------|--------|-------------------|----------------|
| Rebuild (500 chunks × 200 tokens) | 100K | $0.02 | $0.002 |
| Daily queries (100 × 50 tokens) | 5K | $0.02 | $0.0001 |
| Monthly total | ~250K | $0.02 | **< $0.01** |

**Conservative estimate:** < $5/month with heavy usage

### Latency Estimates

| Operation | Current | With Embeddings |
|-----------|---------|-----------------|
| `/rebuild` | ~10s | ~30-40s |
| `/search` (cold) | ~200ms | ~400ms |
| `/search` (warm, cached query) | ~50ms | ~100ms |
| Slack response | ~1.5s | ~2s |

---

## Dependencies

### External Services
- OpenAI API (embeddings)

### New Environment Variables
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | No | "" | OpenAI API key for embeddings |
| `BLOB_KEY_V2` | No | "cs_runbook_index_v2" | Blob key for v2 index |
| `HYBRID_SEARCH_ENABLED` | No | "1" | Enable/disable hybrid search |
| `MAX_EMBED_CHUNKS` | No | "1000" | Max chunks to embed |
| `EMBEDDING_TIMEOUT_MS` | No | "5000" | Timeout for embedding API |

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| OpenAI API latency spikes | Medium | Slack timeout | Query cache + 5s timeout + keyword fallback |
| OpenAI API unavailable | Low | No embedding | Feature flag + graceful degradation |
| Embedding quality poor | Low | Wrong results | Hybrid weighting tunable; 40/60 keyword/embedding |
| Blob size increase | Certain | Slower loads | ~3MB acceptable for Val Town |
| Cost overrun | Low | Budget exceeded | `MAX_EMBED_CHUNKS` cap + monitoring |
| v2 breaking old deploys | Medium | Rollback blocked | Parallel v1/v2 writes |

---

## Definition of Done

The feature is complete when:

1. **Functional:**
   - [ ] Hybrid search returns semantically relevant results
   - [ ] "stuck analysis" matches "Pending Analysis" runbook
   - [ ] Keyword matches still work (regression-free)

2. **Operational:**
   - [ ] Feature flag allows instant disable
   - [ ] Graceful degradation when OpenAI unavailable
   - [ ] v1 index still works as fallback

3. **Observable:**
   - [ ] `/health` reports embedding status
   - [ ] Logs capture retrieval metrics
   - [ ] Cost is trackable

4. **Documented:**
   - [ ] CLAUDE.md updated with new env vars
   - [ ] Rollback procedure documented
   - [ ] Test cases documented

---

## Timeline

| Week | Phase | Tasks |
|------|-------|-------|
| 1 | Infrastructure | 1.1, 1.2, 1.3, 2.1, 2.2 |
| 1-2 | Ranker | 3.1, 3.2, 3.3 |
| 2 | Integration | 4.1, 4.2, 5.1, 5.2 |
| 2-4 | Rollout | 6.1, 6.2 |

**Total estimated effort:** 15-20 hours of implementation + monitoring time

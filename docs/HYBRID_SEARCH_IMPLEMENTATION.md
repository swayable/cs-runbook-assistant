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

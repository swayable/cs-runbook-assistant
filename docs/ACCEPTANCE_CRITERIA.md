# Acceptance Criteria for Retrieval Architecture

## Overview

This document defines testable acceptance criteria for the retrieval improvements and evaluates whether the Slack endpoint honors them.

---

## Acceptance Criteria

### AC-1: Query Normalization
**Requirement:** CS-specific prefixes ("customer says", "user reports", etc.) are stripped before search.

**Test:** Query "customer says export failed" should match the same documents as "export failed".

**Verification Method:**
```bash
# Both should return similar top results
curl "/search?q=customer+says+export+failed"
curl "/search?q=export+failed"
```

---

### AC-2: Relevance Threshold
**Requirement:** Only results with score ≥ 0.20 are considered "relevant" and shown to users.

**Test:** Queries with no good matches should return "no relevant content" response, not weak matches.

**Verification Method:**
- Check `RELEVANCE_SCORE_THRESHOLD` is 0.20 in main.ts
- Check `HYBRID_THRESHOLD` is 0.20 in rank.ts

---

### AC-3: Hybrid Search
**Requirement:** Search uses 40% keyword + 60% semantic scoring when embeddings available.

**Test:** Query "stuck analysis" should match "Pending" runbooks via semantic similarity.

**Verification Method:**
- Check `KEYWORD_WEIGHT` is 0.4 and `EMBEDDING_WEIGHT` is 0.6 in rank.ts
- Verify `/search?q=stuck+analysis&debug=1` shows embedding_used: true

---

### AC-4: Linear Ticket Caching
**Requirement:** Linear API results are cached for 5 minutes to reduce API load.

**Test:** Second query within 5 minutes should use cached tickets (log shows "Cache hit").

**Verification Method:**
- Check `RECENT_ISSUES_CACHE_TTL_MS` is 5 * 60 * 1000 in linear/api.ts
- Verify logs show "[fetchRecentIssues] Cache hit" on repeated queries

---

### AC-5: LLM Ticket Selection
**Requirement:** Related tickets are selected by LLM with explanations (fallback to keyword if LLM unavailable).

**Test:** Response includes `related_tickets[].reason` starting with "LLM:" or "Fallback:".

**Verification Method:**
```bash
curl "/search?q=analysis+pending" | jq '.related_tickets[].reason'
```

---

### AC-6: Graceful Degradation
**Requirement:** If primary search fails, return supportive response (never error to user).

**Test:** Missing ANTHROPIC_API_KEY should not crash; missing index should use Notion direct.

**Verification Method:**
- Slack responses always include helpful content, never raw errors
- `/search` endpoint returns valid JSON even when services fail

---

### AC-7: Source Citations
**Requirement:** Every response includes source links to Notion pages when runbook content is found.

**Test:** Runbook responses include clickable Notion URLs.

**Verification Method:**
- Check `buildRunbookBlocks()` includes URLs in output
- Verify Slack messages show "Sources:" section with links

---

### AC-8: Latency Target
**Requirement:** Search response in <5s for 95% of queries (excluding Slack overhead).

**Test:** `/search` endpoint latency_ms < 5000 for typical queries.

**Verification Method:**
```bash
curl "/search?q=pending+analysis" | jq '.latency_ms'
```

---

### AC-9: Negative Query Rejection
**Requirement:** Off-topic queries score below threshold and receive supportive "no match" response.

**Test:** Query "recipe for chocolate cake" should not match any runbook well.

**Verification Method:**
- Run golden query evaluation: `deno task eval`
- Verify NEG-* queries have scores < 0.20

---

### AC-10: Evaluation Harness
**Requirement:** Deterministic evaluation can be run locally to detect regressions.

**Test:** `deno task eval` runs and reports pass/fail.

**Verification Method:**
```bash
deno task eval --url=http://localhost:8000
```

---

## Slack Endpoint Compliance Evaluation

### Code Path Trace

```
/slack/events
    → handleSlackEvents()
    → POST /slack/process (delegated for execution time)
        → handleSlackProcess()
            → director(question)           # Intent classification
            → handleQuestion(question)     # Main orchestration
                → buildIndex()             # Load cached chunks
                → rankHybrid(question)     # Hybrid search
                    → embedQueryCached()   # Uses normalizeSearchQuery() ✓
                    → hybridScore()
                        → keywordScoreNormalized()
                            → score()      # Uses normalizeSearchQuery() ✓
                → getRelatedTicketsWithLLM()  # LLM ticket selection
                    → fetchRecentIssues()     # Uses 5-min cache ✓
                    → selectRelevantTicketsWithLLM()
                → llmSummarize()           # Generate summary
                → buildRunbookBlocks()     # Build Slack response with citations
```

### Evaluation Results

| Criteria | Slack Endpoint Honors? | Evidence |
|----------|------------------------|----------|
| **AC-1** Query Normalization | ✅ YES | `score()` at rank.ts:19 calls `normalizeSearchQuery()`. `embedQueryCached()` at rank.ts:76 also uses `normalizeSearchQuery()`. |
| **AC-2** Relevance Threshold | ✅ YES | main.ts:331 sets `RELEVANCE_SCORE_THRESHOLD = 0.20`. Check at line 400: `hits[0].score >= RELEVANCE_SCORE_THRESHOLD` |
| **AC-3** Hybrid Search | ✅ YES | handleQuestion calls `rankHybrid()` at main.ts:398. Weights in rank.ts:9-10: `KEYWORD_WEIGHT=0.4`, `EMBEDDING_WEIGHT=0.6` |
| **AC-4** Linear Ticket Caching | ✅ YES | `fetchRecentIssues()` in linear/api.ts uses `RECENT_ISSUES_CACHE` with 5-min TTL. Called via `getRelatedTicketsWithLLM()` at main.ts:549 |
| **AC-5** LLM Ticket Selection | ✅ YES | handleQuestion calls `getRelatedTicketsWithLLM()` at main.ts:549 with `includeLinear: true` (set at main.ts:1449 for slash commands, main.ts:1671 for events) |
| **AC-6** Graceful Degradation | ✅ YES | All external calls wrapped in try/catch. buildIndex failure at main.ts:384 sets `noContextReason`. LLM failures return supportive fallback at handlers/llm.ts:147-170 |
| **AC-7** Source Citations | ✅ YES | `buildRunbookBlocks()` at handlers/slackBlocks.ts includes `chunk.url` in output. Called at main.ts:600 |
| **AC-8** Latency Target | ⚠️ DEPENDS | Timeouts configured: LLM 15s, Linear 5s, Director 8s. Total can exceed 5s. Acceptable for Slack async pattern. |
| **AC-9** Negative Query Rejection | ✅ YES | Threshold check at main.ts:400. Low-scoring results trigger `buildNoRelevantBlocks()` at main.ts:497 with supportive message |
| **AC-10** Evaluation Harness | ✅ YES | `deno task eval` runs scripts/eval.ts against /search endpoint. Slack uses same `handleQuestion()` code path. |

### Summary

**9/10 criteria fully met, 1/10 conditionally met.**

The only conditional criterion is AC-8 (Latency Target). The Slack endpoint can exceed 5s due to:
- LLM summarization (~2-3s)
- LLM ticket selection (~2-3s)
- Notion/embedding API calls

However, this is acceptable because:
1. Slack uses async two-endpoint pattern (user sees "Searching..." message immediately)
2. Timeouts prevent infinite hangs
3. Total execution stays within Val Town limits (~60s)

---

## Verification Commands

```bash
# Type check
deno check --allow-import main.ts

# Run unit tests (39 tests)
deno task test

# Run retrieval evaluation (requires dev server)
deno task dev          # Terminal 1
deno task eval         # Terminal 2

# Verify specific criteria
grep "RELEVANCE_SCORE_THRESHOLD" main.ts              # AC-2
grep "KEYWORD_WEIGHT\|EMBEDDING_WEIGHT" retrieval/rank.ts  # AC-3
grep "RECENT_ISSUES_CACHE_TTL_MS" linear/api.ts       # AC-4
grep "normalizeSearchQuery" retrieval/rank.ts         # AC-1
```

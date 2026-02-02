# Retrieval Architecture

This document defines the retrieval approach, contracts, and evaluation methodology for CSHelpBot.

## Current State Analysis

### Architecture Overview

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│ Slack Event │────▶│   Director   │────▶│  Help Route    │
└─────────────┘     │ (intent clf) │     └────────────────┘
                    └──────┬───────┘
                           │ answer route
                           ▼
              ┌────────────────────────────┐
              │      Search Orchestrator   │
              │   (handleQuestion in main) │
              └────────────────────────────┘
                    │              │
          ┌─────────┴──────┐      │
          ▼                ▼      ▼
    ┌──────────┐    ┌───────────┐ ┌─────────────┐
    │ Blob V2  │    │  Notion   │ │   Linear    │
    │  Index   │    │  Direct   │ │   7-day     │
    │(hybrid)  │    │  Search   │ │   tickets   │
    └────┬─────┘    └─────┬─────┘ └──────┬──────┘
         │                │              │
         └────────┬───────┘              │
                  ▼                      ▼
         ┌────────────────┐     ┌──────────────┐
         │  rankHybrid()  │     │ LLM ticket   │
         │ keyword+embed  │     │  selection   │
         └───────┬────────┘     └──────┬───────┘
                 │                     │
                 └──────────┬──────────┘
                            ▼
                   ┌─────────────────┐
                   │  llmSummarize() │
                   │  prompt + cite  │
                   └───────┬─────────┘
                           ▼
                   ┌─────────────────┐
                   │  Slack Response │
                   └─────────────────┘
```

### Code Path Inventory

| Component | File(s) | Purpose |
|-----------|---------|---------|
| **Ingestion** | `storage/indexStore.ts` | Crawls Notion pages recursively, builds V1 (keyword) and V2 (embedding) indexes |
| **Notion Direct** | `retrieval/notionSearch.ts` | Real-time Notion Search API (no pre-built index required) |
| **Chunking** | `storage/indexStore.ts:chunkPage()` | Splits by heading, 900 char max, preserves section titles |
| **Embedding** | `retrieval/embeddings.ts` | OpenAI text-embedding-3-small, 1536 dims, batch capable |
| **Ranking** | `retrieval/rank.ts` | Hybrid scoring: 40% keyword + 60% embedding similarity |
| **Linear Fetch** | `linear/api.ts:fetchRecentIssues()` | GraphQL query for last 7 days of tickets |
| **Ticket Selection** | `linear/api.ts:selectRelevantTicketsWithLLM()` | Claude picks relevant tickets with explanations |
| **Summarization** | `handlers/llm.ts:llmSummarize()` | Generates summary + next_actions from top 3 hits |
| **Classification** | `classifier/heuristics.ts` | Deterministic CS vs Engineer routing |

### Caching Strategy (Current)

| Cache | TTL | Purpose |
|-------|-----|---------|
| In-memory index | 60 min | Avoids blob fetch on every request |
| Blob index | 7 days (stale warning) | Persists across cold starts |
| Query embeddings | 15 min | Reduces OpenAI API calls for repeated queries |

### Identified Failure Modes

1. **Cold start latency**: First request triggers Notion API calls (~8s timeout)
2. **Embedding API dependency**: Every unique query needs OpenAI call
3. **Stale index content**: Blob can be up to 7 days old
4. **LLM ticket timeout**: 8s timeout causes keyword fallback
5. **Weak relevance threshold**: 0.15 is low, weak matches slip through
6. **No query understanding**: Vague queries ("it's broken") get literal matching

---

## Retrieval Approach by Corpus

### Corpus 1: Notion Runbooks

**Recommendation: USE HYBRID RAG**

**Justification:**
1. Corpus is stable (runbooks change weekly, not hourly)
2. Size is manageable (~1000 chunks fits in blob storage)
3. Semantic search improves "stuck" → "pending" type matches
4. Users ask in natural language, not exact terms
5. Pre-built index amortizes Notion API costs

**Architecture:**
- **Primary**: Blob-cached V2 index with embeddings (hybrid search)
- **Fallback**: Notion Direct Search API (cold start or blob missing)
- **Chunking**: Keep current heading-based splitting (~900 chars)
- **Embedding**: text-embedding-3-small (cost-effective, sufficient quality)
- **Ranking**: Hybrid (keyword 40%, semantic 60%) - KEEP current weights

**Improvements Needed:**
- Add query expansion for vague queries
- Implement explicit freshness signal in ranking
- Add minimum score threshold enforcement (raise from 0.15 to 0.20)

### Corpus 2: Linear Tickets

**Recommendation: DO NOT USE RAG, USE FILTERED SEARCH**

**Justification:**
1. Tickets are highly time-sensitive (7-day window matters)
2. Embedding the entire ticket corpus is wasteful (changes hourly)
3. Linear GraphQL provides built-in search
4. LLM selection from small candidate set is sufficient
5. Val Town blob limits (1GB Pro) make ticket embeddings impractical at scale

**Architecture:**
- **Fetch**: GraphQL query with 7-day filter (existing approach is correct)
- **Selection**: LLM picks relevant tickets from candidate set (up to 50)
- **Fallback**: Keyword token overlap when LLM unavailable
- **No embedding storage**: Do not embed tickets

**Improvements Needed:**
- Add metadata filters (state type, labels) to reduce candidate set
- Cache recent tickets for 5 minutes to reduce API calls
- Add explicit "no relevant tickets" handling

---

## Retrieval Contract

### What We Guarantee

1. **Latency**: Search response in <5s for 95% of queries (excluding Slack overhead)
2. **Freshness**: Runbook content reflects /rebuild runs (recommend nightly cron)
3. **Tickets**: Last 7 days of Linear tickets are searchable
4. **Fallback**: If primary search fails, we return supportive response (never error to user)
5. **Citations**: Every summary includes source links to Notion pages

### What We Do Not Guarantee

1. Perfect recall - some relevant content may be missed
2. Real-time Notion sync - content reflects last /rebuild
3. All Linear tickets - only last 7 days, max 100 per query

### Threading Contract

- Thread state preserved for 24 hours
- Up to 5 follow-ups tracked per thread
- Follow-up queries combine with root question for ranking
- Do not modify threading behavior unless directly relevant to retrieval

---

## Evaluation Approach

### Golden Query Set

The following queries must be evaluated on every significant retrieval change:

```json
{
  "golden_queries": [
    {
      "id": "GQ-001",
      "query": "how do I set up a typing tool",
      "type": "how_to",
      "expected_docs": ["Typing Tool", "Setup", "Configuration"],
      "expected_score_min": 0.4,
      "expected_provenance": ["semantic", "both"],
      "notes": "Feature setup question - should match setup/config runbooks"
    },
    {
      "id": "GQ-002",
      "query": "why is a workflow stuck pending",
      "type": "troubleshooting",
      "expected_docs": ["Pending", "Workflow", "Stuck", "Analysis"],
      "expected_score_min": 0.5,
      "expected_provenance": ["semantic", "both"],
      "notes": "Classic troubleshooting - 'stuck' should match 'pending'"
    },
    {
      "id": "GQ-003",
      "query": "how do I generate inputs",
      "type": "how_to",
      "expected_docs": ["Input", "Generate", "Survey"],
      "expected_score_min": 0.4,
      "expected_provenance": ["keyword", "both"],
      "notes": "Direct keyword should work well here"
    },
    {
      "id": "GQ-004",
      "query": "what is the escalation process",
      "type": "info_gathering",
      "expected_docs": ["Escalation", "Process", "Engineer"],
      "expected_score_min": 0.5,
      "expected_provenance": ["keyword", "both"],
      "notes": "Process documentation lookup"
    },
    {
      "id": "GQ-005",
      "query": "find similar tickets about diagnostics",
      "type": "ticket_search",
      "expected_tickets_min": 1,
      "expected_ticket_keywords": ["diagnostic", "debug", "log"],
      "notes": "Should return Linear tickets, not runbooks"
    },
    {
      "id": "GQ-006",
      "query": "analysis is broken",
      "type": "troubleshooting_vague",
      "expected_docs": ["Analysis", "Pending", "Error"],
      "expected_score_min": 0.3,
      "notes": "Vague query - should still find analysis runbooks"
    },
    {
      "id": "GQ-007",
      "query": "finalize not showing up for test",
      "type": "troubleshooting",
      "expected_docs": ["Finalize", "Test"],
      "expected_score_min": 0.5,
      "notes": "Specific troubleshooting with product terms"
    },
    {
      "id": "GQ-008",
      "query": "customer says export failed",
      "type": "troubleshooting",
      "expected_docs": ["Export", "CSV", "Download"],
      "expected_score_min": 0.4,
      "notes": "Customer-reported issue framing"
    },
    {
      "id": "GQ-009",
      "query": "reanalyze a completed test",
      "type": "how_to",
      "expected_docs": ["Reanalyze", "Analysis"],
      "expected_score_min": 0.5,
      "notes": "Process question"
    },
    {
      "id": "GQ-010",
      "query": "ModelPrepSyncError after segment",
      "type": "troubleshooting_specific",
      "expected_docs": ["Error", "Segment", "Sync"],
      "expected_score_min": 0.3,
      "notes": "Specific error message - may need exact match"
    },
    {
      "id": "GQ-011",
      "query": "loggedTasks taking too long",
      "type": "troubleshooting",
      "expected_docs": ["loggedTasks", "Performance", "Slow"],
      "expected_score_min": 0.4,
      "notes": "Technical term should match"
    },
    {
      "id": "GQ-012",
      "query": "what info do I need for stuck analysis",
      "type": "info_gathering",
      "expected_docs": ["Pending", "Analysis", "Information"],
      "expected_score_min": 0.4,
      "notes": "Pre-escalation info gathering"
    },
    {
      "id": "NEG-001",
      "query": "weather forecast tomorrow",
      "type": "negative",
      "expected_score_max": 0.2,
      "notes": "Should NOT match any runbook well"
    },
    {
      "id": "NEG-002",
      "query": "how to deploy kubernetes",
      "type": "negative",
      "expected_score_max": 0.2,
      "notes": "Engineering task, not CS runbook"
    },
    {
      "id": "NEG-003",
      "query": "recipe for chocolate cake",
      "type": "negative",
      "expected_score_max": 0.15,
      "notes": "Completely off-topic"
    }
  ]
}
```

### Evaluation Metrics

| Metric | Definition | Target |
|--------|------------|--------|
| **Precision@1** | Top result matches expected docs | ≥ 80% |
| **Precision@3** | At least one of top 3 matches expected | ≥ 90% |
| **Negative Rejection** | Negative queries score below threshold | 100% |
| **Latency P95** | 95th percentile response time | < 5s |
| **Fallback Rate** | % of queries using keyword fallback | < 20% |

### Running Evaluation

```bash
# Run retrieval evaluation
deno task eval

# Output: eval_results.json with pass/fail per query
```

---

## Execution Plan

### Task 1: Implement Evaluation Harness

**Description:** Create a deterministic evaluation script that runs golden queries against /search and reports pass/fail metrics.

**Implementation Notes:**
- Create `scripts/eval.ts` that loads `tests/golden_queries.json`
- For each query, call `/search?q=...&debug=1`
- Check: top score meets threshold, expected docs in results
- Output JSON report with per-query results

**Acceptance Criteria:**
- [ ] `deno task eval` runs without error
- [ ] Reports pass/fail for each golden query
- [ ] Outputs summary metrics (precision@1, precision@3, etc.)
- [ ] Can run against local dev server or production

**Risk:** Low - read-only testing, no production changes

---

### Task 2: Add Observability Logging

**Description:** Structured logging for retrieval performance to enable debugging and monitoring.

**Implementation Notes:**
- Extend existing `logSearchMetrics()` in main.ts
- Add: query tokens, embedding latency, hit provenance breakdown
- Log to structured JSON for filtering
- Add `retrievalLog` field to /search debug output

**Acceptance Criteria:**
- [ ] Every search logs: query, top_score, hit_count, embedding_used, latency_ms
- [ ] Fallback events logged with cause (already done)
- [ ] Debug mode shows full retrieval trace

**Risk:** Low - logging only

---

### Task 3: Raise Relevance Threshold

**Description:** Current threshold (0.15) is too permissive. Raise to 0.20 to reduce weak matches.

**Implementation Notes:**
- Change `RELEVANCE_SCORE_THRESHOLD` in main.ts from 0.15 to 0.20
- Update `HYBRID_THRESHOLD` in rank.ts from 0.15 to 0.20
- Run eval harness to verify no regressions on golden queries

**Acceptance Criteria:**
- [ ] Threshold changed to 0.20
- [ ] Golden query precision does not decrease
- [ ] Negative queries still rejected

**Risk:** Medium - may reduce recall, needs eval validation

---

### Task 4: Add Query Normalization

**Description:** Normalize queries before search to improve matching consistency.

**Implementation Notes:**
- Add `normalizeSearchQuery()` function:
  - Lowercase
  - Remove excessive punctuation
  - Collapse whitespace
  - Strip common CS prefixes ("customer says", "user reports")
- Apply in rank.ts and notionSearch.ts

**Acceptance Criteria:**
- [ ] "Customer says export failed" matches same as "export failed"
- [ ] No regression on golden queries

**Risk:** Low - preprocessing only

---

### Task 5: Cache Linear Tickets

**Description:** Cache recent Linear tickets for 5 minutes to reduce API calls on repeated queries.

**Implementation Notes:**
- Add in-memory cache in `linear/api.ts`
- Key: teamId + daysBack
- TTL: 5 minutes
- Invalidate on ticket creation

**Acceptance Criteria:**
- [ ] Second query within 5 min uses cached tickets
- [ ] Cache miss logs to console
- [ ] New ticket creation clears cache

**Risk:** Low - caching only

---

### Task 6: Add Golden Query Test File

**Description:** Create JSON file with golden queries for automated testing.

**Implementation Notes:**
- Create `tests/golden_queries.json` with queries from this doc
- Include expected results and thresholds
- Document how to update when runbooks change

**Acceptance Criteria:**
- [ ] File exists with 12+ golden queries
- [ ] File includes 3+ negative test cases
- [ ] Format matches eval harness expectations

**Risk:** Low - test data only

---

### Task 7: Implement Eval Script

**Description:** Create Deno script that runs evaluation against golden queries.

**Implementation Notes:**
- Create `scripts/eval.ts`
- Fetch `/search?q=...&debug=1` for each query
- Compare results against expectations
- Output markdown report

**Acceptance Criteria:**
- [ ] `deno task eval` works
- [ ] Reports pass/fail per query
- [ ] Exits with code 1 if any failures

**Risk:** Low - test tooling only

---

### Task 8: Document Retrieval Architecture

**Description:** This document (RETRIEVAL_ARCHITECTURE.md).

**Acceptance Criteria:**
- [ ] Document exists in docs/
- [ ] Covers current state, recommendations, contracts
- [ ] Includes golden queries and evaluation approach

**Risk:** Low - documentation only

---

## Val Town Constraints

Per Val Town documentation:

| Constraint | Limit | Impact |
|------------|-------|--------|
| Blob storage (Pro) | 1GB | Sufficient for ~250K embeddings at 1536 dims |
| Blob storage (Free) | 10MB | Only ~2,500 embeddings - not suitable for production |
| Blob key length | 512 chars | No impact |
| HTTP execution | ~30-60s | Use two-endpoint pattern for long operations |
| Cold start | Variable | Blob cache mitigates; Notion direct as fallback |

**Recommendation:** Stay on Pro tier for production use. Current V2 index (~1000 chunks × 1536 dims × 4 bytes) ≈ 6MB is well within limits.

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2026-02-02 | Claude | Initial architecture document |

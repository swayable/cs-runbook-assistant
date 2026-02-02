# CS Runbook Assistant

A Val Town HTTP val that helps CS teams find runbook answers and classify issues as CS-handlable vs engineer-required.

## Environment Setup

Add to PATH before running commands:
```bash
export PATH="/mnt/a61cc0e8-1b32-4574-a771-4ad77e8faab6/conda/.deno/bin:$PATH"
```

## Commands

```bash
# Type check
deno check main.ts

# Run locally
deno task dev

# Push to Val Town
vt push
```

## Project Structure

- `main.ts` - Entry point, HTTP routing
- `classifier/` - CS vs Engineer classification logic
  - `heuristics.ts` - Deterministic pattern detection (runs before LLM)
  - `classify.ts` - Main classification logic
  - `llmEnhancer.ts` - Optional LLM enhancement
- `retrieval/` - Runbook search
  - `rank.ts` - Keyword + hybrid scoring
  - `notionSearch.ts` - Direct Notion API search (no index needed)
  - `embeddings.ts` - OpenAI embeddings (optional)
- `linear/api.ts` - Linear ticket integration with LLM selection
- `handlers/llm.ts` - LLM summarization with next_actions
- `storage/indexStore.ts` - Notion ingestion and caching
- `slack/` - Slack API integration
- `types/index.ts` - Shared TypeScript types
- `docs/` - Documentation
  - `MANUAL_TEST_PLAN.md` - Test procedures
  - `REVIEW.md` - Staff engineer review

## Key Endpoints

- `GET /` - Status
- `GET /health` - Health check with embedding status
- `GET /rebuild` - Rebuild index from Notion (optional with direct search)
- `GET /search?q=...` - Search runbooks (returns summary, next_actions, docs, tickets)
- `GET /classify?q=...&llm=1` - Classify query (returns strict JSON)
- `GET /warm` - Cache warming endpoint (cron every 15 min)

## Classification Logic

The classifier uses deterministic heuristics that run BEFORE any LLM call:

**Engineer-required signals** (any match = engineer_required):
- CLI/shell: `kubectl`, `bash`, `ssh`, `curl`, `npm`, etc.
- Scripts: "run script", "migration", "backfill", "deploy"
- Database: `mongo shell`, `psql`, `updateMany`, `ObjectId`
- Infrastructure: `AWS`, `GCP`, `k8s`, `docker`, `secrets`
- Dangerous: `delete`, `drop`, `truncate`, `purge`

**CS-handlable signals**:
- UI workflow: "click", "navigate", "dashboard", "settings page"

Engineer signals ALWAYS win over CS signals (conservative by default).

## New Behavior (2026-02)

### Related Tickets
- Fetches last 7 days of Linear tickets (NO state filtering)
- LLM selects relevant tickets with explanations
- Shows ticket reasons in Slack response

### Document Search
- Works WITHOUT `/rebuild` (uses Notion Search API directly)
- Combines semantic search + keyword matching
- Shows provenance: `semantic`, `keyword`, or `both`

### Response Format
- Always supportive, never dismissive
- No fast out-of-scoping (always attempts retrieval)
- Returns `next_actions[]` with 3-6 actionable steps

### /search Response
```json
{
  "q": "query",
  "summary": "2-5 sentences",
  "recommendation": "try_steps | file_ticket",
  "next_actions": ["action 1", "action 2", ...],
  "docs": [{"title", "url", "score", "provenance"}],
  "related_tickets": [{"identifier", "title", "reason"}]
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | - | LLM features (degrades gracefully) |
| `NOTION_TOKEN` | Yes | - | Notion API access |
| `NOTION_ROOT_PAGE_ID` | Yes | - | Root page for runbooks |
| `LINEAR_API_KEY` | Yes | - | Linear API access |
| `LINEAR_TEAM_KEY` | No | `ENG` | Linear team for tickets |
| `LINEAR_LABEL_NAME` | No | `CS Requests` | Label for new tickets |
| `SLACK_BOT_TOKEN` | Yes | - | Slack API access |
| `SLACK_SIGNING_SECRET` | Yes | - | Signature verification |
| `OPENAI_API_KEY` | No | - | Embedding search (optional) |
| `HYBRID_SEARCH_ENABLED` | No | `1` | Enable hybrid search |
| `LLM_TICKET_MODEL` | No | `claude-3-5-haiku-20241022` | Ticket selection model |

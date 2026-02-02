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
- `retrieval/rank.ts` - Runbook search and ranking
- `storage/indexStore.ts` - Notion ingestion and caching
- `slack/` - Slack API integration
- `types/index.ts` - Shared TypeScript types

## Key Endpoints

- `GET /` - Status
- `GET /health` - Health check
- `GET /rebuild` - Rebuild index from Notion
- `GET /search?q=...` - Search runbooks
- `GET /classify?q=...&llm=1` - Classify query (returns strict JSON)

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

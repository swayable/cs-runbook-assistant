# CS Runbook Assistant (Val Town)

A Slack bot that searches Notion runbooks and helps CS team members find solutions.

## Project Structure

```
/
├─ main.ts                  # Entry point + HTTP routing
├─ env.ts                   # Environment variables & config
│
├─ types/
│   └─ index.ts             # Shared TypeScript types
│
├─ util/
│   ├─ text.ts              # Text utilities (normalize, tokenize, uniq)
│   └─ response.ts          # HTTP response helpers (json, text)
│
├─ storage/
│   ├─ indexStore.ts        # Blob index + Notion crawl + cache
│   └─ actionStore.ts       # Blob-backed action store
│
├─ retrieval/
│   └─ rank.ts              # Keyword scoring + ranking
│
├─ llm/
│   └─ summarize.ts         # LLM summarization (placeholder)
│
├─ slack/
│   ├─ api.ts               # Slack API + signature verification
│   └─ actions.ts           # Interactive button handler
│
├─ pipeline/
│   └─ answerQuestion.ts    # Core orchestration + Linear integration
│
└─ deno.json                # Deno/Val Town config
```

## Val Town Compatibility

- **Single default export** in `main.ts`
- **No background workers** — async work fires after HTTP ack
- **Deno-compatible APIs only** — no Node-only modules
- **No JSX/TSX** — plain TypeScript
- **Blob storage** via `https://esm.town/v/std/blob`

## Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/` | GET | Status + quick links |
| `/health` | GET | Cache status |
| `/rebuild` | GET | Refresh index from Notion |
| `/debug` | GET | Index diagnostics |
| `/search?q=...` | GET | Search runbooks |
| `/slack/command` | POST | Slash command handler |
| `/slack/actions` | POST | Button click handler |
| `/slack/events` | POST | App mention handler |
| `/blob-debug` | GET | Blob storage debug |

## Environment Variables

See `.env.example` for all available variables. Required:
- `SLACK_BOT_TOKEN` - Slack bot token
- `SLACK_SIGNING_SECRET` - Slack signing secret
- `NOTION_TOKEN` - Notion integration token
- `NOTION_ROOT_PAGE_ID` - Root page ID for runbooks
- `LINEAR_API_KEY` - Linear API key

Optional:
- `LINEAR_TEAM_KEY` (default: "ENG")
- `LINEAR_LABEL_NAME` (default: "CS Requests")
- `LINEAR_TIMEOUT_MS` (default: 5000)
- `PUBLIC_BASE_URL` - Base URL for links
- `MEM_CACHE_TTL_MS` (default: 3600000)
- `BLOB_KEY` (default: "cs_runbook_index_v1")
- `ANTHROPIC_API_KEY` - For LLM features
- `OPENAI_API_KEY` - For hybrid search embeddings
- `HYBRID_SEARCH_ENABLED` (default: 1)
- `LLM_DIRECTOR_ENABLED` (default: 1)

## Deployment to Val Town

This project is deployed via the Val Town CLI (`vt`).

### Prerequisites

1. Install the Val Town CLI: `npm install -g @valtown/cli` or `deno install -A -n vt jsr:@valtown/cli`
2. Authenticate: `vt login`
3. Set environment variables in Val Town dashboard (Settings > Environment Variables)

### Deploy

```bash
# From the repo root
vt push

# Or with verbose output
vt push --verbose
```

### Local Development

```bash
# Add deno to PATH (if using conda environment)
export PATH="/mnt/a61cc0e8-1b32-4574-a771-4ad77e8faab6/conda/.deno/bin:$PATH"

# Type check
deno check main.ts

# Run locally
deno task dev
```

### Configuration Files

- `deno.json` - Deno/Val Town config
- `.vtignore` - Files excluded from Val Town push
- `.vt/state.json` - Local Val Town state (gitignored)

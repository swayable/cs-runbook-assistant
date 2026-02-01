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

Required:
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `NOTION_TOKEN`
- `NOTION_ROOT_PAGE_ID`
- `LINEAR_API_KEY`

Optional:
- `LINEAR_TEAM_KEY` (default: "ENG")
- `LINEAR_LABEL_NAME` (default: "CS Requests")
- `PUBLIC_BASE_URL`
- `CACHE_TTL_MS` (default: 3600000)
- `LINEAR_TIMEOUT_MS` (default: 700)
- `BLOB_KEY` (default: "cs_runbook_index_v1")

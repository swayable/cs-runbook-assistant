// env.ts — Environment variables & config

export const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN") || "";
export const SLACK_SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET") || "";

export const NOTION_TOKEN = Deno.env.get("NOTION_TOKEN") || "";
export const NOTION_ROOT_PAGE_ID = Deno.env.get("NOTION_ROOT_PAGE_ID") || "";

export const LINEAR_API_KEY = Deno.env.get("LINEAR_API_KEY") || "";
export const LINEAR_TEAM_KEY = Deno.env.get("LINEAR_TEAM_KEY") || "ENG";
export const LINEAR_LABEL_NAME = Deno.env.get("LINEAR_LABEL_NAME") || "CS Requests";

export const PUBLIC_BASE_URL = (Deno.env.get("PUBLIC_BASE_URL") || "").replace(
  /\/+$/,
  "",
);

// TTL Configuration:
// - MEM_CACHE_TTL_MS: How long to use in-memory cache before checking blob (default 60 min)
// - BLOB_MAX_AGE_MS: Age after which blob is considered "stale" for warnings (default 7 days)
//   Note: Stale blobs are STILL USED — staleness only affects warnings/diagnostics
// - CACHE_TTL_MS: Legacy env var, used as fallback for MEM_CACHE_TTL_MS

const DEFAULT_MEM_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
const DEFAULT_BLOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Prefer MEM_CACHE_TTL_MS, fall back to CACHE_TTL_MS for backward compatibility
export const MEM_CACHE_TTL_MS = Number(
  Deno.env.get("MEM_CACHE_TTL_MS") ||
    Deno.env.get("CACHE_TTL_MS") ||
    DEFAULT_MEM_CACHE_TTL_MS
);

export const BLOB_MAX_AGE_MS = Number(
  Deno.env.get("BLOB_MAX_AGE_MS") || DEFAULT_BLOB_MAX_AGE_MS
);

// Legacy export for backward compatibility
export const CACHE_TTL_MS = MEM_CACHE_TTL_MS;

export const LINEAR_TIMEOUT_MS = Number(Deno.env.get("LINEAR_TIMEOUT_MS") || 700);

export const BLOB_KEY = Deno.env.get("BLOB_KEY") || "cs_runbook_index_v1";
export const ACTION_BLOB_PREFIX = "cs_action_v1:";
export const ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export function mustEnv(): void {
  const missing = [
    ["SLACK_BOT_TOKEN", SLACK_BOT_TOKEN],
    ["SLACK_SIGNING_SECRET", SLACK_SIGNING_SECRET],
    ["NOTION_TOKEN", NOTION_TOKEN],
    ["NOTION_ROOT_PAGE_ID", NOTION_ROOT_PAGE_ID],
    ["LINEAR_API_KEY", LINEAR_API_KEY],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }
}

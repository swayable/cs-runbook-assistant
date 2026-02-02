// linear/api.ts — Linear API integration

import { LINEAR_API_KEY } from "../env.ts";

// ============================================================================
// Types
// ============================================================================

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  state?: { name: string; type: string } | null;
  createdAt?: string;
};

export type LLMSelectedIssue = {
  issue: LinearIssue;
  reason: string;
};

export type ScoredIssue = { issue: LinearIssue; score: number };

// Fallback cause types for observability
export type FallbackCause = "missing_key" | "timeout" | "non_200" | "parse_error" | "empty_response";

// Result type for LLM selection that tracks the actual path taken
export type TicketSelectionResult = {
  tickets: LLMSelectedIssue[];
  actualSource: "llm" | "keyword";
  fallbackCause?: FallbackCause;
  durationMs?: number;
};

// Type for injectable fetch function (for testing)
export type FetchFn = typeof fetch;

// ============================================================================
// GraphQL Client
// ============================================================================

const LINEAR_GRAPHQL_TIMEOUT_MS = 10000;

async function linearGraphQL(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LINEAR_GRAPHQL_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: LINEAR_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const j = await res.json();
    if (!res.ok || j.errors) {
      throw new Error(
        `Linear error: ${res.status} ${JSON.stringify(j.errors || j).slice(0, 300)}`
      );
    }
    return j.data;
  } catch (e) {
    clearTimeout(timeoutId);
    if ((e as Error).name === "AbortError") {
      throw new Error("Linear API timeout");
    }
    throw e;
  }
}

// ============================================================================
// Team & Label Lookups
// ============================================================================

export async function getLinearTeamIdByKey(teamKey: string): Promise<string> {
  const q = `query Teams { teams { nodes { id key name } } }`;
  const data = await linearGraphQL(q, {}) as { teams: { nodes: { id: string; key: string }[] } };
  const team = data.teams.nodes.find((t) => t.key === teamKey);
  if (!team) throw new Error(`Linear team not found for key=${teamKey}`);
  return team.id;
}

export async function debugLinearTeams(): Promise<{ teams: Array<{ key: string; name: string; id: string }> }> {
  const q = `query Teams { teams { nodes { id key name } } }`;
  const data = await linearGraphQL(q, {}) as { teams: { nodes: { id: string; key: string; name: string }[] } };
  return { teams: data.teams.nodes.map((t) => ({ key: t.key, name: t.name, id: t.id })) };
}

export async function getLabelIdByName(labelName: string): Promise<string | null> {
  const q = `query IssueLabels { issueLabels { nodes { id name } } }`;
  const data = await linearGraphQL(q, {}) as { issueLabels: { nodes: { id: string; name: string }[] } };
  const label = data.issueLabels.nodes.find((l) => l.name === labelName);
  return label?.id || null;
}

// ============================================================================
// Ticket Creation
// ============================================================================

export async function createLinearTicket(params: {
  title: string;
  description: string;
  teamKey: string;
  labelName?: string;
}): Promise<{ url: string; identifier: string }> {
  const teamId = await getLinearTeamIdByKey(params.teamKey);
  const labelId = params.labelName ? await getLabelIdByName(params.labelName) : null;

  const m = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { identifier url }
      }
    }
  `;

  const input: Record<string, unknown> = {
    teamId,
    title: params.title,
    description: params.description,
  };
  if (labelId) input.labelIds = [labelId];

  const data = await linearGraphQL(m, { input }) as { issueCreate: { issue: { url: string; identifier: string } } };

  // Clear the recent issues cache since we just created a new ticket
  clearRecentIssuesCache();

  return {
    url: data.issueCreate.issue.url,
    identifier: data.issueCreate.issue.identifier,
  };
}

// ============================================================================
// Search
// ============================================================================

export async function searchLinearIssues(term: string, teamId: string): Promise<LinearIssue[]> {
  const q = `
    query Search($term: String!, $teamId: String) {
      searchIssues(term: $term, teamId: $teamId, first: 10, includeComments: false) {
        nodes { id identifier title url state { name type } }
      }
    }
  `;
  const data = await linearGraphQL(q, { term, teamId }) as { searchIssues: { nodes: LinearIssue[] } };
  return data.searchIssues.nodes;
}

// ============================================================================
// Last 7 Days Issues Fetch (no state filtering)
// ============================================================================

// Cache for recent issues to reduce API calls
const RECENT_ISSUES_CACHE = new Map<string, { issues: LinearIssue[]; ts: number }>();
const RECENT_ISSUES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Clear the recent issues cache. Called after ticket creation.
 */
export function clearRecentIssuesCache(): void {
  RECENT_ISSUES_CACHE.clear();
}

/**
 * Fetch recently-updated issues for a team.
 * Uses updatedAt filter (not createdAt) to catch active tickets regardless of creation date.
 * Does NOT filter by state - returns all issues regardless of status.
 *
 * Results are cached for 5 minutes to reduce API load on repeated queries.
 */
export async function fetchRecentIssues(teamId: string, daysBack = 7, maxIssues = 100): Promise<LinearIssue[]> {
  // Check cache first
  const cacheKey = `${teamId}:${daysBack}:${maxIssues}`;
  const cached = RECENT_ISSUES_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < RECENT_ISSUES_CACHE_TTL_MS) {
    console.log(`[fetchRecentIssues] Cache hit for teamId=${teamId}`);
    return cached.issues;
  }
  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceISO = since.toISOString();

  const q = `
    query RecentIssues($teamId: String!, $since: DateTimeOrDuration!, $first: Int!) {
      team(id: $teamId) {
        issues(
          first: $first,
          orderBy: updatedAt,
          filter: { updatedAt: { gte: $since } }
        ) {
          nodes {
            id
            identifier
            title
            description
            url
            createdAt
            state { name type }
          }
        }
      }
    }
  `;

  try {
    const data = await linearGraphQL(q, {
      teamId,
      since: sinceISO,
      first: maxIssues,
    }) as { team: { issues: { nodes: LinearIssue[] } } };
    const issues = data.team?.issues?.nodes || [];
    console.log(`[fetchRecentIssues] teamId=${teamId}, since=${sinceISO}, found ${issues.length} issues`);

    // Cache the results
    const cacheKey = `${teamId}:${daysBack}:${maxIssues}`;
    RECENT_ISSUES_CACHE.set(cacheKey, { issues, ts: Date.now() });

    return issues;
  } catch (e) {
    console.warn("[fetchRecentIssues] Failed:", String((e as any)?.message || e));
    return [];
  }
}

// ============================================================================
// LLM-Based Ticket Selection
// ============================================================================

const LLM_TICKET_SELECTION_TIMEOUT_MS = 8000;

/**
 * Use LLM to select relevant tickets from a list of recent issues.
 * Returns up to maxResults tickets with a brief reason for each.
 *
 * @param query - The user's question/search query
 * @param issues - List of recent Linear issues to select from
 * @param maxResults - Maximum number of tickets to return (default 8)
 * @param fetchFn - Optional fetch function for dependency injection (testing)
 * @returns TicketSelectionResult with tickets, actualSource, and fallback info
 */
export async function selectRelevantTicketsWithLLM(
  query: string,
  issues: LinearIssue[],
  maxResults = 8,
  fetchFn: FetchFn = fetch
): Promise<TicketSelectionResult> {
  const startTime = Date.now();
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");

  if (!apiKey) {
    const durationMs = Date.now() - startTime;
    logFallback("missing_key", durationMs, "No ANTHROPIC_API_KEY configured");
    return {
      tickets: fallbackKeywordSelection(query, issues, maxResults, "missing_key"),
      actualSource: "keyword",
      fallbackCause: "missing_key",
      durationMs,
    };
  }

  if (issues.length === 0) {
    return { tickets: [], actualSource: "llm", durationMs: Date.now() - startTime };
  }

  // Prepare compact ticket data for LLM
  const ticketData = issues.slice(0, 50).map((issue, idx) => ({
    idx,
    id: issue.identifier,
    title: issue.title,
    state: issue.state?.name || "Unknown",
    desc: (issue.description || "").slice(0, 150),
  }));

  const systemPrompt = `You are helping a CS support agent find relevant Linear tickets for a customer issue.

Given a user query and a list of recent tickets, select the tickets that are MOST RELEVANT to the query.
Consider:
- Similar symptoms, errors, or feature areas
- Related customer issues or bug reports
- Tickets that might be duplicates or related to the same root cause

Respond ONLY with valid JSON in this format:
{"selected": [{"idx": 0, "reason": "Brief reason..."}, ...]}

Rules:
- Select 0-${maxResults} tickets (only if truly relevant)
- "reason" should be 5-15 words explaining relevance
- idx is the index from the ticket list
- Do NOT include tickets that are clearly unrelated
- Empty array is fine if nothing is relevant`;

  const userMessage = `User query: ${query}

Recent tickets (last 7 days):
${ticketData.map((t) => `[${t.idx}] ${t.id}: ${t.title} (${t.state})${t.desc ? `\n    ${t.desc}` : ""}`).join("\n")}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TICKET_SELECTION_TIMEOUT_MS);

  try {
    const res = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: Deno.env.get("LLM_TICKET_MODEL") || "claude-3-5-haiku-20241022",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;

    if (!res.ok) {
      logFallback("non_200", durationMs, `API returned status ${res.status}`);
      return {
        tickets: fallbackKeywordSelection(query, issues, maxResults, "non_200"),
        actualSource: "keyword",
        fallbackCause: "non_200",
        durationMs,
      };
    }

    const data = await res.json();
    const content = data?.content?.[0]?.text;
    if (!content) {
      logFallback("empty_response", durationMs, "LLM returned empty content");
      return {
        tickets: fallbackKeywordSelection(query, issues, maxResults, "empty_response"),
        actualSource: "keyword",
        fallbackCause: "empty_response",
        durationMs,
      };
    }

    // Parse JSON response
    const parsed = safeParseJsonTickets(content);
    if (!parsed || !Array.isArray(parsed.selected)) {
      logFallback("parse_error", durationMs, "Failed to parse LLM JSON response");
      return {
        tickets: fallbackKeywordSelection(query, issues, maxResults, "parse_error"),
        actualSource: "keyword",
        fallbackCause: "parse_error",
        durationMs,
      };
    }

    // Map indices back to issues with LLM: prefix
    const results: LLMSelectedIssue[] = [];
    for (const sel of parsed.selected.slice(0, maxResults)) {
      const idx = sel.idx;
      if (typeof idx === "number" && idx >= 0 && idx < issues.length) {
        const rawReason = String(sel.reason || "Related to query").slice(0, 100);
        results.push({
          issue: issues[idx],
          reason: `LLM: ${rawReason}`,
        });
      }
    }

    console.log(`[selectRelevantTicketsWithLLM] LLM selected ${results.length} tickets in ${durationMs}ms`);
    return { tickets: results, actualSource: "llm", durationMs };
  } catch (e) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;

    if ((e as Error).name === "AbortError") {
      logFallback("timeout", durationMs, `LLM call timed out after ${LLM_TICKET_SELECTION_TIMEOUT_MS}ms`);
      return {
        tickets: fallbackKeywordSelection(query, issues, maxResults, "timeout"),
        actualSource: "keyword",
        fallbackCause: "timeout",
        durationMs,
      };
    }

    // Treat other errors as non_200 equivalent
    logFallback("non_200", durationMs, `LLM call failed: ${String((e as Error).message || e)}`);
    return {
      tickets: fallbackKeywordSelection(query, issues, maxResults, "non_200"),
      actualSource: "keyword",
      fallbackCause: "non_200",
      durationMs,
    };
  }
}

/**
 * Structured fallback logging for observability.
 */
function logFallback(cause: FallbackCause, durationMs: number, message: string): void {
  console.warn(JSON.stringify({
    event: "ticket_selection_fallback",
    cause,
    durationMs,
    message,
    timestamp: new Date().toISOString(),
  }));
}

function safeParseJsonTickets(s: string): { selected: Array<{ idx: number; reason: string }> } | null {
  // Try multiple extraction strategies
  const strategies = [
    // Strategy 1: Extract from markdown code block
    () => {
      const match = s.match(/```(?:json)?\s*([\s\S]*?)```/);
      return match ? match[1].trim() : null;
    },
    // Strategy 2: Find JSON object starting with {"selected"
    () => {
      const match = s.match(/\{\s*"selected"\s*:\s*\[[\s\S]*?\]\s*\}/);
      return match ? match[0] : null;
    },
    // Strategy 3: Find any JSON object with square brackets
    () => {
      const match = s.match(/\{[\s\S]*\[[\s\S]*\][\s\S]*\}/);
      return match ? match[0] : null;
    },
    // Strategy 4: Raw string is JSON
    () => s.trim(),
  ];

  for (const strategy of strategies) {
    try {
      const candidate = strategy();
      if (!candidate) continue;
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray(parsed.selected)) {
        return parsed;
      }
    } catch {
      // Try next strategy
    }
  }

  // Log first 500 chars to help debug
  console.warn(`[safeParseJsonTickets] Failed to parse LLM response. First 500 chars: ${s.slice(0, 500)}`);
  return null;
}

/**
 * Fallback keyword-based ticket selection when LLM is unavailable.
 * Reasons are prefixed with "Fallback: <cause>" for observability.
 *
 * @param query - The user's question/search query
 * @param issues - List of Linear issues to select from
 * @param maxResults - Maximum number of tickets to return
 * @param cause - The reason for falling back (used in reason prefix)
 */
export function fallbackKeywordSelection(
  query: string,
  issues: LinearIssue[],
  maxResults: number,
  cause: FallbackCause = "missing_key"
): LLMSelectedIssue[] {
  const qTokens = new Set(tokenize(query));
  const scored = issues.map((issue) => {
    const tTokens = tokenize(issue.title + " " + (issue.description || ""));
    let sim = 0;
    for (const t of tTokens) if (qTokens.has(t)) sim += 1;
    return { issue, score: sim };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => ({
      issue: s.issue,
      reason: `Fallback: ${cause} - Keyword match`,
    }));
}

// ============================================================================
// Ranking & Filtering (Legacy - kept for backward compatibility)
// ============================================================================

function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function rankPossibleDuplicates(query: string, issues: LinearIssue[]): LinearIssue[] {
  const qTokens = new Set(tokenize(query));
  const scored = issues.map((i) => {
    const tTokens = tokenize(i.title);
    let sim = 0;
    for (const t of tTokens) if (qTokens.has(t)) sim += 1;
    const st = i.state?.type || "";
    let stateBoost = 0;
    if (st === "started") stateBoost = 2;
    if (st === "unstarted") stateBoost = 1;
    if (st === "completed" || st === "canceled") stateBoost = -2;
    return { issue: i, score: sim + stateBoost };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.issue);
}

export function uniqByUrlOrId(issues: LinearIssue[]): LinearIssue[] {
  const seen = new Set<string>();
  const out: LinearIssue[] = [];
  for (const i of issues) {
    const k = i.url || i.id;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}

// ============================================================================
// Related Tickets Selection (Legacy keyword-based)
// ============================================================================

const MAX_RELATED_TICKETS = 8;
const HIGH_RELEVANCE_SCORE = 2;
const FALLBACK_TOP_N = 3;

// NOTE: filterRelevantOpenIssues removed - no longer filtering by state per requirements

function scoreIssues(query: string, issues: LinearIssue[]): ScoredIssue[] {
  const qTokens = new Set(tokenize(query));
  return issues.map((issue) => {
    const tTokens = tokenize(issue.title);
    let sim = 0;
    for (const t of tTokens) if (qTokens.has(t)) sim += 1;
    const st = issue.state?.type || "";
    let stateBoost = 0;
    if (st === "started") stateBoost = 2;
    if (st === "unstarted") stateBoost = 1;
    return { issue, score: sim + stateBoost };
  });
}

export function selectHighlyRelevantIssues(
  query: string,
  issues: LinearIssue[]
): { selected: LinearIssue[]; overflow: number } {
  // NOTE: No longer filtering by state - all issues are candidates
  if (issues.length === 0) {
    return { selected: [], overflow: 0 };
  }

  const scored = scoreIssues(query, issues);
  scored.sort((a, b) => b.score - a.score);

  const highlyRelevant = scored.filter((s) => s.score >= HIGH_RELEVANCE_SCORE);
  if (highlyRelevant.length > 0) {
    const selected = highlyRelevant.slice(0, MAX_RELATED_TICKETS).map((s) => s.issue);
    const overflow = Math.max(0, highlyRelevant.length - MAX_RELATED_TICKETS);
    return { selected, overflow };
  }

  const selected = scored.slice(0, FALLBACK_TOP_N).map((s) => s.issue);
  return { selected, overflow: 0 };
}

// ============================================================================
// Combined: Fetch Recent + LLM Selection
// ============================================================================

// Extended result type for getRelatedTicketsWithLLM
export type RelatedTicketsResult = {
  tickets: LLMSelectedIssue[];
  source: "llm" | "keyword" | "none";
  issuesFetched: number;
  fallbackCause?: FallbackCause;
  selectionDurationMs?: number;
};

/**
 * Fetch recent issues from Linear (last 7 days) and use LLM to select relevant ones.
 * This is the new primary method for finding related tickets.
 *
 * @param query - The user's question/search query
 * @param teamId - Linear team ID to fetch issues from
 * @param timeoutMs - Overall timeout for fetch operation (default 10000ms)
 * @param maxResults - Maximum number of tickets to return (default 8)
 * @param fetchFn - Optional fetch function for dependency injection (testing)
 */
export async function getRelatedTicketsWithLLM(
  query: string,
  teamId: string,
  timeoutMs = 10000,
  maxResults = 8,
  fetchFn: FetchFn = fetch
): Promise<RelatedTicketsResult> {
  // Fetch recent issues with timeout
  let issues: LinearIssue[] = [];
  try {
    const fetchPromise = fetchRecentIssues(teamId, 7, 100);
    issues = await Promise.race([
      fetchPromise,
      new Promise<LinearIssue[]>((_, reject) =>
        setTimeout(() => reject(new Error("Fetch timeout")), timeoutMs / 2)
      ),
    ]);
  } catch (e) {
    console.warn("[getRelatedTicketsWithLLM] Fetch failed:", String((e as any)?.message || e));
    return { tickets: [], source: "none", issuesFetched: 0 };
  }

  console.log(`[getRelatedTicketsWithLLM] Fetched ${issues.length} issues from last 7 days`);

  if (issues.length === 0) {
    return { tickets: [], source: "none", issuesFetched: 0 };
  }

  // Use LLM to select relevant tickets (with remaining time budget)
  const result = await selectRelevantTicketsWithLLM(query, issues, maxResults, fetchFn);

  console.log(
    `[getRelatedTicketsWithLLM] ${result.actualSource} selected ${result.tickets.length} from ${issues.length} issues` +
    (result.fallbackCause ? ` (fallback: ${result.fallbackCause})` : "") +
    ` in ${result.durationMs}ms`
  );

  return {
    tickets: result.tickets,
    source: result.actualSource,
    issuesFetched: issues.length,
    fallbackCause: result.fallbackCause,
    selectionDurationMs: result.durationMs,
  };
}

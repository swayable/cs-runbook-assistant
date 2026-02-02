// linear/api.ts — Linear API integration

import { LINEAR_API_KEY } from "../env.ts";

// ============================================================================
// Types
// ============================================================================

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state?: { name: string; type: string } | null;
};

export type ScoredIssue = { issue: LinearIssue; score: number };

// ============================================================================
// GraphQL Client
// ============================================================================

async function linearGraphQL(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: LINEAR_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const j = await res.json();
  if (!res.ok || j.errors) {
    throw new Error(
      `Linear error: ${res.status} ${JSON.stringify(j.errors || j).slice(0, 600)}`
    );
  }
  return j.data;
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
// Ranking & Filtering
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
// Related Tickets Selection
// ============================================================================

const MAX_RELATED_TICKETS = 8;
const HIGH_RELEVANCE_SCORE = 2;
const FALLBACK_TOP_N = 3;

function filterRelevantOpenIssues(issues: LinearIssue[]): LinearIssue[] {
  return issues.filter((issue) => {
    const stateType = issue.state?.type?.toLowerCase() || "";
    const stateName = issue.state?.name?.toLowerCase() || "";
    if (stateType === "completed" || stateType === "canceled") return false;
    if (stateName.includes("duplicate")) return false;
    return true;
  });
}

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
  const filtered = filterRelevantOpenIssues(issues);
  if (filtered.length === 0) {
    return { selected: [], overflow: 0 };
  }

  const scored = scoreIssues(query, filtered);
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

// pipeline/answerQuestion.ts — Core orchestration

import { LINEAR_API_KEY, LINEAR_TEAM_KEY, LINEAR_TIMEOUT_MS } from "../env.ts";
import type { AnswerOpts, Chunk, LinearIssue, Ranked } from "../types/index.ts";
import { normalizeQuery, tokenize, uniq, withTimeout } from "../util/text.ts";
import { buildIndex } from "../storage/indexStore.ts";
import { putAction } from "../storage/actionStore.ts";
import { rank, isEngineeringOnly } from "../retrieval/rank.ts";

// Help detection
function isHelpQuery(raw: string): boolean {
  const q = normalizeQuery(raw);
  if (!q) return true;

  const patterns = [
    "help",
    "what can you do",
    "what do you do",
    "capabilities",
    "examples",
    "how do i use",
    "how to use",
    "usage",
    "commands",
    "what should i ask",
    "what kinds of things",
  ];
  return patterns.some((p) => q.includes(p));
}

function buildHelpBlocks(): any[] {
  const helpText = [
    "*CS Helper — what I can do*",
    "",
    "I search our Notion CS runbooks and return *CS-safe* steps + escalation checklists.",
    "If the runbook is engineering-only (DB/scripts), I'll *link the runbook* and suggest filing an ENG ticket.",
    "",
    "*Try asking like this*",
    "• `/cs-help finalize pending`",
    "• `/cs-help analysis stuck pending`",
    "• `/cs-help ModelPrepSyncError after adding a segment`",
    "• `/cs-help backfill monthly values for 4 questions (frequentist 30-day)`",
    "• `/cs-help remove content from finalized test`",
    "",
    "*Also available (debug)*",
    "• `GET /health` — fast status",
    "• `GET /search?q=...` — runbook search (plain text)",
    "• `GET /rebuild` — refresh index from Notion (slow)",
    "",
    "Tip: Post the problem statement + links (survey/tracker) in this thread and mention me again to iterate: `@cs-helper <more details>`",
  ].join("\n");

  return [
    { type: "section", text: { type: "mrkdwn", text: helpText } },
  ];
}

// Linear GraphQL
async function linearGraphQL(query: string, variables: any): Promise<any> {
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
      `Linear error: ${res.status} ${
        JSON.stringify(j.errors || j).slice(0, 600)
      }`,
    );
  }
  return j.data;
}

async function getLinearTeamIdByKey(teamKey: string): Promise<string> {
  const q = `query Teams { teams { nodes { id key name } } }`;
  const data = await linearGraphQL(q, {});
  const team = data.teams.nodes.find((t: any) => t.key === teamKey);
  if (!team) throw new Error(`Linear team not found for key=${teamKey}`);
  return team.id;
}

async function getLabelIdByName(labelName: string): Promise<string | null> {
  const q = `query IssueLabels { issueLabels { nodes { id name } } }`;
  const data = await linearGraphQL(q, {});
  const label = data.issueLabels.nodes.find((l: any) => l.name === labelName);
  return label?.id || null;
}

export async function createLinearTicket(params: {
  title: string;
  description: string;
  teamKey: string;
  labelName?: string;
}): Promise<{ url: string; identifier: string }> {
  const teamId = await getLinearTeamIdByKey(params.teamKey);
  const labelId = params.labelName
    ? await getLabelIdByName(params.labelName)
    : null;

  const m = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { identifier url }
      }
    }
  `;

  const input: any = {
    teamId,
    title: params.title,
    description: params.description,
  };
  if (labelId) input.labelIds = [labelId];

  const data = await linearGraphQL(m, { input });
  return {
    url: data.issueCreate.issue.url,
    identifier: data.issueCreate.issue.identifier,
  };
}

async function searchLinearIssues(
  term: string,
  teamId: string,
): Promise<LinearIssue[]> {
  const q = `
    query Search($term: String!, $teamId: String) {
      searchIssues(term: $term, teamId: $teamId, first: 10, includeComments: false) {
        nodes { id identifier title url state { name type } }
      }
    }
  `;
  const data = await linearGraphQL(q, { term, teamId });
  return data.searchIssues.nodes as LinearIssue[];
}

function rankPossibleDuplicates(
  query: string,
  issues: LinearIssue[],
): LinearIssue[] {
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
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).map((x) =>
    x.issue
  );
}

function uniqByUrlOrId(issues: LinearIssue[]): LinearIssue[] {
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
// Related Tickets Filtering & Selection
// ============================================================================

/** Maximum related tickets to display in Slack */
const MAX_RELATED_TICKETS = 8;

/** Minimum score to be considered "highly relevant" */
const HIGH_RELEVANCE_SCORE = 2;

/** Fallback count when no issues meet the high relevance threshold */
const FALLBACK_TOP_N = 3;

/**
 * Filter out issues that are closed, canceled, or marked as duplicates.
 */
function filterRelevantOpenIssues(issues: LinearIssue[]): LinearIssue[] {
  return issues.filter((issue) => {
    const stateType = issue.state?.type?.toLowerCase() || "";
    const stateName = issue.state?.name?.toLowerCase() || "";

    if (stateType === "completed" || stateType === "canceled") {
      return false;
    }

    if (stateName.includes("duplicate")) {
      return false;
    }

    return true;
  });
}

type ScoredIssue = { issue: LinearIssue; score: number };

/**
 * Score issues by relevance to the query.
 */
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

/**
 * Select highly relevant open issues for display.
 */
function selectHighlyRelevantIssues(
  query: string,
  issues: LinearIssue[],
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

// Response construction
function requiredInfoList(question: string): string[] {
  const q = question.toLowerCase();
  const base = [
    "Test / survey URL(s) (setup / diagnostics / tracker links)",
    "Test ID(s) and client/org name",
    "Expected vs observed behavior",
    "Timestamp(s) + timezone, and what changed recently",
    "Whether this blocks delivery + deadline / urgency",
    "Screenshots of relevant UI state",
  ];
  if (q.includes("pending") || q.includes("finalize")) {
    base.unshift("Diagnostics URL + screenshot showing Pending/Finalize state");
  }
  if (
    q.includes("tracker") || q.includes("monthly") || q.includes("backfill")
  ) {
    base.unshift(
      "Tracker URL + requested breakdown/time buckets + exact questions/metrics",
    );
  }
  return uniq(base);
}

export function shortStepFromChunkText(text: string, fallback: string): string {
  const lines = text.split("\n").map((x) => x.trim()).filter((x) =>
    x.length > 0
  );

  const isJunk = (s: string) => {
    const t = s.toLowerCase();
    return (
      t.startsWith("🎫 ticket reference") ||
      t.startsWith("ticket reference") ||
      t.startsWith("keywords:") ||
      t.startsWith("why do this") ||
      t.startsWith("why/when") ||
      t.startsWith("note:") ||
      t.startsWith("todo:") ||
      t.startsWith("context:") ||
      t.startsWith("description") ||
      t.includes("linear.app/") ||
      t.includes("notion.so/") ||
      t === "—" ||
      t === "-"
    );
  };

  const looksLikeAction = (s: string) => {
    const t = s.toLowerCase();
    return (
      /^\d+[\).\s]/.test(s) ||
      t.startsWith("go to") ||
      t.startsWith("open") ||
      t.startsWith("check") ||
      t.startsWith("confirm") ||
      t.startsWith("click") ||
      t.startsWith("run") ||
      t.startsWith("refresh") ||
      t.startsWith("verify") ||
      t.startsWith("copy") ||
      t.startsWith("paste") ||
      t.startsWith("reanalyze") ||
      t.startsWith("finalize") ||
      t.startsWith("update") ||
      t.startsWith("disable") ||
      t.startsWith("enable")
    );
  };

  for (const line of lines) {
    if (!isJunk(line) && looksLikeAction(line)) {
      return line.length > 140 ? line.slice(0, 137) + "…" : line;
    }
  }
  for (const line of lines) {
    if (!isJunk(line)) {
      return line.length > 140 ? line.slice(0, 137) + "…" : line;
    }
  }
  return fallback.length > 140 ? fallback.slice(0, 137) + "…" : fallback;
}

function buildTicketDescription(args: {
  question: string;
  slackUser?: string;
  slackChannel?: string;
  runbookHits: Ranked[];
  duplicates: LinearIssue[];
}): string {
  const runbookLines = args.runbookHits.length > 0
    ? args.runbookHits
        .map((h, i) => {
          const label = shortStepFromChunkText(h.chunk.text, h.chunk.pageTitle);
          return `${
            i + 1
          }. ${h.chunk.pageTitle} — ${h.chunk.sectionTitle}\n   ${h.chunk.url}\n   Step label: ${label}\n   score=${h.score} codeSignals=${h.chunk.codeSignals}`;
        })
        .join("\n")
    : "(none)";

  const dupLines = args.duplicates.length > 0
    ? args.duplicates
        .map(
          (d) =>
            `- ${d.identifier} — ${d.title} (${
              d.state?.name || "Unknown"
            })\n  ${d.url}`,
        )
        .join("\n")
    : "(none found)";

  return [
    "## CS Escalation",
    "",
    `**Slack user:** ${args.slackUser || "unknown"}`,
    `**Slack channel:** ${args.slackChannel || "unknown"}`,
    "",
    "### Question",
    args.question,
    "",
    "### Runbook pointers (what the bot found)",
    runbookLines,
    "",
    "### Possible duplicates",
    dupLines,
    "",
    "### Required info checklist",
    requiredInfoList(args.question).map((x) => `- [ ] ${x}`).join("\n"),
  ].join("\n");
}

function buildSlackBlocks(args: {
  likelyIssue: string;
  steps: Array<{ n: number; text: string; url: string }>;
  requiredInfo: string[];
  runbookHits: Ranked[];
  duplicates: LinearIssue[];
  duplicatesOverflow?: number;
  engOnly: boolean;
  actionId: string;
}): any[] {
  const stepsText = args.steps.length > 0
    ? args.steps.map((s) => `${s.n}. <${s.url}|${s.text}>`).join("\n")
    : "• (no safe CS steps found)";

  const reqInfoText = args.requiredInfo.slice(0, 8).map((x) => `• ${x}`).join(
    "\n",
  );

  const citations = args.runbookHits.length > 0
    ? args.runbookHits
        .slice(0, 4)
        .map((h) => {
          const label = shortStepFromChunkText(h.chunk.text, h.chunk.pageTitle);
          return `• <${h.chunk.url}|${h.chunk.pageTitle}> — ${label}`;
        })
        .join("\n")
    : "• (none)";

  // Build related tickets text (already filtered and selected upstream)
  let dupText: string;
  if (args.duplicates.length === 0) {
    dupText = "• None found";
  } else {
    const lines = args.duplicates
      .map((d) => `• <${d.url}|${d.identifier}> — ${d.title} (${d.state?.name || "Unknown"})`);
    if (args.duplicatesOverflow && args.duplicatesOverflow > 0) {
      lines.push(`• …and ${args.duplicatesOverflow} more matching ticket${args.duplicatesOverflow === 1 ? "" : "s"}`);
    }
    dupText = lines.join("\n");
  }

  const engOnlyNote = args.engOnly
    ? "This looks engineering-only (DB/scripts/etc.). I'm not going to paraphrase those steps. Escalate with the runbook links below."
    : "If the steps don't resolve it, collect the info below and escalate.";

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Likely Issue*\n• ${args.likelyIssue}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*What to Try*\n${stepsText}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*If This Doesn't Resolve*\n• ${engOnlyNote}\n\n*Required info to collect*\n${reqInfoText}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Runbook sources (top)*\n${citations}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Related tickets in Linear*\n${dupText}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "File ENG ticket (CS Requests)" },
          style: "primary",
          action_id: "create_linear_ticket",
          value: args.actionId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Don't file — I'll try more" },
          action_id: "dismiss",
          value: "dismiss",
        },
      ],
    },
  ];
}

// Main orchestration
export async function answerQuestion(
  question: string,
  slackUser?: string,
  slackChannel?: string,
  opts: AnswerOpts = {},
): Promise<{ blocks: any[]; isHelp: boolean }> {
  // 0) Help/capabilities should never hit runbooks.
  if (isHelpQuery(question)) {
    return { blocks: buildHelpBlocks(), isHelp: true };
  }

  // IMPORTANT: never crawl Notion here. If index isn't ready, fail fast.
  const { chunks } = await buildIndex(false, { allowNotion: false });

  // 1) Retrieve + rank runbook chunks
  const hits = rank(question, chunks, 6);
  const hitChunks = hits.map((h) => h.chunk);

  const engOnly = isEngineeringOnly(hitChunks);

  // 2) Build CS-safe steps
  const steps: Array<{ n: number; text: string; url: string }> = [];
  if (hits.length === 0) {
    // no steps; handled by likelyIssue + escalation guidance
  } else if (engOnly) {
    steps.push({
      n: 1,
      text: "Open the runbook reference (engineering procedure)",
      url: hits[0].chunk.url,
    });
  } else {
    const preferred = hitChunks.filter((c) => c.codeSignals < 10);
    const candidates = preferred.length ? preferred : hitChunks;

    const used = new Set<string>();
    for (const c of candidates) {
      if (steps.length >= 5) break;

      const label = shortStepFromChunkText(c.text, c.pageTitle);
      const key = `${c.url}::${label}`;
      if (used.has(key)) continue;

      used.add(key);
      steps.push({ n: steps.length + 1, text: label, url: c.url });
    }
  }

  // 3) Likely issue + required info
  const likelyIssue = hits.length > 0
    ? `Related runbook: *${hits[0].chunk.pageTitle}*`
    : "I'm not sure — I couldn't find a relevant runbook page.";
  const requiredInfo = requiredInfoList(question);

  // 4) Linear duplicates (optional + time-bounded)
  const includeLinear = opts.includeLinear === true;
  const linearTimeoutMs = opts.linearTimeoutMs ?? LINEAR_TIMEOUT_MS;

  // Runbook-embedded references (cheap; no API call)
  const embeddedRefs = uniq(hitChunks.flatMap((c) => c.ticketRefs));
  const embeddedAsIssues: LinearIssue[] = embeddedRefs.slice(0, 3).map((
    url,
    idx,
  ) => ({
    id: `embedded-${idx}`,
    identifier: "RELATED",
    title: "Referenced in runbook",
    url,
    state: null,
  }));

  let duplicates: LinearIssue[] = [];
  let duplicatesOverflow = 0;

  if (includeLinear) {
    try {
      const teamId = await withTimeout(
        getLinearTeamIdByKey(LINEAR_TEAM_KEY),
        linearTimeoutMs,
        "linear team lookup",
      );

      const found = await withTimeout(
        searchLinearIssues(question, teamId),
        linearTimeoutMs,
        "linear search",
      );

      // Combine embedded refs with Linear search, deduplicate, then filter and select
      const combined = uniqByUrlOrId([...embeddedAsIssues, ...found]);
      const { selected, overflow } = selectHighlyRelevantIssues(question, combined);
      duplicates = selected;
      duplicatesOverflow = overflow;
    } catch (e) {
      console.warn(
        "Linear duplicate search timed out/failed:",
        String((e as any)?.message || e),
      );
      // Fall back to filtered embedded refs only
      const { selected, overflow } = selectHighlyRelevantIssues(question, embeddedAsIssues);
      duplicates = selected;
      duplicatesOverflow = overflow;
    }
  } else {
    // No Linear search, use filtered embedded refs only
    const { selected, overflow } = selectHighlyRelevantIssues(question, embeddedAsIssues);
    duplicates = selected;
    duplicatesOverflow = overflow;
  }

  // 5) Escalation payload (stored server-side)
  const ticketTitle = `[CS] ${question.slice(0, 90)}${
    question.length > 90 ? "…" : ""
  }`;

  const ticketDescription = buildTicketDescription({
    question,
    slackUser,
    slackChannel,
    runbookHits: hits,
    duplicates,
  });

  const actionId = await putAction({
    title: ticketTitle,
    description: ticketDescription,
  });

  const blocks = buildSlackBlocks({
    likelyIssue,
    steps,
    requiredInfo,
    runbookHits: hits,
    duplicates,
    duplicatesOverflow,
    engOnly,
    actionId,
  });

  return { blocks, isHelp: false };
}

// main.ts — Entry point + routing (Val Town HTTP val)
//
// Single file implementation for Val Town.
// All business logic consolidated here.

import { mustEnv, BLOB_KEY, LINEAR_API_KEY, LINEAR_TEAM_KEY, LINEAR_LABEL_NAME, LINEAR_TIMEOUT_MS } from "./env.ts";
import { json, text } from "./util/response.ts";
import {
  buildIndex,
  getCache,
  blobGetIndex,
  blob,
  BLOB_KEY as INDEX_BLOB_KEY,
} from "./storage/indexStore.ts";
import { blob as actionBlob, ACTION_BLOB_PREFIX, putAction, consumeAction } from "./storage/actionStore.ts";
import { rank, isEngineeringOnly } from "./retrieval/rank.ts";
import { slackApi, verifySlackSignature } from "./slack/api.ts";
import { retrieveAndClassify, enhanceWithLLM } from "./classifier/index.ts";
import type { ClassifierResult } from "./types/index.ts";

// ============================================================================
// Types
// ============================================================================

type Chunk = {
  pageId: string;
  pageTitle: string;
  sectionTitle: string;
  text: string;
  url: string;
  ticketRefs: string[];
  codeSignals: number;
};

type Ranked = { chunk: Chunk; score: number };

type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state?: { name: string; type: string } | null;
};

type DirectorDecision = {
  kind: "capabilities" | "runbook" | "no_relevant";
  reason: string;
  query: string;
  hits: Ranked[];
};

type LlmSummary = {
  summary: string;
  recommendation: "file_ticket" | "try_steps";
};

type AnswerOpts = {
  includeLinear?: boolean;
  linearTimeoutMs?: number;
};

// ============================================================================
// Utilities
// ============================================================================

function uniq<T>(a: T[]): T[] {
  return Array.from(new Set(a));
}

function normalize(q: string): string {
  return q.toLowerCase().replaceAll('"', "").trim();
}

function tokenize(raw: string): string[] {
  return normalize(raw)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 40);
}

function safeParseJson<T>(s: string): T | null {
  try {
    // Try to extract JSON from markdown code blocks if present
    const jsonMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    const toParse = jsonMatch ? jsonMatch[1].trim() : s.trim();
    return JSON.parse(toParse) as T;
  } catch {
    return null;
  }
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout: ${label} after ${ms}ms`)),
      ms,
    ) as unknown as number;
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ============================================================================
// Director: Determines response type
// ============================================================================

const CAPABILITIES_PATTERNS = [
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
  "/help",
];

function isCapabilitiesQuery(q: string): boolean {
  const norm = normalize(q);
  if (!norm) return true; // empty query -> show capabilities
  return CAPABILITIES_PATTERNS.some((p) => norm.includes(p));
}

const RELEVANCE_SCORE_THRESHOLD = 2;

async function director(question: string, chunks: Chunk[]): Promise<DirectorDecision> {
  const query = normalize(question);

  // Check for capabilities/help queries first
  if (isCapabilitiesQuery(question)) {
    return {
      kind: "capabilities",
      reason: "help or capabilities request",
      query,
      hits: [],
    };
  }

  // Rank runbook hits
  const hits = rank(question, chunks, 5);

  // Check if we have any relevant content
  if (hits.length === 0) {
    return {
      kind: "no_relevant",
      reason: "no runbook hits",
      query,
      hits: [],
    };
  }

  // Check if top score is below threshold
  if (hits[0].score < RELEVANCE_SCORE_THRESHOLD) {
    return {
      kind: "no_relevant",
      reason: `top score ${hits[0].score} below threshold ${RELEVANCE_SCORE_THRESHOLD}`,
      query,
      hits,
    };
  }

  return {
    kind: "runbook",
    reason: "found relevant runbook content",
    query,
    hits,
  };
}

// ============================================================================
// LLM Functions (Anthropic)
// ============================================================================

const DEFAULT_MODEL = "claude-3-5-sonnet-20240620";

async function callAnthropic(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 500,
): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  const model = Deno.env.get("ANTHROPIC_MODEL") || DEFAULT_MODEL;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!res.ok) {
      console.error("Anthropic API error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const content = data?.content?.[0]?.text;
    return content || null;
  } catch (e) {
    console.error("Anthropic call failed:", e);
    return null;
  }
}

async function llmSummarize(question: string, hits: Ranked[]): Promise<LlmSummary> {
  // Fallback if no API key
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    const fallbackSummary = hits.length > 0
      ? `Check the "${hits[0].chunk.pageTitle}" runbook for steps to address this issue.`
      : "I couldn't find a clear match. Review the runbook links below.";
    return { summary: fallbackSummary, recommendation: "try_steps" };
  }

  // Build context from top hits (max ~400 chars each)
  const context = hits.slice(0, 3).map((h, i) => {
    const excerpt = h.chunk.text.slice(0, 400).replaceAll("\n", " ");
    return `[${i + 1}] Title: ${h.chunk.pageTitle} | Section: ${h.chunk.sectionTitle}\nExcerpt: ${excerpt}`;
  }).join("\n\n");

  const systemPrompt = `You are a CS support assistant. Based on runbook excerpts, provide a brief summary and recommendation.
Respond ONLY with valid JSON in this exact format:
{"summary": "...", "recommendation": "try_steps" or "file_ticket"}

Rules:
- summary: 1-3 sentences summarizing what the runbook says to do. Max 600 chars.
- recommendation: "try_steps" if the runbook has actionable CS steps, "file_ticket" if it requires engineering.
- Keep it concise and actionable.
- Do not reveal internal systems, secrets, or code snippets.`;

  const userMessage = `User question: ${question}\n\nRunbook excerpts:\n${context}`;

  const raw = await callAnthropic(systemPrompt, userMessage);
  if (!raw) {
    // Fallback on API failure
    return {
      summary: `Refer to "${hits[0]?.chunk.pageTitle || "runbook"}" for guidance.`,
      recommendation: "try_steps",
    };
  }

  const parsed = safeParseJson<LlmSummary>(raw);
  if (parsed && parsed.summary && parsed.recommendation) {
    // Enforce max length
    const summary = parsed.summary.length > 600
      ? parsed.summary.slice(0, 597) + "..."
      : parsed.summary;
    const rec = parsed.recommendation === "file_ticket" ? "file_ticket" : "try_steps";
    return { summary, recommendation: rec };
  }

  // Parse failed - use raw as summary with fallback rec
  const truncated = raw.length > 600 ? raw.slice(0, 597) + "..." : raw;
  return { summary: truncated, recommendation: "try_steps" };
}

const STATIC_CAPABILITIES = `*CS Helper — what I can do*

I search our Notion CS runbooks and help you find the right steps for customer issues.

• Find runbook steps for common CS issues
• Tell you what info to collect before escalating
• Suggest whether to file an engineering ticket
• Show possible duplicate tickets in Linear
• Link directly to source runbooks

*Try asking like this*
• \`/cs-help finalize pending\`
• \`/cs-help analysis stuck pending\`
• \`/cs-help ModelPrepSyncError after adding a segment\`

Tip: Include specific error messages or symptoms for better matches.`;

async function llmCapabilities(): Promise<string> {
  // Fallback if no API key
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return STATIC_CAPABILITIES;
  }

  const systemPrompt = `You are a CS support bot that searches internal runbooks for customer support teams.
Generate a short, Slack-friendly capabilities message. Use Slack mrkdwn formatting (*bold*, bullet points with •).

Requirements:
- Start with a brief intro line
- List 5-8 bullet points of what you can do
- Keep it under 400 characters total
- Be accurate: you CAN search runbooks, find steps, suggest ticket filing, show duplicates, link sources
- Do NOT claim you can: fix production, deploy code, access private systems, execute scripts, modify databases
- Do NOT mention internal secrets or system names
- End with a usage tip`;

  const raw = await callAnthropic(systemPrompt, "Generate your capabilities message.", 400);
  if (!raw) {
    return STATIC_CAPABILITIES;
  }

  return raw;
}

// ============================================================================
// Linear Integration
// ============================================================================

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
      `Linear error: ${res.status} ${JSON.stringify(j.errors || j).slice(0, 600)}`,
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

async function createLinearTicket(params: {
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
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).map((x) => x.issue);
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
// Response Construction
// ============================================================================

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
  if (q.includes("tracker") || q.includes("monthly") || q.includes("backfill")) {
    base.unshift("Tracker URL + requested breakdown/time buckets + exact questions/metrics");
  }
  return uniq(base);
}

function shortStepFromChunkText(text: string, fallback: string): string {
  const lines = text.split("\n").map((x) => x.trim()).filter((x) => x.length > 0);

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
          return `${i + 1}. ${h.chunk.pageTitle} — ${h.chunk.sectionTitle}\n   ${h.chunk.url}\n   Step label: ${label}\n   score=${h.score} codeSignals=${h.chunk.codeSignals}`;
        })
        .join("\n")
    : "(none)";

  const dupLines = args.duplicates.length > 0
    ? args.duplicates
        .map((d) => `- ${d.identifier} — ${d.title} (${d.state?.name || "Unknown"})\n  ${d.url}`)
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

// Build Slack blocks for capabilities response
function buildCapabilitiesBlocks(capabilitiesText: string): any[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: capabilitiesText } },
  ];
}

// Build Slack blocks for no_relevant response
function buildNoRelevantBlocks(args: {
  question: string;
  requiredInfo: string[];
  actionId?: string;
}): any[] {
  const reqInfoText = args.requiredInfo.slice(0, 6).map((x) => `• ${x}`).join("\n");

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*No strong runbook match found*\n\nI couldn't find a relevant runbook page for your question. This might be a new issue type or require more specific details.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Can you provide more details?*\nTry rephrasing with specific error messages, feature names, or symptoms.\n\n*Info to collect for escalation*\n${reqInfoText}`,
      },
    },
  ];

  if (args.actionId) {
    blocks.push({
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
          text: { type: "plain_text", text: "I'll add more context" },
          action_id: "dismiss",
          value: "dismiss",
        },
      ],
    });
  }

  return blocks;
}

// Build Slack blocks for runbook response with LLM summary
function buildRunbookBlocks(args: {
  summary: string;
  recommendation: "file_ticket" | "try_steps";
  runbookHits: Ranked[];
  duplicates: LinearIssue[];
  requiredInfo: string[];
  engOnly: boolean;
  actionId: string;
}): any[] {
  const citations = args.runbookHits.length > 0
    ? args.runbookHits
        .slice(0, 4)
        .map((h) => {
          const label = shortStepFromChunkText(h.chunk.text, h.chunk.pageTitle);
          return `• <${h.chunk.url}|${h.chunk.pageTitle}> — ${label}`;
        })
        .join("\n")
    : "• (none)";

  const dupText = args.duplicates.length > 0
    ? args.duplicates
        .slice(0, 3)
        .map((d) => `• <${d.url}|${d.identifier}> — ${d.title} (${d.state?.name || "Unknown"})`)
        .join("\n")
    : "• None found";

  const reqInfoText = args.requiredInfo.slice(0, 6).map((x) => `• ${x}`).join("\n");

  const recText = args.recommendation === "file_ticket"
    ? "This likely requires engineering help. Collect the info below and file a ticket."
    : args.engOnly
      ? "This looks engineering-only (DB/scripts). Review the runbook and escalate if needed."
      : "Try the steps in the runbook. If it doesn't resolve, collect info and escalate.";

  const blocks: any[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Summary*\n${args.summary}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Recommendation*\n${recText}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Runbook sources*\n${citations}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Possible duplicates in Linear*\n${dupText}` },
    },
  ];

  if (args.recommendation === "file_ticket" || args.engOnly) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Info to collect for ticket*\n${reqInfoText}` },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "File ENG ticket (CS Requests)" },
        style: args.recommendation === "file_ticket" ? "primary" : undefined,
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
  });

  return blocks;
}

// ============================================================================
// Main Orchestration: answerQuestion
// ============================================================================

async function answerQuestion(
  question: string,
  slackUser?: string,
  slackChannel?: string,
  opts: AnswerOpts = {},
): Promise<{ blocks: any[]; isHelp: boolean; decision: DirectorDecision; llm?: LlmSummary }> {
  // IMPORTANT: never crawl Notion here. If index isn't ready, fail fast.
  const { chunks } = await buildIndex(false, { allowNotion: false });

  // Run director to determine response type
  const decision = await director(question, chunks);

  // A) Capabilities query
  if (decision.kind === "capabilities") {
    const capText = await llmCapabilities();
    return {
      blocks: buildCapabilitiesBlocks(capText),
      isHelp: true,
      decision,
    };
  }

  // B) No relevant runbook content
  if (decision.kind === "no_relevant") {
    const requiredInfo = requiredInfoList(question);

    // Still create an action payload for ticket filing
    const ticketTitle = `[CS] ${question.slice(0, 90)}${question.length > 90 ? "…" : ""}`;
    const ticketDescription = buildTicketDescription({
      question,
      slackUser,
      slackChannel,
      runbookHits: [],
      duplicates: [],
    });
    const actionId = await putAction({
      title: ticketTitle,
      description: ticketDescription,
    });

    return {
      blocks: buildNoRelevantBlocks({ question, requiredInfo, actionId }),
      isHelp: false,
      decision,
      llm: { summary: "No relevant runbook found.", recommendation: "file_ticket" },
    };
  }

  // C) Runbook response
  const hits = decision.hits;
  const hitChunks = hits.map((h) => h.chunk);
  const engOnly = isEngineeringOnly(hitChunks);

  // Get LLM summary
  const llmResult = await llmSummarize(question, hits);

  // Linear duplicates (optional + time-bounded)
  const includeLinear = opts.includeLinear === true;
  const linearTimeoutMs = opts.linearTimeoutMs ?? LINEAR_TIMEOUT_MS;

  // Runbook-embedded references (cheap; no API call)
  const embeddedRefs = uniq(hitChunks.flatMap((c) => c.ticketRefs));
  const embeddedAsIssues: LinearIssue[] = embeddedRefs.slice(0, 3).map((url, idx) => ({
    id: `embedded-${idx}`,
    identifier: "RELATED",
    title: "Referenced in runbook",
    url,
    state: null,
  }));

  let duplicates: LinearIssue[] = embeddedAsIssues;

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

      const dupRanked = rankPossibleDuplicates(question, found);
      duplicates = uniqByUrlOrId([...embeddedAsIssues, ...dupRanked]).slice(0, 3);
    } catch (e) {
      console.warn("Linear duplicate search timed out/failed:", String((e as any)?.message || e));
      duplicates = embeddedAsIssues;
    }
  }

  // Escalation payload (stored server-side)
  const ticketTitle = `[CS] ${question.slice(0, 90)}${question.length > 90 ? "…" : ""}`;
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

  const requiredInfo = requiredInfoList(question);

  const blocks = buildRunbookBlocks({
    summary: llmResult.summary,
    recommendation: llmResult.recommendation,
    runbookHits: hits,
    duplicates,
    requiredInfo,
    engOnly,
    actionId,
  });

  return { blocks, isHelp: false, decision, llm: llmResult };
}

// ============================================================================
// Slack Actions Handler
// ============================================================================

async function handleSlackActions(
  _req: Request,
  rawBody: string,
): Promise<Response> {
  const form = new URLSearchParams(rawBody);
  const payloadStr = form.get("payload");
  if (!payloadStr) return json({ ok: false, error: "Missing payload" }, 400);

  const payload = JSON.parse(payloadStr);
  const action = payload.actions?.[0];
  if (!action) return json({ ok: true });

  const channelId = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const threadTs = payload.message?.thread_ts || messageTs;

  const postThread = async (textMsg: string) => {
    if (!channelId || !threadTs) return;
    await slackApi("chat.postMessage", {
      channel: channelId,
      thread_ts: threadTs,
      text: textMsg,
    });
  };

  const disableButtons = async (textMsg: string) => {
    if (!channelId || !messageTs) return;
    try {
      await slackApi("chat.update", {
        channel: channelId,
        ts: messageTs,
        text: textMsg,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: textMsg } }],
      });
    } catch (e) {
      console.error("chat.update failed (non-fatal):", e);
    }
  };

  if (action.action_id === "dismiss") {
    await postThread(
      "Okay — add more context in this thread and mention @cs-helper to try again.",
    );
    await disableButtons("Dismissed — continue the discussion in-thread.");
    return json({ ok: true });
  }

  if (action.action_id === "create_linear_ticket") {
    const actionId = String(action.value || "").trim();
    if (!actionId) {
      await postThread("⚠️ Missing action id. Please run /cs-help again.");
      return json({ ok: true, missing: true });
    }

    const v = await consumeAction(actionId);
    if (!v) {
      await postThread(
        "That ticket action expired. Please run /cs-help again to regenerate it.",
      );
      await disableButtons("Ticket action expired — rerun /cs-help.");
      return json({ ok: true, expired: true });
    }

    try {
      const created = await createLinearTicket({
        title: v.title,
        description: v.description,
        teamKey: LINEAR_TEAM_KEY,
        labelName: LINEAR_LABEL_NAME,
      });

      await postThread(`✅ Ticket filed: ${created.identifier} — ${created.url}`);
      await disableButtons(`✅ Ticket filed: ${created.identifier} — ${created.url}`);
      return json({ ok: true, created });
    } catch (e) {
      console.error("Linear ticket creation failed:", e);
      await postThread(
        `⚠️ Failed to create ticket. Please try again, or file manually.\nError: ${String((e as any)?.message || e)}`,
      );
      return json({ ok: true, error: String((e as any)?.message || e) });
    }
  }

  return json({ ok: true });
}

// ============================================================================
// Route Handlers
// ============================================================================

async function handleHealth(): Promise<Response> {
  const cache = getCache();
  const ageSec = cache ? Math.floor((Date.now() - cache.builtAtMs) / 1000) : null;

  let indexExists = false;
  try {
    const indexData = await blobGetIndex();
    indexExists = indexData !== null;
  } catch {}

  return json({
    ok: true,
    cached: Boolean(cache),
    cache_age_sec: ageSec,
    chunkCount: cache?.chunks?.length || 0,
    builtAt: cache?.diag?.builtAt || null,
    blobKey: BLOB_KEY,
    indexExists,
  });
}

async function handleRebuild(url: URL): Promise<Response> {
  const force = url.searchParams.get("force") === "1";
  const t0 = Date.now();
  const { chunks, diag, source } = await buildIndex(true || force, {
    allowNotion: true,
  });
  const t1 = Date.now();
  const cache = getCache();
  const age = cache ? Math.floor((Date.now() - cache.builtAtMs) / 1000) : "n/a";
  return text(
    `OK\nchunks=${chunks.length}\ncache_age_sec=${age}\nsource=${source}\nbuiltAt=${diag?.builtAt}\nblobKey=${BLOB_KEY}\nms=${t1 - t0}\n\nTry: /search?q=finalize pending\nTry: /debug\nTry: /rebuild?force=1\n`,
  );
}

async function handleDebug(): Promise<Response> {
  const { diag } = await buildIndex(false, { allowNotion: false });
  return json(diag);
}

async function handleSearch(url: URL): Promise<Response> {
  const q = url.searchParams.get("q") || "";

  // Get chunks without crawling Notion
  const { chunks } = await buildIndex(false, { allowNotion: false });

  // Run director
  const decision = await director(q, chunks);

  // Build response based on director decision
  const response: any = {
    q,
    director: { kind: decision.kind, reason: decision.reason },
    hits: decision.hits.map((h) => ({
      title: h.chunk.pageTitle,
      url: h.chunk.url,
      score: h.score,
    })),
  };

  if (decision.kind === "capabilities") {
    // Return capabilities text, don't rank runbooks
    const capText = await llmCapabilities();
    response.capabilities = capText;
  } else if (decision.kind === "runbook") {
    // Include LLM summary
    const llmResult = await llmSummarize(q, decision.hits);
    response.llm = {
      summary: llmResult.summary,
      recommendation: llmResult.recommendation,
    };
  } else if (decision.kind === "no_relevant") {
    // Short no-relevant summary
    response.llm = {
      summary: "No relevant runbook content found for this query.",
      recommendation: "file_ticket",
    };
  }

  return json(response);
}

async function handleClassify(url: URL): Promise<Response> {
  const q = url.searchParams.get("q") || "";
  const useLLM = url.searchParams.get("llm") === "1";

  if (!q.trim()) {
    return json({
      error: "Missing query parameter 'q'",
      usage: "/classify?q=your+question+here&llm=1",
    }, 400);
  }

  // Get chunks without crawling Notion
  const { chunks } = await buildIndex(false, { allowNotion: false });

  // Run deterministic classification
  const result = retrieveAndClassify(q, chunks, 5);

  // Optionally enhance with LLM
  let finalResult: ClassifierResult = result;
  if (useLLM) {
    const relevantChunks = rank(q, chunks, 5).map((r) => r.chunk);
    finalResult = await enhanceWithLLM(q, relevantChunks, result);
  }

  // Return strict JSON format as specified
  return json(finalResult);
}

// Slack handlers

async function handleSlackCommand(
  _req: Request,
  rawBody: string,
): Promise<Response> {
  const form = new URLSearchParams(rawBody);
  const question = (form.get("text") || "").trim();
  const user_name = form.get("user_name") || "unknown";
  const channel_id = form.get("channel_id") || "";
  const channel_name = form.get("channel_name") || "unknown";

  const ack = new Response(
    JSON.stringify({
      response_type: "ephemeral",
      text: `Working on it… I'll post in a thread in #${channel_name}.`,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );

  (async () => {
    try {
      if (!channel_id) {
        throw new Error("Missing channel_id from Slack command payload.");
      }

      const parent = await slackApi("chat.postMessage", {
        channel: channel_id,
        text: `🧭 CS Helper request from @${user_name}: *${question || "help"}*`,
      });
      const thread_ts = parent.ts;

      const result = await answerQuestion(question, user_name, channel_name, {
        includeLinear: false,
      });

      await slackApi("chat.postMessage", {
        channel: channel_id,
        thread_ts,
        text: "CS helper response",
        blocks: result.blocks,
      });
    } catch (e) {
      console.error("Slash command background error:", e);
      try {
        if (channel_id) {
          await slackApi("chat.postMessage", {
            channel: channel_id,
            text: `⚠️ CS Helper error. Try /rebuild then rerun.\nError: ${String((e as any)?.message || e)}`,
          });
        }
      } catch {}
    }
  })();

  return ack;
}

async function handleSlackEvents(
  _req: Request,
  rawBody: string,
): Promise<Response> {
  const payload = JSON.parse(rawBody);

  if (payload.type === "url_verification") {
    return json({ challenge: payload.challenge });
  }

  if (payload.type !== "event_callback") return json({ ok: true });

  const ev = payload.event;
  if (ev?.bot_id || ev?.subtype === "bot_message") return json({ ok: true });
  if (ev?.type !== "app_mention") return json({ ok: true });

  const channel = ev.channel;
  const ts = ev.ts;
  const thread_ts = ev.thread_ts || ts;
  const user = ev.user || "unknown";
  const question = String(ev.text || "").replace(/<@[^>]+>/g, "").trim();

  try {
    const result = await answerQuestion(question, user, channel, {
      includeLinear: true,
      linearTimeoutMs: 1200,
    });

    await slackApi("chat.postMessage", {
      channel,
      thread_ts,
      text: "CS helper response",
      blocks: result.blocks,
    });

    return json({ ok: true });
  } catch (e) {
    console.error("Slack event handler error:", e);
    await slackApi("chat.postMessage", {
      channel,
      thread_ts,
      text: `⚠️ I hit an error answering that. Try /rebuild then ask again.\nError: ${String((e as any)?.message || e)}`,
    });
    return json({ ok: true, error: String((e as any)?.message || e) });
  }
}

async function handleBlobDebug(): Promise<Response> {
  try {
    const allKeys = await blob.list();
    const indexData = await blobGetIndex();
    const actionKeys = await actionBlob.list(ACTION_BLOB_PREFIX);

    return json({
      ok: true,
      totalBlobs: allKeys.length,
      indexKey: INDEX_BLOB_KEY,
      indexExists: indexData !== null,
      indexChunks: indexData?.chunks?.length || 0,
      indexBuiltAt: indexData?.diag?.builtAt || null,
      actionBlobs: actionKeys.length,
      allBlobKeys: allKeys,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        error: String((e as any)?.message || e),
      },
      500,
    );
  }
}

// ============================================================================
// Main handler (default export required by Val Town)
// ============================================================================

export default async function handler(req: Request): Promise<Response> {
  try {
    mustEnv();
    const url = new URL(req.url);

    // Root
    if (req.method === "GET" && url.pathname === "/") {
      try {
        const { chunks, source } = await buildIndex(false, {
          allowNotion: false,
        });
        const cache = getCache();
        const age = cache ? Math.floor((Date.now() - cache.builtAtMs) / 1000) : "n/a";
        return text(
          `OK\nchunks=${chunks.length}\ncache_age_sec=${age}\nsource=${source}\nblobKey=${BLOB_KEY}\n\nTry: /search?q=finalize pending\nTry: /classify?q=finalize pending&llm=1\nTry: /debug\nTry: /rebuild\n`,
        );
      } catch {
        return text(`Index not ready.\nRun: /rebuild\n`, 200);
      }
    }

    // Basic endpoints
    if (req.method === "GET" && url.pathname === "/health") {
      return await handleHealth();
    }
    if (req.method === "GET" && url.pathname === "/rebuild") {
      return await handleRebuild(url);
    }
    if (req.method === "GET" && url.pathname === "/debug") {
      return await handleDebug();
    }
    if (req.method === "GET" && url.pathname === "/search") {
      return await handleSearch(url);
    }
    if (req.method === "GET" && url.pathname === "/classify") {
      return await handleClassify(url);
    }

    // Slack endpoints (verify signature)
    if (url.pathname === "/slack/command") {
      const rawBody = await req.text();
      const ok = await verifySlackSignature(req, rawBody);
      if (!ok) return text("Bad signature", 401);
      return await handleSlackCommand(req, rawBody);
    }

    if (url.pathname === "/slack/actions") {
      const rawBody = await req.text();
      const ok = await verifySlackSignature(req, rawBody);
      if (!ok) return text("Bad signature", 401);
      return await handleSlackActions(req, rawBody);
    }

    if (url.pathname === "/slack/events") {
      const rawBody = await req.text();
      const ok = await verifySlackSignature(req, rawBody);
      if (!ok) return text("Bad signature", 401);
      return await handleSlackEvents(req, rawBody);
    }

    if (url.pathname === "/slack/debug-command") {
      const rawBody = await req.text();
      return json({
        ok: true,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        rawBody,
      });
    }

    if (url.pathname === "/slack/ping") {
      return new Response("OK", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Debug endpoint
    if (req.method === "GET" && url.pathname === "/blob-debug") {
      return await handleBlobDebug();
    }

    return text("Not found", 404);
  } catch (e: any) {
    console.error(e);
    return text(`Exception: ${e?.stack || e?.message || String(e)}`, 500);
  }
}

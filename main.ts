// main.ts — Entry point + routing (Val Town HTTP val)
// HOW TO VERIFY: 1) Thread follow-ups: /cs-help X, then @cs-helper in thread → single reply
// 2) No dupes: same event_id → logs "DEDUPED" 3) No self-trigger: bot messages ignored
// 4) Fast ACK: /slack/events returns 200 immediately 5) Logs show event_id, thread_ts, dedupe
// Test harness: _test_parseSlackEvent, _test_simulateDedupe (bottom of file)
//
// CRON: /rebuild nightly (0 3 * * *), /warm every 15min (*/15 * * * *) for cache

import { mustEnv, BLOB_KEY, LINEAR_API_KEY, LINEAR_TEAM_KEY, LINEAR_LABEL_NAME, LINEAR_TIMEOUT_MS, BLOB_MAX_AGE_MS, MAX_FOLLOWUPS } from "./env.ts";
import { seenEvent, markEventSeen, seenSlashCommand, markSlashCommandSeen, logRetryHeaders } from "./storage/dedupeStore.ts";
import { json, text } from "./util/response.ts";
import {
  buildIndex,
  getCache,
  blobGetIndex,
  blob,
  BLOB_KEY as INDEX_BLOB_KEY,
} from "./storage/indexStore.ts";
import { blob as actionBlob, ACTION_BLOB_PREFIX, putAction, consumeAction } from "./storage/actionStore.ts";
import {
  threadKey,
  getThreadState,
  putThreadState,
  createOrUpdateThreadState,
  addFollowup,
  expireThreadStates,
  blob as threadBlob,
  THREAD_STATE_BLOB_PREFIX,
} from "./storage/threadStore.ts";
import { rank } from "./retrieval/rank.ts";
import { slackApi, verifySlackSignature } from "./slack/api.ts";
import { classify, retrieveAndClassify, enhanceWithLLM } from "./classifier/index.ts";
import type { ClassifierResult, ThreadState, LlmSummary as LlmSummaryType, FollowupEntry } from "./types/index.ts";

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

// ============================================================================
// Director Types (runs BEFORE any RAG/index work)
// ============================================================================

type RouteDecision =
  | { route: "help" }
  | { route: "answer"; doRag: true }
  | { route: "answer"; doRag: false; reason: string };

type LlmSummary = {
  summary: string;
  recommendation: "file_ticket" | "try_steps";
};

type AnswerOpts = {
  includeLinear?: boolean;
  linearTimeoutMs?: number;
  threadContext?: {
    channelId: string;
    threadTs: string;
  };
};

type AnswerResult = {
  blocks: any[];
  route: RouteDecision;
  llm?: LlmSummary;
  hits: Ranked[];
  ragUsed: boolean;
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
// Director: Routes question BEFORE any RAG/index work
// ============================================================================

const HELP_PATTERNS = [
  // Direct help requests
  /^help$/i,
  /^\/help$/i,
  /^\?$/,
  // Capability questions
  /what\s+can\s+you\s+do/i,
  /what\s+kind\s+of\s+stuff\s+can\s+you\s+do/i,
  /what\s+do\s+you\s+do/i,
  /what\s+are\s+you/i,
  /who\s+are\s+you/i,
  /what\s+is\s+this/i,
  // Usage questions
  /how\s+do\s+i\s+use/i,
  /how\s+to\s+use/i,
  /how\s+does\s+this\s+work/i,
  // Feature/capability queries
  /\bcapabilities\b/i,
  /\bcommands\b/i,
  /\bfeatures\b/i,
  /\bexamples?\b/i,
  /\busage\b/i,
  // Intent questions
  /what\s+should\s+i\s+ask/i,
  /what\s+can\s+i\s+ask/i,
  /what\s+kinds?\s+of\s+things/i,
  /what\s+questions/i,
  /show\s+me\s+examples/i,
  // Greeting-only (no actual question)
  /^(hi|hello|hey|yo|sup)[\s!?.]*$/i,
];

/**
 * Detects help/capabilities queries that should NOT trigger RAG.
 * Returns true for questions like "what can you do", "help", "capabilities", etc.
 */
function isHelpQuery(question: string): boolean {
  const q = normalize(question);

  // Empty or whitespace-only -> show help
  if (!q || q.length === 0) return true;

  // Check against all help patterns
  for (const pattern of HELP_PATTERNS) {
    if (pattern.test(q)) return true;
  }

  return false;
}

/**
 * Director function: runs BEFORE any RAG/index work.
 * Determines whether to show help or proceed with answer flow.
 *
 * IMPORTANT: This function does NOT load the index. It only inspects the question.
 */
async function director(question: string): Promise<RouteDecision> {
  // Check for help queries FIRST - no RAG needed
  if (isHelpQuery(question)) {
    return { route: "help" };
  }

  // Default: proceed to answer flow with RAG
  // The actual index availability is checked later in handleQuestion
  return { route: "answer", doRag: true };
}

// ============================================================================
// Help Content Builders (CEO-friendly)
// ============================================================================

/**
 * Build plain text help content for web endpoints.
 */
function buildHelpText(): string {
  return `CS Helper — Your Customer Support Assistant

I help CS teams quickly find the right runbook steps and triage customer issues.

📋 TRIAGING DELIVERY ISSUES
• "Analysis is stuck in pending state"
• "Finalize not showing up for test"
• "ModelPrepSyncError after adding segment"
• "Survey responses not appearing in tracker"

🔍 FINDING RUNBOOK STEPS
• "How do I reanalyze a test?"
• "Steps to reset participant data"
• "What to check when export fails"

📝 COLLECTING REQUIRED INFO
• "What info do I need for a stuck analysis?"
• "What should I gather before escalating a tracker issue?"

🎫 WHEN TO FILE A TICKET
• Describe the issue and I'll suggest whether to escalate
• I'll help you identify possible duplicate tickets
• I'll pre-fill the ticket with relevant context

💡 Tips:
• Include specific error messages for better matches
• Mention the feature area (tracker, analysis, export, etc.)
• Describe what the customer is trying to do`;
}

/**
 * Build Slack blocks for help response.
 */
function buildHelpBlocks(): any[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*CS Helper — Your Customer Support Assistant*\n\nI help CS teams quickly find the right runbook steps and triage customer issues.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*📋 Triaging Delivery Issues*\n• `analysis is stuck in pending state`\n• `finalize not showing up for test`\n• `ModelPrepSyncError after adding segment`\n• `survey responses not appearing in tracker`",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*🔍 Finding Runbook Steps*\n• `how do I reanalyze a test?`\n• `steps to reset participant data`\n• `what to check when export fails`",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*📝 Collecting Required Info*\n• `what info do I need for a stuck analysis?`\n• `what should I gather before escalating?`",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*🎫 When to File a Ticket*\n• Describe the issue and I'll suggest whether to escalate\n• I'll help identify possible duplicate tickets\n• I'll pre-fill the ticket with relevant context",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "💡 *Tip:* Include specific error messages, feature area, and what the customer is trying to do for better matches.",
        },
      ],
    },
  ];
}

// ============================================================================
// Slack Modal Builder (for follow-up input)
// ============================================================================

/**
 * Build a Slack modal for follow-up question input.
 * @param channelId - The channel ID for thread context
 * @param threadTs - The thread timestamp for context
 * @returns Modal view object for Slack views.open
 */
function buildFollowupModal(channelId: string, threadTs: string): any {
  return {
    type: "modal",
    callback_id: "followup_modal_submit",
    private_metadata: JSON.stringify({ channelId, threadTs }),
    title: {
      type: "plain_text",
      text: "Ask a follow-up",
    },
    submit: {
      type: "plain_text",
      text: "Send",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Ask a follow-up question about this issue. I'll search the same runbooks and provide additional guidance.",
        },
      },
      {
        type: "input",
        block_id: "followup_input_block",
        element: {
          type: "plain_text_input",
          action_id: "followup_text",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "e.g., What if the customer already tried refreshing? How do I check the diagnostics page?",
          },
        },
        label: {
          type: "plain_text",
          text: "Follow-up question",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "💡 *Tip:* Be specific about what you need clarification on. Include error messages or symptoms if relevant.",
          },
        ],
      },
    ],
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

/**
 * LLM summarize with support for no-context mode.
 * @param question - The user's question
 * @param hits - Ranked runbook hits (can be empty)
 * @param noContextReason - If provided, tells LLM there's no runbook context
 */
async function llmSummarize(
  question: string,
  hits: Ranked[],
  noContextReason?: string,
): Promise<LlmSummary> {
  const hasContext = hits.length > 0 && !noContextReason;

  // Fallback if no API key
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    if (hasContext) {
      return {
        summary: `Check the "${hits[0].chunk.pageTitle}" runbook for steps to address this issue.`,
        recommendation: "try_steps",
      };
    }
    return {
      summary: noContextReason
        ? `I couldn't search the runbooks (${noContextReason}). Please describe the issue in more detail or check with your team lead.`
        : "I couldn't find a clear match. Please provide more details about the issue.",
      recommendation: "file_ticket",
    };
  }

  // Build context from top hits (max ~400 chars each)
  let contextSection: string;
  if (hasContext) {
    contextSection = hits.slice(0, 3).map((h, i) => {
      const excerpt = h.chunk.text.slice(0, 400).replaceAll("\n", " ");
      return `[${i + 1}] Title: ${h.chunk.pageTitle} | Section: ${h.chunk.sectionTitle}\nExcerpt: ${excerpt}`;
    }).join("\n\n");
  } else {
    contextSection = noContextReason
      ? `NO RUNBOOK CONTEXT AVAILABLE. Reason: ${noContextReason}`
      : "NO RUNBOOK MATCHES FOUND for this query.";
  }

  const systemPrompt = `You are a CS support assistant. Based on runbook excerpts (if available), provide a brief summary and recommendation.
Respond ONLY with valid JSON in this exact format:
{"summary": "...", "recommendation": "try_steps" or "file_ticket"}

Rules:
- summary: 1-3 sentences summarizing what to do. Max 600 chars.
- If runbook context is available: summarize the steps from the runbook.
- If NO runbook context: acknowledge this and suggest next steps (gather info, escalate, etc.)
- recommendation: "try_steps" if there are actionable CS steps, "file_ticket" if it needs engineering or no steps are clear.
- Keep it concise and actionable.
- Do not reveal internal systems, secrets, or code snippets.`;

  const userMessage = `User question: ${question}\n\nRunbook context:\n${contextSection}`;

  const raw = await callAnthropic(systemPrompt, userMessage);
  if (!raw) {
    // Fallback on API failure
    if (hasContext) {
      return {
        summary: `Refer to "${hits[0]?.chunk.pageTitle || "runbook"}" for guidance.`,
        recommendation: "try_steps",
      };
    }
    return {
      summary: "Unable to generate summary. Please describe the issue in detail for manual review.",
      recommendation: "file_ticket",
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

  // Parse failed - extract summary from raw text
  const truncated = raw.length > 600 ? raw.slice(0, 597) + "..." : raw;
  return { summary: truncated, recommendation: hasContext ? "try_steps" : "file_ticket" };
}

/**
 * LLM summarize for follow-up questions.
 * Includes conversation history and previous context.
 */
async function llmSummarizeFollowup(
  rootQuestion: string,
  followups: FollowupEntry[],
  currentFollowup: string,
  hits: Ranked[],
): Promise<LlmSummary> {
  const hasContext = hits.length > 0;

  // Fallback if no API key
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    if (hasContext) {
      return {
        summary: `Based on the "${hits[0].chunk.pageTitle}" runbook, here's what I found for your follow-up.`,
        recommendation: "try_steps",
      };
    }
    return {
      summary: "I couldn't find specific runbook content for your follow-up question.",
      recommendation: "file_ticket",
    };
  }

  // Build conversation history (last 3 follow-ups max)
  const recentFollowups = followups.slice(-3);
  const historySection = recentFollowups.length > 0
    ? recentFollowups.map((f, i) => `[Follow-up ${i + 1}]: ${f.text}`).join("\n")
    : "(no previous follow-ups)";

  // Build context from top hits
  const contextSection = hasContext
    ? hits.slice(0, 3).map((h, i) => {
        const excerpt = h.chunk.text.slice(0, 400).replaceAll("\n", " ");
        return `[${i + 1}] Title: ${h.chunk.pageTitle} | Section: ${h.chunk.sectionTitle}\nExcerpt: ${excerpt}`;
      }).join("\n\n")
    : "NO RUNBOOK MATCHES FOUND for this query.";

  const systemPrompt = `You are a CS support assistant answering a follow-up question in a conversation thread.

Context:
- The user originally asked a question about a customer issue
- They are now asking a follow-up to clarify or dig deeper
- Use the runbook excerpts to provide actionable guidance

Respond ONLY with valid JSON in this exact format:
{"summary": "...", "recommendation": "try_steps" or "file_ticket"}

Rules:
- summary: 1-3 sentences answering the follow-up question. Max 600 chars.
- Reference the runbook sources when applicable.
- Build on the conversation context - don't repeat basic info already covered.
- recommendation: "try_steps" if there are actionable CS steps, "file_ticket" if it needs engineering.
- Keep it concise and actionable.`;

  const userMessage = `Original question: ${rootQuestion}

Previous follow-ups:
${historySection}

Current follow-up question: ${currentFollowup}

Runbook context:
${contextSection}`;

  const raw = await callAnthropic(systemPrompt, userMessage);
  if (!raw) {
    return {
      summary: hasContext
        ? `Refer to "${hits[0]?.chunk.pageTitle || "runbook"}" for more details.`
        : "Unable to generate follow-up response.",
      recommendation: hasContext ? "try_steps" : "file_ticket",
    };
  }

  const parsed = safeParseJson<LlmSummary>(raw);
  if (parsed && parsed.summary && parsed.recommendation) {
    const summary = parsed.summary.length > 600
      ? parsed.summary.slice(0, 597) + "..."
      : parsed.summary;
    const rec = parsed.recommendation === "file_ticket" ? "file_ticket" : "try_steps";
    return { summary, recommendation: rec };
  }

  const truncated = raw.length > 600 ? raw.slice(0, 597) + "..." : raw;
  return { summary: truncated, recommendation: hasContext ? "try_steps" : "file_ticket" };
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
 *
 * Removes issues where:
 * - state.type is "completed" or "canceled"
 * - state.name contains "duplicate" (case-insensitive)
 *
 * Defensive for null/undefined state.
 */
function filterRelevantOpenIssues(issues: LinearIssue[]): LinearIssue[] {
  return issues.filter((issue) => {
    const stateType = issue.state?.type?.toLowerCase() || "";
    const stateName = issue.state?.name?.toLowerCase() || "";

    // Exclude completed/canceled
    if (stateType === "completed" || stateType === "canceled") {
      return false;
    }

    // Exclude duplicates (by state name)
    if (stateName.includes("duplicate")) {
      return false;
    }

    return true;
  });
}

type ScoredIssue = { issue: LinearIssue; score: number };

/**
 * Score issues by relevance to the query.
 * Uses token overlap + state boosts.
 */
function scoreIssues(query: string, issues: LinearIssue[]): ScoredIssue[] {
  const qTokens = new Set(tokenize(query));
  return issues.map((issue) => {
    const tTokens = tokenize(issue.title);
    let sim = 0;
    for (const t of tTokens) if (qTokens.has(t)) sim += 1;

    // Boost active issues
    const st = issue.state?.type || "";
    let stateBoost = 0;
    if (st === "started") stateBoost = 2;
    if (st === "unstarted") stateBoost = 1;

    return { issue, score: sim + stateBoost };
  });
}

/**
 * Select highly relevant open issues for display.
 *
 * Returns:
 * - All issues with score >= HIGH_RELEVANCE_SCORE, capped at MAX_RELATED_TICKETS
 * - If none meet threshold, returns top FALLBACK_TOP_N by score
 * - Also returns overflow count (additional high-relevance issues not shown)
 */
function selectHighlyRelevantIssues(
  query: string,
  issues: LinearIssue[],
): { selected: LinearIssue[]; overflow: number } {
  // Filter out closed/canceled/duplicate
  const filtered = filterRelevantOpenIssues(issues);

  if (filtered.length === 0) {
    return { selected: [], overflow: 0 };
  }

  // Score remaining issues
  const scored = scoreIssues(query, filtered);

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Find highly relevant issues (score >= threshold)
  const highlyRelevant = scored.filter((s) => s.score >= HIGH_RELEVANCE_SCORE);

  if (highlyRelevant.length > 0) {
    // Return up to MAX_RELATED_TICKETS of highly relevant issues
    const selected = highlyRelevant.slice(0, MAX_RELATED_TICKETS).map((s) => s.issue);
    const overflow = Math.max(0, highlyRelevant.length - MAX_RELATED_TICKETS);
    return { selected, overflow };
  }

  // Fallback: no high-relevance issues, return top N by score
  const selected = scored.slice(0, FALLBACK_TOP_N).map((s) => s.issue);
  return { selected, overflow: 0 };
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

// Build Slack blocks for no_relevant response
function buildNoRelevantBlocks(args: {
  question: string;
  requiredInfo: string[];
  llmSummary?: string;
  actionId?: string;
  threadKey?: string; // channelId:threadTs for follow-up button
}): any[] {
  const reqInfoText = args.requiredInfo.slice(0, 6).map((x) => `• ${x}`).join("\n");

  const summaryText = args.llmSummary
    ? `*Summary*\n${args.llmSummary}\n\n`
    : "";

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*No strong runbook match found*\n\n${summaryText}I couldn't find a relevant runbook page for your question. This might be a new issue type or require more specific details.`,
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

  // Build action buttons
  const actionElements: any[] = [];

  // Add follow-up button if threadKey is provided
  if (args.threadKey) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Ask a follow-up" },
      action_id: "ask_followup",
      value: args.threadKey,
    });
  }

  if (args.actionId) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "File ENG ticket (CS Requests)" },
      style: "primary",
      action_id: "create_linear_ticket",
      value: args.actionId,
    });
  }

  actionElements.push({
    type: "button",
    text: { type: "plain_text", text: "Dismiss" },
    action_id: "dismiss",
    value: "dismiss",
  });

  if (actionElements.length > 0) {
    blocks.push({
      type: "actions",
      elements: actionElements,
    });
  }

  return blocks;
}

// Build Slack blocks for runbook response with classifier results
function buildRunbookBlocks(args: {
  summary: string;
  classifier: ClassifierResult;
  runbookHits: Ranked[];
  duplicates: LinearIssue[];
  duplicatesOverflow?: number; // Additional matching tickets not shown
  actionId: string;
  threadKey?: string; // channelId:threadTs for follow-up button
}): any[] {
  const { classifier } = args;

  // Build classification header
  const canHandle = classifier.can_cs_handle;
  const classificationText = canHandle
    ? `*CS can handle this* (${classifier.confidence} confidence)`
    : `*Escalate to Engineering* (${classifier.confidence} confidence)`;

  // Build reasons
  const reasonsText = classifier.reasons.slice(0, 3).map((r) => `• ${r}`).join("\n");

  // Build CS-safe steps (only if CS can handle)
  const stepsText = canHandle && classifier.cs_safe_steps.length > 0
    ? classifier.cs_safe_steps.slice(0, 5).map((s, i) => `${i + 1}. ${s}`).join("\n")
    : null;

  // Build escalation info (always show if not CS-handlable, or as backup)
  const escalationText = classifier.escalation_info_needed.slice(0, 6).map((x) => `• ${x}`).join("\n");

  // Build citations from evidence
  const citations = classifier.evidence.length > 0
    ? classifier.evidence
        .slice(0, 4)
        .map((e) => `• <${e.url}|${e.pageTitle}> — ${e.sectionTitle}`)
        .join("\n")
    : args.runbookHits.length > 0
      ? args.runbookHits
          .slice(0, 4)
          .map((h) => `• <${h.chunk.url}|${h.chunk.pageTitle}>`)
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

  const blocks: any[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${classificationText}\n\n*Summary*\n${args.summary}` },
    },
  ];

  // Show reasons for classification
  if (reasonsText) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Why?*\n${reasonsText}` },
    });
  }

  // Show CS-safe steps if CS can handle
  if (stepsText) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Steps CS can take*\n${stepsText}` },
    });
  }

  // Show escalation info if engineer required
  if (!canHandle) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Info to collect for escalation*\n${escalationText}` },
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Runbook sources*\n${citations}` },
  });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Related tickets in Linear*\n${dupText}` },
  });

  // Build action buttons
  const actionElements: any[] = [];

  // Add follow-up button first if threadKey is provided
  if (args.threadKey) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Ask a follow-up" },
      action_id: "ask_followup",
      value: args.threadKey,
    });
  }

  // Add file ticket button (primary if engineer required)
  actionElements.push({
    type: "button",
    text: { type: "plain_text", text: "File ENG ticket (CS Requests)" },
    style: !canHandle ? "primary" : undefined,
    action_id: "create_linear_ticket",
    value: args.actionId,
  });

  // Add dismiss button
  actionElements.push({
    type: "button",
    text: { type: "plain_text", text: canHandle ? "Resolved — no ticket needed" : "Dismiss" },
    action_id: "dismiss",
    value: "dismiss",
  });

  blocks.push({
    type: "actions",
    elements: actionElements,
  });

  return blocks;
}

// Build Slack blocks for follow-up response
function buildFollowupBlocks(args: {
  followupQuestion: string;
  summary: string;
  recommendation: "file_ticket" | "try_steps";
  runbookHits: Ranked[];
  actionId: string;
  threadKey: string;
}): any[] {
  const citations = args.runbookHits.length > 0
    ? args.runbookHits
        .slice(0, 3)
        .map((h) => `• <${h.chunk.url}|${h.chunk.pageTitle}>`)
        .join("\n")
    : "• (none found)";

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Follow-up:* ${args.followupQuestion}\n\n*Answer*\n${args.summary}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Runbook sources*\n${citations}`,
      },
    },
  ];

  // Build action buttons
  const actionElements: any[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "Ask another follow-up" },
      action_id: "ask_followup",
      value: args.threadKey,
    },
  ];

  // Only show file ticket button if recommendation is file_ticket
  if (args.recommendation === "file_ticket") {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "File ENG ticket" },
      style: "primary",
      action_id: "create_linear_ticket",
      value: args.actionId,
    });
  }

  actionElements.push({
    type: "button",
    text: { type: "plain_text", text: "Done" },
    action_id: "dismiss",
    value: "dismiss",
  });

  blocks.push({
    type: "actions",
    elements: actionElements,
  });

  return blocks;
}

// Build ticket description with follow-up history
function buildTicketDescriptionWithFollowups(args: {
  question: string;
  slackUser?: string;
  slackChannel?: string;
  runbookHits: Ranked[];
  duplicates: LinearIssue[];
  followups: FollowupEntry[];
  lastSummary: string;
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

  // Build follow-up conversation trail
  const followupLines = args.followups.length > 0
    ? args.followups.map((f, i) =>
        `**Follow-up ${i + 1}** (by ${f.user} at ${new Date(f.ts).toISOString()}):\n${f.text}`
      ).join("\n\n")
    : "(none)";

  return [
    "## CS Escalation",
    "",
    `**Slack user:** ${args.slackUser || "unknown"}`,
    `**Slack channel:** ${args.slackChannel || "unknown"}`,
    "",
    "### Original Question",
    args.question,
    "",
    "### Follow-up Conversation",
    followupLines,
    "",
    "### Bot Summary",
    args.lastSummary,
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

// ============================================================================
// Main Orchestration: handleQuestion
// ============================================================================

const RELEVANCE_SCORE_THRESHOLD = 2;

/**
 * Unified question handler used by both web and Slack endpoints.
 * Director runs FIRST, then RAG/index only if needed.
 */
async function handleQuestion(
  question: string,
  slackUser?: string,
  slackChannel?: string,
  opts: AnswerOpts = {},
): Promise<AnswerResult> {
  // Build thread key for follow-up button if thread context is provided
  const threadKeyStr = opts.threadContext
    ? `${opts.threadContext.channelId}:${opts.threadContext.threadTs}`
    : undefined;

  // STEP 1: Run director BEFORE any RAG/index work
  const routeDecision = await director(question);

  // STEP 2: If help route, return help immediately (NO RAG, NO index loading)
  if (routeDecision.route === "help") {
    return {
      blocks: buildHelpBlocks(),
      route: routeDecision,
      hits: [],
      ragUsed: false,
    };
  }

  // STEP 3: Try to load index for RAG
  let chunks: Chunk[] = [];
  let indexAvailable = false;
  let noContextReason: string | undefined;

  try {
    // IMPORTANT: never crawl Notion here. If index isn't ready, degrade gracefully.
    const result = await buildIndex(false, { allowNotion: false });
    chunks = result.chunks;
    indexAvailable = chunks.length > 0;
  } catch (e) {
    // Index not available - degrade gracefully
    noContextReason = "runbook index not available";
    console.warn("Index not available:", String((e as any)?.message || e));
  }

  // STEP 4: If no index, update route decision
  let finalRoute: RouteDecision = routeDecision;
  if (!indexAvailable) {
    finalRoute = { route: "answer", doRag: false, reason: noContextReason || "index empty" };
  }

  // STEP 5: Rank runbook hits (if index available)
  const hits = indexAvailable ? rank(question, chunks, 5) : [];
  const ragUsed = hits.length > 0 && hits[0].score >= RELEVANCE_SCORE_THRESHOLD;

  // Update route if no relevant hits
  if (indexAvailable && !ragUsed) {
    if (hits.length === 0) {
      finalRoute = { route: "answer", doRag: false, reason: "no runbook matches" };
    } else {
      finalRoute = { route: "answer", doRag: false, reason: `top score ${hits[0].score} below threshold ${RELEVANCE_SCORE_THRESHOLD}` };
    }
  }

  // STEP 6A: No relevant runbook content
  if (!ragUsed) {
    const requiredInfo = requiredInfoList(question);

    // Get LLM summary (handles no-context mode)
    const llmResult = await llmSummarize(
      question,
      [],
      (finalRoute as any).reason || "no matches",
    );

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

    // Save thread state if thread context provided
    if (opts.threadContext) {
      await createOrUpdateThreadState({
        channelId: opts.threadContext.channelId,
        threadTs: opts.threadContext.threadTs,
        rootQuestion: question,
        rootUser: slackUser || "unknown",
        hits: [],
        llm: llmResult,
        ticketDraft: ticketDescription,
      });
    }

    return {
      blocks: buildNoRelevantBlocks({
        question,
        requiredInfo,
        llmSummary: llmResult.summary,
        actionId,
        threadKey: threadKeyStr,
      }),
      route: finalRoute,
      llm: llmResult,
      hits: [],
      ragUsed: false,
    };
  }

  // STEP 6B: Runbook response with RAG
  const hitChunks = hits.map((h) => h.chunk);

  // Run the classifier on the relevant chunks
  const classifierResult = classify(question, hitChunks);

  // Optionally enhance with LLM (if API key available)
  const enhancedClassifier = await enhanceWithLLM(question, hitChunks, classifierResult);

  // Get LLM summary for the response
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
      console.warn("Linear duplicate search timed out/failed:", String((e as any)?.message || e));
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

  // Save thread state if thread context provided
  if (opts.threadContext) {
    await createOrUpdateThreadState({
      channelId: opts.threadContext.channelId,
      threadTs: opts.threadContext.threadTs,
      rootQuestion: question,
      rootUser: slackUser || "unknown",
      hits: hits,
      llm: llmResult,
      ticketDraft: ticketDescription,
    });
  }

  const blocks = buildRunbookBlocks({
    summary: llmResult.summary,
    classifier: enhancedClassifier,
    runbookHits: hits,
    duplicates,
    duplicatesOverflow,
    actionId,
    threadKey: threadKeyStr,
  });

  return {
    blocks,
    route: { route: "answer", doRag: true },
    llm: llmResult,
    hits,
    ragUsed: true,
  };
}

// ============================================================================
// Handle Follow-up Questions in Thread
// ============================================================================

const LLM_FOLLOWUP_TIMEOUT_MS = 8000; // 8s timeout for follow-up LLM calls

/**
 * Handle a follow-up question within an existing thread.
 * Loads thread state, runs RAG with combined context, and posts response.
 */
async function handleFollowupInThread(params: {
  channelId: string;
  threadTs: string;
  user: string;
  followupText: string;
}): Promise<{ blocks: any[]; llm: LlmSummary; actionId: string } | { error: string }> {
  const { channelId, threadTs, user, followupText } = params;

  // Load existing thread state
  const state = await getThreadState(channelId, threadTs);
  if (!state) {
    return {
      error: "Thread context expired or not found. Please start a new question.",
    };
  }

  // Check if this is a help query
  if (isHelpQuery(followupText)) {
    return {
      blocks: buildHelpBlocks(),
      llm: { summary: "Help information", recommendation: "try_steps" },
      actionId: "",
    };
  }

  // Try to load index for RAG
  let chunks: Chunk[] = [];
  try {
    const result = await buildIndex(false, { allowNotion: false });
    chunks = result.chunks;
  } catch (e) {
    console.warn("Index not available for follow-up:", String((e as any)?.message || e));
  }

  // Combine root question + follow-up for ranking
  const combinedQuery = `${state.rootQuestion} ${followupText}`;
  const hits = chunks.length > 0 ? rank(combinedQuery, chunks, 5) : state.lastHits;

  // Get LLM summary for follow-up
  let llmResult: LlmSummary;
  try {
    llmResult = await withTimeout(
      llmSummarizeFollowup(state.rootQuestion, state.followups, followupText, hits),
      LLM_FOLLOWUP_TIMEOUT_MS,
      "llmSummarizeFollowup",
    );
  } catch (e) {
    console.warn("LLM follow-up timeout:", String((e as any)?.message || e));
    llmResult = {
      summary: hits.length > 0
        ? `Check "${hits[0].chunk.pageTitle}" for more details on your follow-up question.`
        : "I couldn't generate a follow-up response. Please try rephrasing your question.",
      recommendation: hits.length > 0 ? "try_steps" : "file_ticket",
    };
  }

  // Build updated ticket draft with follow-up history
  const newFollowup: FollowupEntry = {
    user,
    text: followupText,
    ts: Date.now(),
  };

  const updatedFollowups = [...state.followups, newFollowup].slice(-MAX_FOLLOWUPS);

  const ticketDraft = buildTicketDescriptionWithFollowups({
    question: state.rootQuestion,
    slackUser: state.rootUser,
    slackChannel: channelId,
    runbookHits: hits,
    duplicates: [],
    followups: updatedFollowups,
    lastSummary: llmResult.summary,
  });

  // Create action payload for ticket
  const ticketTitle = `[CS] ${state.rootQuestion.slice(0, 90)}${state.rootQuestion.length > 90 ? "…" : ""}`;
  const actionId = await putAction({
    title: ticketTitle,
    description: ticketDraft,
  });

  // Update thread state
  await addFollowup(channelId, threadTs, newFollowup, hits, llmResult, ticketDraft);

  // Build response blocks
  const threadKeyStr = `${channelId}:${threadTs}`;
  const blocks = buildFollowupBlocks({
    followupQuestion: followupText,
    summary: llmResult.summary,
    recommendation: llmResult.recommendation,
    runbookHits: hits,
    actionId,
    threadKey: threadKeyStr,
  });

  return { blocks, llm: llmResult, actionId };
}

// ============================================================================
// Slack Actions Handler
// ============================================================================

const SLACK_API_TIMEOUT_MS = 2500; // 2.5s timeout for Slack API calls

async function handleSlackActions(
  _req: Request,
  rawBody: string,
): Promise<Response> {
  const form = new URLSearchParams(rawBody);
  const payloadStr = form.get("payload");
  if (!payloadStr) return json({ ok: false, error: "Missing payload" }, 400);

  const payload = JSON.parse(payloadStr);

  // Handle modal submission (view_submission)
  if (payload.type === "view_submission") {
    return await handleModalSubmission(payload);
  }

  // Handle button actions (block_actions)
  const action = payload.actions?.[0];
  if (!action) return json({ ok: true });

  const channelId = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const threadTs = payload.message?.thread_ts || messageTs;
  const triggerId = payload.trigger_id;

  const postThread = async (textMsg: string) => {
    if (!channelId || !threadTs) return;
    try {
      await withTimeout(
        slackApi("chat.postMessage", {
          channel: channelId,
          thread_ts: threadTs,
          text: textMsg,
        }),
        SLACK_API_TIMEOUT_MS,
        "postThread",
      );
    } catch (e) {
      console.error("postThread failed:", e);
    }
  };

  const disableButtons = async (textMsg: string) => {
    if (!channelId || !messageTs) return;
    try {
      await withTimeout(
        slackApi("chat.update", {
          channel: channelId,
          ts: messageTs,
          text: textMsg,
          blocks: [{ type: "section", text: { type: "mrkdwn", text: textMsg } }],
        }),
        SLACK_API_TIMEOUT_MS,
        "disableButtons",
      );
    } catch (e) {
      console.error("chat.update failed (non-fatal):", e);
    }
  };

  // Handle "Ask a follow-up" button click - open modal
  if (action.action_id === "ask_followup") {
    const threadKeyValue = String(action.value || "").trim();
    if (!threadKeyValue || !triggerId) {
      await postThread("⚠️ Could not open follow-up dialog. Please try again.");
      return json({ ok: true, error: "missing_thread_key_or_trigger" });
    }

    // Parse channelId:threadTs from value
    const [modalChannelId, modalThreadTs] = threadKeyValue.split(":");
    if (!modalChannelId || !modalThreadTs) {
      await postThread("⚠️ Invalid thread context. Please start a new question.");
      return json({ ok: true, error: "invalid_thread_key" });
    }

    try {
      // Open the follow-up modal
      await withTimeout(
        slackApi("views.open", {
          trigger_id: triggerId,
          view: buildFollowupModal(modalChannelId, modalThreadTs),
        }),
        SLACK_API_TIMEOUT_MS,
        "views.open",
      );
      return json({ ok: true, modal_opened: true });
    } catch (e) {
      console.error("Failed to open follow-up modal:", e);
      await postThread("⚠️ Could not open follow-up dialog. Please try again.");
      return json({ ok: true, error: String((e as any)?.message || e) });
    }
  }

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

/**
 * Handle modal submission for follow-up questions.
 */
async function handleModalSubmission(payload: any): Promise<Response> {
  // Validate callback_id
  if (payload.view?.callback_id !== "followup_modal_submit") {
    return json({ ok: true });
  }

  // Extract private_metadata (channelId + threadTs)
  let channelId: string;
  let threadTs: string;
  try {
    const metadata = JSON.parse(payload.view?.private_metadata || "{}");
    channelId = metadata.channelId;
    threadTs = metadata.threadTs;
  } catch {
    console.error("Failed to parse modal private_metadata");
    return json({
      response_action: "errors",
      errors: { followup_input_block: "Internal error. Please try again." },
    });
  }

  if (!channelId || !threadTs) {
    return json({
      response_action: "errors",
      errors: { followup_input_block: "Thread context missing. Please start a new question." },
    });
  }

  // Extract follow-up text from input
  const followupText = payload.view?.state?.values?.followup_input_block?.followup_text?.value || "";
  if (!followupText.trim()) {
    return json({
      response_action: "errors",
      errors: { followup_input_block: "Please enter a follow-up question." },
    });
  }

  const user = payload.user?.username || payload.user?.id || "unknown";

  // ACK the modal immediately (close it)
  // Then process the follow-up asynchronously
  (async () => {
    try {
      // Post a "thinking" message first
      await slackApi("chat.postMessage", {
        channel: channelId,
        thread_ts: threadTs,
        text: `_Processing follow-up: "${followupText.slice(0, 50)}${followupText.length > 50 ? "..." : ""}"_`,
      });

      // Handle the follow-up
      const result = await handleFollowupInThread({
        channelId,
        threadTs,
        user,
        followupText: followupText.trim(),
      });

      if ("error" in result) {
        await slackApi("chat.postMessage", {
          channel: channelId,
          thread_ts: threadTs,
          text: `⚠️ ${result.error}`,
        });
        return;
      }

      // Post the follow-up response
      await slackApi("chat.postMessage", {
        channel: channelId,
        thread_ts: threadTs,
        text: "Follow-up response",
        blocks: result.blocks,
      });
    } catch (e) {
      console.error("Follow-up processing error:", e);
      try {
        await slackApi("chat.postMessage", {
          channel: channelId,
          thread_ts: threadTs,
          text: `⚠️ Error processing follow-up: ${String((e as any)?.message || e)}`,
        });
      } catch {}
    }
  })();

  // Return empty response to close the modal
  return json({ response_action: "clear" });
}

// ============================================================================
// Route Handlers
// ============================================================================

async function handleHealth(): Promise<Response> {
  const cache = getCache();
  const memCacheAgeSec = cache ? Math.floor((Date.now() - cache.builtAtMs) / 1000) : null;

  // Check blob status
  let blobPresent = false;
  let blobAgeSec: number | null = null;
  let blobStale = false;
  let blobBuiltAt: string | null = null;
  let chunkCount = 0;

  try {
    const indexData = await blobGetIndex();
    if (indexData) {
      blobPresent = true;
      const blobAgeMs = Date.now() - indexData.builtAtMs;
      blobAgeSec = Math.floor(blobAgeMs / 1000);
      blobStale = blobAgeMs > BLOB_MAX_AGE_MS;
      blobBuiltAt = indexData.diag?.builtAt || null;
      chunkCount = indexData.chunks?.length || 0;
    }
  } catch {}

  // Use cache chunk count if available, otherwise use blob chunk count
  if (cache?.chunks?.length) {
    chunkCount = cache.chunks.length;
  }

  return json({
    ok: true,
    cached: Boolean(cache),
    mem_cache_age_sec: memCacheAgeSec,
    chunkCount,
    blob_present: blobPresent,
    blob_age_sec: blobAgeSec,
    builtAt: blobBuiltAt || cache?.diag?.builtAt || null,
    stale: blobStale,
    blobKey: BLOB_KEY,
  });
}

// /warm endpoint: Cheap cache warming from blob (no Notion crawl)
// Use this endpoint for periodic cache warming (e.g., every 15-30 minutes)
// It loads from blob if available, refreshes in-memory cache, and returns health info
async function handleWarm(): Promise<Response> {
  try {
    // Try to load from blob (no Notion crawl)
    const { chunks, diag, source, stale, blobAgeMs } = await buildIndex(false, {
      allowNotion: false,
    });

    return json({
      ok: true,
      warmed: true,
      source,
      chunkCount: chunks.length,
      builtAt: diag?.builtAt || null,
      stale: stale || false,
      blob_age_sec: blobAgeMs ? Math.floor(blobAgeMs / 1000) : null,
      blobKey: BLOB_KEY,
    });
  } catch (e) {
    // Blob doesn't exist - that's fine, just report it
    return json({
      ok: false,
      warmed: false,
      error: "No blob index found. Run /rebuild to create one.",
      blobKey: BLOB_KEY,
    });
  }
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

const LLM_SEARCH_TIMEOUT_MS = 12000; // 12s timeout for LLM calls in /search

async function handleSearch(url: URL): Promise<Response> {
  const q = url.searchParams.get("q") || "";

  // Follow-up mode params (for debugging without Slack)
  const threadChannel = url.searchParams.get("thread_channel");
  const threadTsParam = url.searchParams.get("thread_ts");
  const followupText = url.searchParams.get("followup");

  // If follow-up params provided, simulate follow-up behavior
  if (threadChannel && threadTsParam && followupText) {
    const result = await handleFollowupInThread({
      channelId: threadChannel,
      threadTs: threadTsParam,
      user: "search_debug",
      followupText,
    });

    if ("error" in result) {
      return json({
        q,
        followup: true,
        error: result.error,
      });
    }

    return json({
      q,
      followup: true,
      llm: result.llm,
      thread_channel: threadChannel,
      thread_ts: threadTsParam,
    });
  }

  // STEP 1: Run director BEFORE any RAG/index work
  const routeDecision = await director(q);

  // STEP 2: If help route, return help immediately (NO RAG, NO index loading)
  if (routeDecision.route === "help") {
    return json({
      q,
      route: "help",
      rag_used: false,
      help_text: buildHelpText(),
      examples: [
        "analysis is stuck in pending state",
        "finalize not showing up for test",
        "how do I reanalyze a test?",
        "what info do I need for a stuck analysis?",
      ],
    });
  }

  // STEP 3: Try to get chunks (don't throw if unavailable)
  let chunks: Chunk[] = [];
  let stale: boolean | undefined;
  let blobAgeMs: number | undefined;
  let noContextReason: string | undefined;

  try {
    const result = await buildIndex(false, { allowNotion: false });
    chunks = result.chunks;
    stale = result.stale;
    blobAgeMs = result.blobAgeMs;
  } catch (e) {
    noContextReason = "runbook index not available";
    console.warn("Index not available for /search:", String((e as any)?.message || e));
  }

  // STEP 4: Rank hits (if index available)
  const hits = chunks.length > 0 ? rank(q, chunks, 5) : [];
  const ragUsed = hits.length > 0 && hits[0].score >= RELEVANCE_SCORE_THRESHOLD;

  // Determine actual no-context reason
  if (!noContextReason && !ragUsed) {
    if (hits.length === 0) {
      noContextReason = "no runbook matches";
    } else {
      noContextReason = `top score ${hits[0].score} below threshold ${RELEVANCE_SCORE_THRESHOLD}`;
    }
  }

  // Build response
  const response: any = {
    q,
    route: "answer",
    rag_used: ragUsed,
    hits: hits.map((h) => ({
      title: h.chunk.pageTitle,
      section: h.chunk.sectionTitle,
      url: h.chunk.url,
      score: h.score,
    })),
  };

  // Include cache staleness info
  if (stale !== undefined) {
    response.cache_stale = stale;
  }
  if (blobAgeMs !== undefined) {
    response.cache_age_sec = Math.floor(blobAgeMs / 1000);
  }

  // Always include LLM summary for /search
  try {
    const llmResult = await withTimeout(
      llmSummarize(q, ragUsed ? hits : [], noContextReason),
      LLM_SEARCH_TIMEOUT_MS,
      "llmSummarize",
    );
    response.llm = {
      summary: llmResult.summary,
      recommendation: llmResult.recommendation,
    };
  } catch (e) {
    // Fallback on timeout/error
    response.llm = {
      summary: ragUsed
        ? `Refer to "${hits[0]?.chunk.pageTitle || "runbook"}" for guidance.`
        : "Unable to generate summary. Please provide more details.",
      recommendation: ragUsed ? "try_steps" : "file_ticket",
    };
    response.llm_error = String((e as any)?.message || e);
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
  req: Request,
  rawBody: string,
): Promise<Response> {
  const form = new URLSearchParams(rawBody);
  const question = (form.get("text") || "").trim();
  const user_name = form.get("user_name") || "unknown";
  const channel_id = form.get("channel_id") || "";
  const channel_name = form.get("channel_name") || "unknown";
  const trigger_id = form.get("trigger_id") || "";

  // Log retry headers if present
  logRetryHeaders(req, "slack/command");

  console.log(`[slack/command] trigger_id=${trigger_id}, channel=${channel_id}, question="${question.slice(0, 50)}..."`);

  // STEP 1: Run director BEFORE any RAG/index work
  const routeDecision = await director(question);

  // STEP 2: If help route, respond ephemeral only (no parent post, no RAG)
  if (routeDecision.route === "help") {
    return new Response(
      JSON.stringify({
        response_type: "ephemeral",
        blocks: buildHelpBlocks(),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  // STEP 3: For answer routes, ACK and process in background
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
      // DEDUPE CHECK: Skip if we've already processed this trigger_id
      if (trigger_id && await seenSlashCommand(trigger_id)) {
        console.log(`[slack/command] DEDUPED: trigger_id=${trigger_id} already processed`);
        return;
      }

      // Mark as seen BEFORE processing to prevent double-post
      if (trigger_id) {
        await markSlashCommandSeen(trigger_id);
        console.log(`[slack/command] Marked trigger_id=${trigger_id} as seen`);
      }

      if (!channel_id) {
        throw new Error("Missing channel_id from Slack command payload.");
      }

      const parent = await slackApi("chat.postMessage", {
        channel: channel_id,
        text: `🧭 CS Helper request from @${user_name}: *${question}*`,
      });
      const thread_ts = parent.ts;

      // Pass thread context so follow-up button works
      const result = await handleQuestion(question, user_name, channel_name, {
        includeLinear: false,
        threadContext: {
          channelId: channel_id,
          threadTs: thread_ts,
        },
      });

      await slackApi("chat.postMessage", {
        channel: channel_id,
        thread_ts,
        text: "CS helper response",
        blocks: result.blocks,
      });
    } catch (e) {
      console.error("[slack/command] Background processing error:", e);
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
  req: Request,
  rawBody: string,
): Promise<Response> {
  const payload = JSON.parse(rawBody);

  // Handle URL verification (Slack setup)
  if (payload.type === "url_verification") {
    return json({ challenge: payload.challenge });
  }

  // Only handle event_callback
  if (payload.type !== "event_callback") return json({ ok: true });

  const ev = payload.event;
  const eventId = payload.event_id || "";

  // Log retry headers if present
  logRetryHeaders(req, "slack/events");

  // Robust self-message filtering:
  // - bot_id present = message from a bot
  // - subtype === "bot_message" = bot message
  // - user missing = system or unknown message
  if (ev?.bot_id || ev?.subtype === "bot_message" || !ev?.user) {
    console.log(`[slack/events] Ignoring: bot_id=${ev?.bot_id}, subtype=${ev?.subtype}, user=${ev?.user}`);
    return json({ ok: true, ignored: "bot_or_system_message" });
  }

  // Only handle app_mention events
  if (ev?.type !== "app_mention") {
    return json({ ok: true, ignored: "not_app_mention" });
  }

  // FAST ACK: Return 200 immediately to prevent Slack retries
  // Then process asynchronously
  const ackResponse = json({ ok: true });

  // Extract event data before async processing
  const channel = ev.channel;
  const ts = ev.ts;
  // Compute reply thread: if this is in a thread, reply there; otherwise start new thread
  const replyThreadTs = ev.thread_ts ?? ts;
  const user = ev.user || "unknown";
  // Strip @mentions and trim
  const question = String(ev.text || "").replace(/<@[^>]+>/g, "").trim();
  // Is this a follow-up in an existing thread?
  const isThreadReply = Boolean(ev.thread_ts);

  console.log(`[slack/events] event_id=${eventId}, channel=${channel}, thread_ts=${replyThreadTs}, isThreadReply=${isThreadReply}, question="${question.slice(0, 50)}..."`);

  // Process in background (non-blocking)
  (async () => {
    try {
      // DEDUPE CHECK: Skip if we've already processed this event
      if (eventId && await seenEvent(eventId)) {
        console.log(`[slack/events] DEDUPED: event_id=${eventId} already processed`);
        return;
      }

      // Mark as seen BEFORE processing to prevent double-post on crash+retry
      if (eventId) {
        await markEventSeen(eventId);
        console.log(`[slack/events] Marked event_id=${eventId} as seen`);
      }

      // Empty question after stripping mentions
      if (!question) {
        await slackApi("chat.postMessage", {
          channel,
          thread_ts: replyThreadTs,
          text: "Hi! I'm CS Helper. Try asking me a question like: `@cs-helper how do I handle a stuck analysis?`\n\nOr type `@cs-helper help` to see what I can do.",
        });
        return;
      }

      // STEP 1: Run director BEFORE any RAG/index work
      const routeDecision = await director(question);

      // STEP 2: If help route, reply with help blocks only (no RAG)
      if (routeDecision.route === "help") {
        await slackApi("chat.postMessage", {
          channel,
          thread_ts: replyThreadTs,
          text: "CS Helper — what I can do",
          blocks: buildHelpBlocks(),
        });
        return;
      }

      // STEP 3: Check if this is a follow-up in an existing thread with saved state
      if (isThreadReply) {
        const existingState = await getThreadState(channel, replyThreadTs);
        if (existingState) {
          console.log(`[slack/events] Thread follow-up detected, using handleFollowupInThread`);
          // This is a follow-up to an existing conversation
          const result = await handleFollowupInThread({
            channelId: channel,
            threadTs: replyThreadTs,
            user,
            followupText: question,
          });

          if ("error" in result) {
            await slackApi("chat.postMessage", {
              channel,
              thread_ts: replyThreadTs,
              text: `⚠️ ${result.error}`,
            });
            return;
          }

          await slackApi("chat.postMessage", {
            channel,
            thread_ts: replyThreadTs,
            text: "Follow-up response",
            blocks: result.blocks,
          });
          return;
        }
      }

      // STEP 4: For new questions (or follow-ups without state), process with RAG
      const result = await handleQuestion(question, user, channel, {
        includeLinear: true,
        linearTimeoutMs: 1200,
        threadContext: {
          channelId: channel,
          threadTs: replyThreadTs,
        },
      });

      await slackApi("chat.postMessage", {
        channel,
        thread_ts: replyThreadTs,
        text: "CS helper response",
        blocks: result.blocks,
      });
    } catch (e) {
      console.error("[slack/events] Background processing error:", e);
      try {
        await slackApi("chat.postMessage", {
          channel,
          thread_ts: replyThreadTs,
          text: `⚠️ I hit an error answering that. Try /rebuild then ask again.\nError: ${String((e as any)?.message || e)}`,
        });
      } catch {}
    }
  })();

  // Return fast ACK immediately
  return ackResponse;
}

async function handleBlobDebug(): Promise<Response> {
  try {
    const allKeys = await blob.list();
    const indexData = await blobGetIndex();
    const actionKeys = await actionBlob.list(ACTION_BLOB_PREFIX);
    const threadKeys = await threadBlob.list(THREAD_STATE_BLOB_PREFIX);

    return json({
      ok: true,
      totalBlobs: allKeys.length,
      indexKey: INDEX_BLOB_KEY,
      indexExists: indexData !== null,
      indexChunks: indexData?.chunks?.length || 0,
      indexBuiltAt: indexData?.diag?.builtAt || null,
      actionBlobs: actionKeys.length,
      threadStateBlobs: threadKeys.length,
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

// Cleanup expired thread states (can be called manually or via cron)
async function handleThreadCleanup(): Promise<Response> {
  try {
    const expiredCount = await expireThreadStates();
    return json({
      ok: true,
      expired: expiredCount,
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
// Self-Test Harness (for validating event parsing/dedupe without Slack calls)
// Usage: import { _test_parseSlackEvent, _test_simulateDedupe } from "./main.ts";
// ============================================================================

type TestEventResult = { shouldIgnore: boolean; ignoreReason?: string; computedThreadTs?: string; extractedQuestion?: string; isThreadReply?: boolean };

/** Test helper: Parse mock Slack event, return computed values (no API calls) */
export function _test_parseSlackEvent(p: { type?: string; event?: { type?: string; bot_id?: string; subtype?: string; user?: string; ts?: string; thread_ts?: string; text?: string } }): TestEventResult {
  if (p.type === "url_verification") return { shouldIgnore: true, ignoreReason: "url_verification" };
  if (p.type !== "event_callback") return { shouldIgnore: true, ignoreReason: "not_event_callback" };
  const ev = p.event;
  if (!ev) return { shouldIgnore: true, ignoreReason: "no_event" };
  if (ev.bot_id) return { shouldIgnore: true, ignoreReason: "has_bot_id" };
  if (ev.subtype === "bot_message") return { shouldIgnore: true, ignoreReason: "bot_message_subtype" };
  if (!ev.user) return { shouldIgnore: true, ignoreReason: "no_user" };
  if (ev.type !== "app_mention") return { shouldIgnore: true, ignoreReason: "not_app_mention" };
  const ts = ev.ts || "";
  return { shouldIgnore: false, computedThreadTs: ev.thread_ts ?? ts, extractedQuestion: String(ev.text || "").replace(/<@[^>]+>/g, "").trim(), isThreadReply: Boolean(ev.thread_ts) };
}

/** Test helper: Simulate dedupe with in-memory Map */
export function _test_simulateDedupe(store: Map<string, number>, eventId: string, ttlMs = 600000): { deduped: boolean; action: "skip" | "process" } {
  const now = Date.now(), seenAt = store.get(eventId);
  if (seenAt !== undefined && now - seenAt <= ttlMs) return { deduped: true, action: "skip" };
  store.set(eventId, now);
  return { deduped: false, action: "process" };
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
          `OK\nchunks=${chunks.length}\ncache_age_sec=${age}\nsource=${source}\nblobKey=${BLOB_KEY}\n\nTry: /search?q=finalize pending\nTry: /search?q=what can you do\nTry: /classify?q=finalize pending&llm=1\nTry: /debug\nTry: /rebuild\n`,
        );
      } catch {
        return text(`Index not ready.\nRun: /rebuild\n`, 200);
      }
    }

    // Basic endpoints
    if (req.method === "GET" && url.pathname === "/health") {
      return await handleHealth();
    }
    if (req.method === "GET" && url.pathname === "/warm") {
      return await handleWarm();
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

    // Thread cleanup endpoint (can be called manually or via cron)
    if (req.method === "GET" && url.pathname === "/thread-cleanup") {
      return await handleThreadCleanup();
    }

    return text("Not found", 404);
  } catch (e: any) {
    console.error(e);
    return text(`Exception: ${e?.stack || e?.message || String(e)}`, 500);
  }
}

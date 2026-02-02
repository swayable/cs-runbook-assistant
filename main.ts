// main.ts — Entry point + routing (Val Town HTTP val)
// HOW TO VERIFY: 1) Thread follow-ups: /cs-help X, then @cs-helper in thread → single reply
// 2) No dupes: same event_id → logs "DEDUPED" 3) No self-trigger: bot messages ignored
// 4) Fast ACK: /slack/events returns 200 immediately 5) Logs show event_id, thread_ts, dedupe
// Test harness: _test_parseSlackEvent, _test_simulateDedupe (bottom of file)
//
// CRON: /rebuild nightly (0 3 * * *), /warm every 15min (*/15 * * * *) for cache

import { mustEnv, BLOB_KEY, BLOB_KEY_V2, LINEAR_TEAM_KEY, LINEAR_LABEL_NAME, LINEAR_TIMEOUT_MS, BLOB_MAX_AGE_MS, MAX_FOLLOWUPS, HYBRID_SEARCH_ENABLED, LLM_DIRECTOR_ENABLED } from "./env.ts";
import { runLLMDirector, extractRunbookMetadata, type DirectorDecision, type RunbookMetadata } from "./director/index.ts";
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
import { rank, rankHybrid } from "./retrieval/rank.ts";
import { slackApi, verifySlackSignature, getThreadContext } from "./slack/api.ts";
import { classify, retrieveAndClassify, enhanceWithLLM } from "./classifier/index.ts";
import type { ClassifierResult, ThreadState, LlmSummary as LlmSummaryType, FollowupEntry, ChunkWithEmbedding } from "./types/index.ts";
import { isV2Index } from "./types/index.ts";
// Extracted modules
import { llmSummarize, llmSummarizeFollowup, type LlmSummary, type Ranked } from "./handlers/llm.ts";
import {
  buildHelpText,
  buildHelpBlocks,
  buildSupportiveBlocks,
  buildFollowupModal,
  requiredInfoList,
  shortStepFromChunkText,
  buildTicketDescription,
  buildNoRelevantBlocks,
  buildRunbookBlocks,
  buildFollowupBlocks,
  buildTicketDescriptionWithFollowups,
  extractLinearUrlsFromChunks,
  type NoMatchDebugInfo,
} from "./handlers/slackBlocks.ts";
import {
  createLinearTicket,
  searchLinearIssues,
  getLinearTeamIdByKey,
  rankPossibleDuplicates,
  uniqByUrlOrId,
  selectHighlyRelevantIssues,
  getRelatedTicketsWithLLM,
  fetchRecentIssues,
  debugLinearTeams,
  type LinearIssue,
  type LLMSelectedIssue,
  type FallbackCause,
} from "./linear/api.ts";
import { searchNotionDirect, docResultToRanked, isNotionConfigured } from "./retrieval/notionSearch.ts";

// ============================================================================
// Types (local types that aren't in extracted modules)
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

type RouteDecision =
  | { route: "help" }
  | { route: "answer"; doRag: true; directorHint?: DirectorDecision }
  | { route: "answer"; doRag: false; reason: string; directorHint?: DirectorDecision };

type AnswerOpts = {
  includeLinear?: boolean;
  linearTimeoutMs?: number;
  threadContext?: {
    channelId: string;
    threadTs: string;
  };
  slackTicketUrls?: string[]; // Linear URLs found in Slack thread
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

/**
 * Log structured search metrics for observability.
 */
function logDirectorMetrics(params: {
  query: string;
  decision: DirectorDecision | null;
  latencyMs: number;
  source: "web" | "slack_command" | "slack_followup";
}): void {
  const { query, decision, latencyMs, source } = params;
  console.log(JSON.stringify({
    event: "director",
    query: query.slice(0, 100),
    intent: decision?.intent || "fallback",
    confidence: decision?.confidence || null,
    in_scope: decision?.in_scope ?? null,
    matched_topics: decision?.matched_topics?.slice(0, 5) || [],
    has_expanded_query: !!decision?.expanded_query,
    latencyMs,
    source,
    enabled: LLM_DIRECTOR_ENABLED,
  }));
}

function logSearchMetrics(params: {
  query: string;
  hits: Ranked[];
  ragUsed: boolean;
  indexVersion: 1 | 2 | null;
  embeddingUsed: boolean;
  latencyMs: number;
  source: "web" | "slack_command" | "slack_followup";
  directorIntent?: string;
  directorLatencyMs?: number;
}): void {
  const { query, hits, ragUsed, indexVersion, embeddingUsed, latencyMs, source, directorIntent, directorLatencyMs } = params;
  console.log(JSON.stringify({
    event: "search",
    query: query.slice(0, 100),
    topScore: hits[0]?.score || null,
    topHitPage: hits[0]?.chunk?.pageTitle || null,
    hitCount: hits.length,
    ragUsed,
    indexVersion,
    embeddingUsed,
    latencyMs,
    directorIntent: directorIntent || null,
    directorLatencyMs: directorLatencyMs || null,
    source,
  }));
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

// NOTE: Fast out-of-scoping behavior REMOVED per requirements.
// We now always attempt retrieval + summarization for all non-help queries.
// This ensures supportive, action-oriented responses even for unclear questions.

/**
 * Director function: runs BEFORE any RAG/index work.
 * Determines whether to show help or proceed with answer flow.
 *
 * IMPORTANT: This function does NOT load the index. It only inspects the question.
 */
// Cache runbook metadata for director (avoid recomputing on every call)
let RUNBOOK_METADATA_CACHE: { metadata: RunbookMetadata; ts: number } | null = null;
const METADATA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getRunbookMetadata(): Promise<RunbookMetadata | null> {
  // Check cache
  if (RUNBOOK_METADATA_CACHE && Date.now() - RUNBOOK_METADATA_CACHE.ts < METADATA_CACHE_TTL_MS) {
    return RUNBOOK_METADATA_CACHE.metadata;
  }

  try {
    const { chunks } = await buildIndex(false, { allowNotion: false });
    if (chunks.length === 0) return null;
    const metadata = extractRunbookMetadata(chunks);
    RUNBOOK_METADATA_CACHE = { metadata, ts: Date.now() };
    return metadata;
  } catch {
    return null;
  }
}

async function director(question: string): Promise<{ route: RouteDecision; directorLatencyMs: number }> {
  // STEP 1: Check for help queries FIRST (fast, deterministic)
  if (isHelpQuery(question)) {
    return { route: { route: "help" }, directorLatencyMs: 0 };
  }

  // NOTE: Fast out-of-scoping behavior REMOVED per requirements.
  // We now always proceed to RAG for all non-help queries to provide
  // supportive, action-oriented responses.

  // STEP 2: Run LLM director if enabled (bounded by timeout)
  const metadata = await getRunbookMetadata();
  const { decision: llmDecision, latencyMs } = await runLLMDirector(question, metadata);

  // STEP 3: Act on LLM decision if available
  if (llmDecision) {
    // Help intent detected by LLM
    if (llmDecision.intent === "help") {
      return { route: { route: "help" }, directorLatencyMs: latencyMs };
    }

    // NOTE: out_of_scope handling REMOVED - we now always attempt RAG
    // Even for "out of scope" queries, we provide supportive responses

    // All queries proceed to RAG with hints
    return {
      route: { route: "answer", doRag: true, directorHint: llmDecision },
      directorLatencyMs: latencyMs,
    };
  }

  // STEP 4: Fallback - proceed to RAG without hints
  return { route: { route: "answer", doRag: true }, directorLatencyMs: latencyMs };
}

// ============================================================================
// Main Orchestration: handleQuestion
// ============================================================================

const RELEVANCE_SCORE_THRESHOLD = 0.20;

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
  console.log(`[handleQuestion] ENTRY: question="${question.slice(0, 50)}..."`);

  // Build thread key for follow-up button if thread context is provided
  const threadKeyStr = opts.threadContext
    ? `${opts.threadContext.channelId}:${opts.threadContext.threadTs}`
    : undefined;

  // STEP 1: Run director BEFORE any RAG/index work
  console.log(`[handleQuestion] STEP 1: Running director...`);
  const { route: routeDecision, directorLatencyMs } = await director(question);
  console.log(`[handleQuestion] Director complete: route=${routeDecision.route}, latency=${directorLatencyMs}ms`);

  // STEP 2: If help route, return help immediately (NO RAG, NO index loading)
  if (routeDecision.route === "help") {
    return {
      blocks: buildHelpBlocks(),
      route: routeDecision,
      hits: [],
      ragUsed: false,
    };
  }

  // NOTE: Early out-of-scope exit REMOVED per requirements.
  // We now always proceed to retrieval for supportive, action-oriented responses.

  // Extract director hint for later use
  const directorHint = "directorHint" in routeDecision ? routeDecision.directorHint : undefined;

  // STEP 3: Try to load index for RAG
  const searchStartTime = Date.now();
  let chunks: Chunk[] = [];
  let indexAvailable = false;
  let noContextReason: string | undefined;
  let indexVersion: 1 | 2 | null = null;

  try {
    // IMPORTANT: never crawl Notion here. If index isn't ready, degrade gracefully.
    const result = await buildIndex(false, { allowNotion: false });
    chunks = result.chunks;
    indexAvailable = chunks.length > 0;
    indexVersion = result.indexVersion;
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

  // STEP 5: Rank runbook hits (if index available) - use hybrid when embeddings available
  const { results: hits, embeddingUsed } = indexAvailable
    ? await rankHybrid(question, chunks as ChunkWithEmbedding[], 5)
    : { results: [], embeddingUsed: false };
  const ragUsed = hits.length > 0 && hits[0].score >= RELEVANCE_SCORE_THRESHOLD;

  // Log search metrics for observability
  logSearchMetrics({
    query: question,
    hits,
    ragUsed,
    indexVersion,
    embeddingUsed,
    latencyMs: Date.now() - searchStartTime,
    source: "slack_command",
    directorIntent: directorHint?.intent,
    directorLatencyMs,
  });

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

    // Build debug info for troubleshooting
    const debugInfo: NoMatchDebugInfo = {
      indexStatus: !indexAvailable ? "not_ready" : chunks.length === 0 ? "empty" : "ready",
      chunkCount: chunks.length,
      tokensExtracted: tokenize(question).slice(0, 10),
      topCandidateScore: hits[0]?.score,
      topCandidateTitle: hits[0]?.chunk?.pageTitle,
      searchUrl: `/search?q=${encodeURIComponent(question)}&debug=1`,
    };

    // Fetch related tickets even for no-match case (helps CS find context)
    let relatedTickets: LLMSelectedIssue[] = [];
    const includeLinear = opts.includeLinear === true;

    if (includeLinear) {
      try {
        const teamId = await withTimeout(
          getLinearTeamIdByKey(LINEAR_TEAM_KEY),
          LINEAR_TIMEOUT_MS,
          "linear team lookup",
        );
        const { tickets } = await getRelatedTicketsWithLLM(
          question,
          teamId,
          LINEAR_TIMEOUT_MS * 2,
          5
        );
        relatedTickets = tickets;
        console.log(`[handleQuestion] No-match case: found ${tickets.length} related tickets`);
      } catch (e) {
        console.warn("Linear ticket fetch failed (no-match case):", String((e as any)?.message || e));
      }
    }

    // Still create an action payload for ticket filing
    const ticketTitle = `[CS] ${question.slice(0, 90)}${question.length > 90 ? "…" : ""}`;
    const ticketDescription = buildTicketDescription({
      question,
      slackUser,
      slackChannel,
      runbookHits: [],
      duplicates: relatedTickets.map((t) => t.issue),
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
        nextActions: llmResult.next_actions,
        actionId,
        threadKey: threadKeyStr,
        directorHint,
        weakHits: hits.length > 0 ? hits : undefined, // Show weak matches if any
        relatedTickets,
        debugInfo,
      }),
      route: finalRoute,
      llm: llmResult,
      hits: [],
      ragUsed: false,
    };
  }

  // STEP 6B: Runbook response with RAG
  console.log(`[handleQuestion] STEP 6B: Starting RAG response build...`);
  const hitChunks = hits.map((h) => h.chunk);

  // Run the classifier on the relevant chunks
  console.log(`[handleQuestion] Running classifier...`);
  const classifierResult = classify(question, hitChunks);
  console.log(`[handleQuestion] Classifier done: can_cs_handle=${classifierResult.can_cs_handle}`);

  // Enhance with LLM (now safe with two-endpoint pattern giving us full execution time)
  console.log(`[handleQuestion] Running enhanceWithLLM...`);
  const enhancedClassifier = await enhanceWithLLM(question, hitChunks, classifierResult);
  console.log(`[handleQuestion] enhanceWithLLM done`);

  // Get LLM summary for the response
  console.log(`[handleQuestion] Starting llmSummarize...`);
  const llmResult = await llmSummarize(question, hits);
  console.log(`[handleQuestion] llmSummarize complete: ${llmResult.summary.slice(0, 50)}...`);

  // Fetch related tickets using LLM selection (last 7 days, no state filtering)
  let relatedTickets: LLMSelectedIssue[] = [];
  const includeLinear = opts.includeLinear === true;
  const linearTimeoutMs = opts.linearTimeoutMs ?? LINEAR_TIMEOUT_MS;

  if (includeLinear) {
    try {
      const teamId = await withTimeout(
        getLinearTeamIdByKey(LINEAR_TEAM_KEY),
        linearTimeoutMs,
        "linear team lookup",
      );

      // Use new LLM-based ticket selection
      const { tickets, source, fallbackCause } = await getRelatedTicketsWithLLM(
        question,
        teamId,
        linearTimeoutMs * 2, // Allow more time for LLM selection
        8
      );
      relatedTickets = tickets;
      console.log(
        `[handleQuestion] Related tickets: ${tickets.length} (source: ${source}` +
        (fallbackCause ? `, fallback: ${fallbackCause}` : "") + ")"
      );
    } catch (e) {
      console.warn("Linear ticket fetch failed:", String((e as any)?.message || e));
      relatedTickets = [];
    }
  }

  // Extract embedded Linear URLs from chunks (for separate display)
  const embeddedTicketUrls = extractLinearUrlsFromChunks(hitChunks);
  console.log(`[handleQuestion] Found ${embeddedTicketUrls.length} embedded ticket URLs in chunks`);

  // Convert relatedTickets to LinearIssue[] for buildTicketDescription
  const ticketIssues = relatedTickets.map((t) => t.issue);

  // Escalation payload (stored server-side)
  const ticketTitle = `[CS] ${question.slice(0, 90)}${question.length > 90 ? "…" : ""}`;
  const ticketDescription = buildTicketDescription({
    question,
    slackUser,
    slackChannel,
    runbookHits: hits,
    duplicates: ticketIssues,
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
    nextActions: llmResult.next_actions,
    recommendation: llmResult.recommendation,
    classifier: enhancedClassifier,
    runbookHits: hits,
    relatedTickets,
    embeddedTicketUrls,
    slackTicketUrls: opts.slackTicketUrls, // Linear URLs from Slack thread
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
  const searchStartTime = Date.now();
  let chunks: Chunk[] = [];
  let indexVersion: 1 | 2 | null = null;
  try {
    const result = await buildIndex(false, { allowNotion: false });
    chunks = result.chunks;
    indexVersion = result.indexVersion;
  } catch (e) {
    console.warn("Index not available for follow-up:", String((e as any)?.message || e));
  }

  // Combine root question + follow-up for ranking - use hybrid when available
  const combinedQuery = `${state.rootQuestion} ${followupText}`;
  const { results: hits, embeddingUsed } = chunks.length > 0
    ? await rankHybrid(combinedQuery, chunks as ChunkWithEmbedding[], 5)
    : { results: state.lastHits, embeddingUsed: false };

  // Log search metrics for observability
  logSearchMetrics({
    query: combinedQuery,
    hits,
    ragUsed: hits.length > 0,
    indexVersion,
    embeddingUsed,
    latencyMs: Date.now() - searchStartTime,
    source: "slack_followup",
  });

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
  let indexVersion: 1 | 2 | null = null;
  let embeddingModel: string | null = null;
  let chunksWithEmbeddings = 0;

  try {
    const indexResult = await blobGetIndex();
    if (indexResult) {
      const { payload, version } = indexResult;
      blobPresent = true;
      indexVersion = version;
      const blobAgeMs = Date.now() - payload.builtAtMs;
      blobAgeSec = Math.floor(blobAgeMs / 1000);
      blobStale = blobAgeMs > BLOB_MAX_AGE_MS;
      blobBuiltAt = payload.diag?.builtAt || null;
      chunkCount = payload.chunks?.length || 0;

      // Extract embedding info from v2 index
      if (isV2Index(payload)) {
        embeddingModel = payload.diag?.embeddingModel || null;
        chunksWithEmbeddings = payload.diag?.chunksEmbedded || 0;
      }
    }
  } catch {}

  // Use cache version if available
  if (cache?.version) {
    indexVersion = cache.version;
  }

  // Use cache chunk count if available, otherwise use blob chunk count
  if (cache?.chunks?.length) {
    chunkCount = cache.chunks.length;
  }

  // Determine if embedding is actually enabled and working
  const embeddingEnabled = HYBRID_SEARCH_ENABLED && indexVersion === 2;

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
    // Embedding status
    embedding_enabled: embeddingEnabled,
    index_version: indexVersion,
    embedding_model: embeddingModel,
    chunks_with_embeddings: chunksWithEmbeddings,
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

  // Query params for search options
  const includeLinear = url.searchParams.get("includeLinear") !== "0"; // Default true
  const summarize = url.searchParams.get("summarize") !== "0"; // Default true
  const debug = url.searchParams.get("debug") === "1";

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
  const { route: routeDecision, directorLatencyMs } = await director(q);

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

  // Extract director hint for later use
  const directorHint = "directorHint" in routeDecision ? routeDecision.directorHint : undefined;

  const searchStartTime = Date.now();
  const tokensExtracted = tokenize(q);

  // STEP 3: Search documents using BOTH methods:
  // a) Try Notion direct search (semantic) - NO blob index required
  // b) Fall back to blob index + keyword matching if available
  let hits: Ranked[] = [];
  let ragUsed = false;
  let indexVersion: 1 | 2 | null = null;
  let searchSource: "notion_direct" | "blob_index" | "both" | "none" = "none";
  let chunkCount = 0;

  // Try Notion direct search first (works from cold start, no /rebuild needed)
  if (isNotionConfigured()) {
    try {
      const { results: notionResults } = await searchNotionDirect(q, 6);
      if (notionResults.length > 0) {
        hits = notionResults.map(docResultToRanked);
        ragUsed = true;
        searchSource = "notion_direct";
      }
    } catch (e) {
      console.warn("[/search] Notion direct search failed:", String((e as any)?.message || e));
    }
  }

  // Fall back to blob index if Notion direct didn't return results
  if (!ragUsed) {
    try {
      const result = await buildIndex(false, { allowNotion: false });
      const chunks = result.chunks;
      indexVersion = result.indexVersion;
      chunkCount = chunks.length;

      if (chunks.length > 0) {
        const { results: blobHits, embeddingUsed } = await rankHybrid(q, chunks as ChunkWithEmbedding[], 6);
        hits = blobHits;
        if (blobHits.length > 0 && blobHits[0].score >= RELEVANCE_SCORE_THRESHOLD) {
          ragUsed = true;
          searchSource = searchSource === "notion_direct" ? "both" : "blob_index";
        }
      }
    } catch (e) {
      console.warn("[/search] Blob index not available:", String((e as any)?.message || e));
    }
  }

  // Extract embedded Linear URLs from hit chunks
  const hitChunks = hits.map((h) => h.chunk);
  const embeddedTicketUrls = extractLinearUrlsFromChunks(hitChunks);

  // Build detailed hits response with snippets
  const hitsResponse = hits.map((h) => {
    const snippet = shortStepFromChunkText(h.chunk.text, h.chunk.sectionTitle);
    return {
      pageTitle: h.chunk.pageTitle,
      sectionTitle: h.chunk.sectionTitle,
      url: h.chunk.url,
      score: h.score,
      snippet,
      codeSignals: h.chunk.codeSignals,
    };
  });

  // Log search metrics
  logSearchMetrics({
    query: q,
    hits,
    ragUsed,
    indexVersion,
    embeddingUsed: searchSource === "notion_direct" || searchSource === "both",
    latencyMs: Date.now() - searchStartTime,
    source: "web",
    directorIntent: directorHint?.intent,
    directorLatencyMs,
  });

  // STEP 4: Get related tickets using LLM selection (if enabled)
  let relatedTickets: Array<{
    identifier: string;
    title: string;
    url: string;
    state: string;
    reason: string;
  }> = [];
  let ticketMeta: {
    source: "llm" | "keyword" | "none";
    fetched: number;
    team: string;
    error: string;
    fallback_cause?: FallbackCause;
  } = { source: "none", fetched: 0, team: LINEAR_TEAM_KEY, error: "" };

  if (includeLinear) {
    try {
      const teamId = await withTimeout(getLinearTeamIdByKey(LINEAR_TEAM_KEY), 3000, "team lookup");
      const { tickets, source, issuesFetched, fallbackCause } = await getRelatedTicketsWithLLM(q, teamId, 8000, 8);
      ticketMeta = {
        source,
        fetched: issuesFetched,
        team: LINEAR_TEAM_KEY,
        error: "",
        fallback_cause: fallbackCause,
      };
      relatedTickets = tickets.map((t) => ({
        identifier: t.issue.identifier,
        title: t.issue.title,
        url: t.issue.url,
        state: t.issue.state?.name || "Unknown",
        reason: t.reason,
      }));
    } catch (e) {
      ticketMeta.error = String((e as any)?.message || e).slice(0, 100);
    }
  }

  // STEP 5: Get LLM summary with next_actions (if enabled)
  let summary = "";
  let recommendation: "file_ticket" | "try_steps" = ragUsed ? "try_steps" : "file_ticket";
  let nextActions: string[] = [];
  let llmError: string | undefined;

  if (summarize) {
    try {
      const llmResult = await withTimeout(
        llmSummarize(q, hits, ragUsed ? undefined : "no runbook matches"),
        LLM_SEARCH_TIMEOUT_MS,
        "llmSummarize",
      );
      summary = llmResult.summary;
      recommendation = llmResult.recommendation;
      nextActions = llmResult.next_actions || [];
    } catch (e) {
      llmError = String((e as any)?.message || e);
      summary = ragUsed
        ? `Refer to "${hitsResponse[0]?.pageTitle || "runbook"}" for guidance.`
        : "I couldn't find specific runbook content, but I can still help. Please provide more details.";
    }
  }

  // Build response with new structure
  const response: Record<string, unknown> = {
    q,
    summary,
    recommendation,
    next_actions: nextActions,
    // Detailed hits with snippets
    hits: hitsResponse,
    // Embedded Linear URLs from chunks (cheap extraction)
    embedded_ticket_urls: embeddedTicketUrls,
    // Linear API search results (when includeLinear=1)
    related_tickets: relatedTickets,
    search_source: searchSource,
    ticket_meta: ticketMeta,
    latency_ms: Date.now() - searchStartTime,
  };

  if (llmError) {
    response.llm_error = llmError;
  }

  // Debug info (when debug=1)
  if (debug) {
    response.debug = {
      tokens_extracted: tokensExtracted,
      index_status: chunkCount > 0 ? "ready" : "not_ready",
      chunk_count: chunkCount,
      index_version: indexVersion,
      top_candidate_score: hits[0]?.score,
      top_candidate_title: hits[0]?.chunk?.pageTitle,
      relevance_threshold: RELEVANCE_SCORE_THRESHOLD,
      rag_used: ragUsed,
      director_latency_ms: directorLatencyMs,
      director_intent: directorHint?.intent,
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
    const { results: rankedHits } = await rankHybrid(q, chunks as ChunkWithEmbedding[], 5);
    const relevantChunks = rankedHits.map((r) => r.chunk);
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
  const { route: routeDecision } = await director(question);

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
      // NOTE: includeLinear enabled to show related tickets in slash command responses
      const result = await handleQuestion(question, user_name, channel_name, {
        includeLinear: true,
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

  // DEDUPE CHECK: Do this synchronously before delegating
  if (eventId && await seenEvent(eventId)) {
    console.log(`[slack/events] DEDUPED: event_id=${eventId} already processed`);
    return json({ ok: true, deduped: true });
  }

  // Mark as seen BEFORE processing to prevent double-post on crash+retry
  if (eventId) {
    await markEventSeen(eventId);
    console.log(`[slack/events] Marked event_id=${eventId} as seen`);
  }

  // Use Val Town's recommended two-endpoint pattern for background processing
  // Fire an unawaited fetch to /slack/process which keeps its own execution context alive
  const processUrl = new URL("/slack/process", req.url).toString();
  console.log(`[slack/events] Delegating to ${processUrl}`);

  // Fire and forget - this creates a NEW request that has its own execution time
  fetch(processUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventId,
      channel,
      replyThreadTs,
      user,
      question,
      isThreadReply,
    }),
  }).catch((e) => console.error("[slack/events] Failed to delegate:", e));

  // Return immediately to Slack
  return json({ ok: true, delegated: true });
}

/**
 * Internal processing endpoint - called by /slack/events to do the actual work.
 * This runs in its own execution context with full time limit.
 */
async function handleSlackProcess(req: Request): Promise<Response> {
  const body = await req.json();
  const { eventId, channel, replyThreadTs, user, question, isThreadReply } = body;

  console.log(`[slack/process] Starting processing for event_id=${eventId}`);

  try {
    // Empty question after stripping mentions
    if (!question) {
      await slackApi("chat.postMessage", {
        channel,
        thread_ts: replyThreadTs,
        text: "Hi! I'm CS Helper. Try asking me a question like: `@cs-helper how do I handle a stuck analysis?`\n\nOr type `@cs-helper help` to see what I can do.",
      });
      return json({ ok: true, empty_question: true });
    }

    // STEP 1: Run director BEFORE any RAG/index work
    const { route: routeDecision } = await director(question);

    // STEP 2: If help route, reply with help blocks only (no RAG)
    if (routeDecision.route === "help") {
      await slackApi("chat.postMessage", {
        channel,
        thread_ts: replyThreadTs,
        text: "CS Helper — what I can do",
        blocks: buildHelpBlocks(),
      });
      return json({ ok: true, route: "help" });
    }

    // NOTE: Early out-of-scope exit REMOVED per requirements.
    // We now always proceed to retrieval for supportive, action-oriented responses.

    // STEP 3: Check if this is a follow-up in an existing thread with saved state
    if (isThreadReply) {
      const existingState = await getThreadState(channel, replyThreadTs);
      if (existingState) {
        console.log(`[slack/process] Thread follow-up detected, using handleFollowupInThread`);
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
          return json({ ok: false, error: result.error });
        }

        await slackApi("chat.postMessage", {
          channel,
          thread_ts: replyThreadTs,
          text: "Follow-up response",
          blocks: result.blocks,
        });
        return json({ ok: true, followup: true });
      }
    }

    // STEP 4: For new questions (or follow-ups without state), process with RAG
    console.log(`[slack/process] Starting handleQuestion...`);

    // Fetch thread context if this is a thread reply (for Linear URLs mentioned in thread)
    let slackTicketUrls: string[] = [];
    if (isThreadReply) {
      try {
        const threadContext = await getThreadContext(channel, replyThreadTs, 10);
        slackTicketUrls = threadContext.linearUrls;
        console.log(`[slack/process] Thread context: ${threadContext.messages.length} messages, ${slackTicketUrls.length} Linear URLs`);
      } catch (e) {
        console.warn("[slack/process] Failed to fetch thread context:", String((e as Error)?.message || e));
      }
    }

    // Post a "thinking" message first so user knows we're working
    let thinkingTs: string | undefined;
    try {
      const thinkingMsg = await slackApi("chat.postMessage", {
        channel,
        thread_ts: replyThreadTs,
        text: "🔍 Searching runbooks and analyzing...",
      });
      thinkingTs = thinkingMsg?.ts;
      console.log(`[slack/process] Thinking message posted: ts=${thinkingTs}`);
    } catch (thinkErr) {
      console.error(`[slack/process] Failed to post thinking message:`, thinkErr);
    }

    // Wrap handleQuestion in a timeout to ensure we don't hang forever
    const HANDLE_QUESTION_TIMEOUT_MS = 50000; // 50 seconds max (we have full execution time now)
    console.log(`[slack/process] About to call handleQuestion...`);
    let result;
    try {
      result = await withTimeout(
        handleQuestion(question, user, channel, {
          includeLinear: true,
          linearTimeoutMs: 1200,
          threadContext: {
            channelId: channel,
            threadTs: replyThreadTs,
          },
          slackTicketUrls, // Pass any Linear URLs found in the thread
        }),
        HANDLE_QUESTION_TIMEOUT_MS,
        "handleQuestion"
      );
      console.log(`[slack/process] handleQuestion complete, posting response...`);
    } catch (handleErr) {
      console.error(`[slack/process] handleQuestion error/timeout:`, handleErr);
      // Post error to Slack instead of silently failing
      await slackApi("chat.postMessage", {
        channel,
        thread_ts: replyThreadTs,
        text: `⚠️ Processing timed out. Please try again or use /rebuild if this persists.\nError: ${String((handleErr as any)?.message || handleErr)}`,
      });
      return json({ ok: false, error: "timeout" });
    }

    // Update the thinking message with the actual response
    if (thinkingTs) {
      try {
        await slackApi("chat.update", {
          channel,
          ts: thinkingTs,
          text: "CS helper response",
          blocks: result.blocks,
        });
      } catch (updateErr) {
        // chat.update can fail if message is too old or deleted - fallback to new message
        console.warn(`[slack/process] chat.update failed, posting new message:`, String((updateErr as Error)?.message || updateErr));
        await slackApi("chat.postMessage", {
          channel,
          thread_ts: replyThreadTs,
          text: "CS helper response",
          blocks: result.blocks,
        });
      }
    } else {
      // No thinking message - post new message
      await slackApi("chat.postMessage", {
        channel,
        thread_ts: replyThreadTs,
        text: "CS helper response",
        blocks: result.blocks,
      });
    }
    console.log(`[slack/process] Response posted successfully`);
    return json({ ok: true, processed: true });
  } catch (e) {
    console.error("[slack/process] Processing error:", e);
    try {
      await slackApi("chat.postMessage", {
        channel,
        thread_ts: replyThreadTs,
        text: `⚠️ I hit an error answering that. Try /rebuild then ask again.\nError: ${String((e as any)?.message || e)}`,
      });
    } catch {}
    return json({ ok: false, error: String((e as any)?.message || e) });
  }
}

async function handleBlobDebug(): Promise<Response> {
  try {
    const allKeys = await blob.list();
    const indexResult = await blobGetIndex();
    const actionKeys = await actionBlob.list(ACTION_BLOB_PREFIX);
    const threadKeys = await threadBlob.list(THREAD_STATE_BLOB_PREFIX);

    return json({
      ok: true,
      totalBlobs: allKeys.length,
      indexKey: INDEX_BLOB_KEY,
      indexExists: indexResult !== null,
      indexChunks: indexResult?.payload?.chunks?.length || 0,
      indexBuiltAt: indexResult?.payload?.diag?.builtAt || null,
      indexVersion: indexResult?.version || null,
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

    // Internal processing endpoint - called by /slack/events to do background work
    // This has its own execution context with full time limit
    if (url.pathname === "/slack/process" && req.method === "POST") {
      return await handleSlackProcess(req);
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

// tests/slackBlocks.test.ts
// Unit tests for Slack block builders - sources and related tickets
//
// Run with: deno test tests/slackBlocks.test.ts --allow-import

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildNoRelevantBlocks,
  buildRunbookBlocks,
  extractLinearUrls,
  extractLinearUrlsFromChunks,
  shortStepFromChunkText,
  type NoMatchDebugInfo,
} from "../handlers/slackBlocks.ts";
import type { Ranked } from "../handlers/llm.ts";
import type { ClassifierResult } from "../types/index.ts";
import type { LLMSelectedIssue } from "../linear/api.ts";

// ============================================================================
// Test Helpers
// ============================================================================

const makeRankedHit = (
  pageTitle: string,
  sectionTitle: string,
  url: string,
  score: number,
  text = "Sample text content"
): Ranked => ({
  chunk: {
    pageId: `page-${pageTitle}`,
    pageTitle,
    sectionTitle,
    text,
    url,
    ticketRefs: [],
    codeSignals: 0,
  },
  score,
});

const makeClassifierResult = (
  canCsHandle: boolean,
  confidence: "high" | "medium" | "low" = "medium"
): ClassifierResult => ({
  can_cs_handle: canCsHandle,
  confidence,
  reasons: ["Test reason 1", "Test reason 2"],
  cs_safe_steps: canCsHandle ? ["Step 1", "Step 2"] : [],
  escalation_info_needed: ["Info 1", "Info 2"],
  evidence: [],
});

const makeLLMSelectedIssue = (
  identifier: string,
  title: string,
  url: string,
  reason: string,
  stateName = "In Progress"
): LLMSelectedIssue => ({
  issue: {
    id: `issue-${identifier}`,
    identifier,
    title,
    url,
    state: { name: stateName, type: "started" },
  },
  reason,
});

// ============================================================================
// extractLinearUrls Tests
// ============================================================================

Deno.test("extractLinearUrls: extracts Linear URLs from text", () => {
  const text = `Check out https://linear.app/team/issue/CS-123 for more details.
  Also see https://linear.app/acme/issue/ENG-456 related issue.`;

  const urls = extractLinearUrls(text);

  assertEquals(urls.length, 2);
  assert(urls.includes("https://linear.app/team/issue/CS-123"));
  assert(urls.includes("https://linear.app/acme/issue/ENG-456"));
});

Deno.test("extractLinearUrls: handles text with no URLs", () => {
  const text = "This is plain text with no URLs.";
  const urls = extractLinearUrls(text);
  assertEquals(urls.length, 0);
});

Deno.test("extractLinearUrls: deduplicates URLs", () => {
  const text = `See https://linear.app/team/issue/CS-123 and again https://linear.app/team/issue/CS-123`;
  const urls = extractLinearUrls(text);
  assertEquals(urls.length, 1);
});

Deno.test("extractLinearUrlsFromChunks: extracts from chunk text and ticketRefs", () => {
  const chunks = [
    {
      text: "Check https://linear.app/team/issue/CS-100 for details",
      ticketRefs: ["https://linear.app/team/issue/CS-200"],
    },
    {
      text: "Another chunk with https://linear.app/team/issue/CS-300",
      ticketRefs: [],
    },
  ];

  const urls = extractLinearUrlsFromChunks(chunks);

  assertEquals(urls.length, 3);
  assert(urls.includes("https://linear.app/team/issue/CS-100"));
  assert(urls.includes("https://linear.app/team/issue/CS-200"));
  assert(urls.includes("https://linear.app/team/issue/CS-300"));
});

// ============================================================================
// shortStepFromChunkText Tests
// ============================================================================

Deno.test("shortStepFromChunkText: extracts action-like lines", () => {
  const text = `
    Context: This is background info
    Go to Settings page and click Export
    Note: Don't forget to save
  `;

  const step = shortStepFromChunkText(text, "Fallback");
  assertEquals(step, "Go to Settings page and click Export");
});

Deno.test("shortStepFromChunkText: uses fallback for junk text", () => {
  const text = `
    Keywords: keyword1, keyword2
    Ticket reference: CS-123
  `;

  const step = shortStepFromChunkText(text, "Fallback step");
  assertEquals(step, "Fallback step");
});

// ============================================================================
// buildNoRelevantBlocks Tests
// ============================================================================

Deno.test("buildNoRelevantBlocks: includes 'Sources: none found' when no hits", () => {
  const blocks = buildNoRelevantBlocks({
    question: "How do I fix analysis stuck?",
    requiredInfo: ["Test URL", "Customer name"],
  });

  const sourcesBlock = blocks.find(
    (b: any) => b.type === "section" && b.text?.text?.includes("*Sources:*")
  );

  assert(sourcesBlock, "Should have a Sources section");
  assert(
    sourcesBlock.text.text.includes("none found"),
    "Sources should say 'none found'"
  );
});

Deno.test("buildNoRelevantBlocks: includes debug info when provided", () => {
  const debugInfo: NoMatchDebugInfo = {
    indexStatus: "ready",
    chunkCount: 100,
    tokensExtracted: ["analysis", "stuck", "pending"],
    topCandidateScore: 1.5,
    topCandidateTitle: "Pending Analysis Guide",
    searchUrl: "/search?q=test&debug=1",
  };

  const blocks = buildNoRelevantBlocks({
    question: "analysis stuck pending",
    requiredInfo: ["Test URL"],
    debugInfo,
  });

  const sourcesBlock = blocks.find(
    (b: any) => b.type === "section" && b.text?.text?.includes("*Sources:*")
  );

  assert(sourcesBlock, "Should have a Sources section");
  assert(
    sourcesBlock.text.text.includes("Searched for:"),
    "Should include tokens searched"
  );
  assert(
    sourcesBlock.text.text.includes("Closest match:"),
    "Should include closest match info"
  );
});

Deno.test("buildNoRelevantBlocks: shows weak hits when provided", () => {
  const weakHits = [
    makeRankedHit("Pending Guide", "Intro", "https://notion.so/1", 1.2),
    makeRankedHit("Analysis FAQ", "Common Issues", "https://notion.so/2", 0.8),
  ];

  const blocks = buildNoRelevantBlocks({
    question: "analysis stuck",
    requiredInfo: [],
    weakHits,
  });

  const sourcesBlock = blocks.find(
    (b: any) => b.type === "section" && b.text?.text?.includes("*Sources*")
  );

  assert(sourcesBlock, "Should have a Sources section");
  assert(
    sourcesBlock.text.text.includes("Pending Guide"),
    "Should include weak hit title"
  );
  assert(
    sourcesBlock.text.text.includes("weak matches"),
    "Should indicate these are weak matches"
  );
});

Deno.test("buildNoRelevantBlocks: includes Related Tickets section", () => {
  const relatedTickets = [
    makeLLMSelectedIssue("CS-123", "Similar stuck issue", "https://linear.app/t/CS-123", "LLM: Similar symptoms"),
  ];

  const blocks = buildNoRelevantBlocks({
    question: "stuck analysis",
    requiredInfo: [],
    relatedTickets,
  });

  const ticketsBlock = blocks.find(
    (b: any) => b.type === "section" && b.text?.text?.includes("*Related tickets")
  );

  assert(ticketsBlock, "Should have a Related tickets section");
  assert(
    ticketsBlock.text.text.includes("CS-123"),
    "Should include ticket identifier"
  );
  assert(
    ticketsBlock.text.text.includes("LLM: Similar symptoms"),
    "Should include reason"
  );
});

Deno.test("buildNoRelevantBlocks: shows 'None found' for empty tickets", () => {
  const blocks = buildNoRelevantBlocks({
    question: "test question",
    requiredInfo: [],
    relatedTickets: [],
  });

  const ticketsBlock = blocks.find(
    (b: any) => b.type === "section" && b.text?.text?.includes("*Related tickets")
  );

  assert(ticketsBlock, "Should have a Related tickets section");
  assert(
    ticketsBlock.text.text.includes("None found"),
    "Should say 'None found' when empty"
  );
});

// ============================================================================
// buildRunbookBlocks Tests
// ============================================================================

Deno.test("buildRunbookBlocks: includes Runbook sources section with snippets", () => {
  const hits = [
    makeRankedHit("Pending Analysis", "Troubleshooting", "https://notion.so/1", 5.0, "Check the diagnostics page"),
    makeRankedHit("Analysis FAQ", "Common Issues", "https://notion.so/2", 3.0, "Verify data sync status"),
  ];

  const blocks = buildRunbookBlocks({
    summary: "Test summary",
    recommendation: "try_steps",
    classifier: makeClassifierResult(true),
    runbookHits: hits,
    relatedTickets: [],
    actionId: "action-123",
  });

  const sourcesBlock = blocks.find(
    (b: any) => b.type === "section" && b.text?.text?.includes("*Runbook sources:*")
  );

  assert(sourcesBlock, "Should have a Runbook sources section");
  assert(
    sourcesBlock.text.text.includes("Pending Analysis"),
    "Should include hit title"
  );
  assert(
    sourcesBlock.text.text.includes("Troubleshooting"),
    "Should include section title"
  );
  assert(
    sourcesBlock.text.text.includes("notion.so/1"),
    "Should include URL"
  );
});

Deno.test("buildRunbookBlocks: shows grouped related tickets", () => {
  const linearTickets = [
    makeLLMSelectedIssue("CS-100", "Similar issue", "https://linear.app/t/CS-100", "LLM: Related"),
    makeLLMSelectedIssue("CS-200", "Another issue", "https://linear.app/t/CS-200", "LLM: Similar error"),
  ];

  const blocks = buildRunbookBlocks({
    summary: "Test summary",
    recommendation: "try_steps",
    classifier: makeClassifierResult(true),
    runbookHits: [],
    relatedTickets: linearTickets,
    embeddedTicketUrls: ["https://linear.app/team/issue/ENG-50"],
    actionId: "action-123",
  });

  const ticketsBlock = blocks.find(
    (b: any) => b.type === "section" && b.text?.text?.includes("*Related tickets:*")
  );

  assert(ticketsBlock, "Should have a Related tickets section");
  assert(
    ticketsBlock.text.text.includes("From runbooks:"),
    "Should group embedded tickets"
  );
  assert(
    ticketsBlock.text.text.includes("ENG-50"),
    "Should include embedded ticket"
  );
  assert(
    ticketsBlock.text.text.includes("From Linear"),
    "Should group Linear tickets"
  );
  assert(
    ticketsBlock.text.text.includes("CS-100"),
    "Should include Linear ticket"
  );
});

Deno.test("buildRunbookBlocks: shows Slack thread tickets when provided", () => {
  const blocks = buildRunbookBlocks({
    summary: "Test summary",
    recommendation: "try_steps",
    classifier: makeClassifierResult(true),
    runbookHits: [],
    relatedTickets: [],
    slackTicketUrls: ["https://linear.app/team/issue/CS-999"],
    actionId: "action-123",
  });

  const ticketsBlock = blocks.find(
    (b: any) => b.type === "section" && b.text?.text?.includes("*Related tickets:*")
  );

  assert(ticketsBlock, "Should have a Related tickets section");
  assert(
    ticketsBlock.text.text.includes("From Slack thread:"),
    "Should group Slack thread tickets"
  );
  assert(
    ticketsBlock.text.text.includes("CS-999"),
    "Should include Slack ticket"
  );
});

Deno.test("buildRunbookBlocks: includes ticket state in display", () => {
  const tickets = [
    makeLLMSelectedIssue("CS-100", "Open issue", "https://linear.app/t/CS-100", "LLM: Test", "In Progress"),
    makeLLMSelectedIssue("CS-200", "Done issue", "https://linear.app/t/CS-200", "LLM: Related", "Done"),
  ];

  const blocks = buildRunbookBlocks({
    summary: "Test summary",
    recommendation: "try_steps",
    classifier: makeClassifierResult(true),
    runbookHits: [],
    relatedTickets: tickets,
    actionId: "action-123",
  });

  const ticketsBlock = blocks.find(
    (b: any) => b.type === "section" && b.text?.text?.includes("*Related tickets:*")
  );

  assert(ticketsBlock, "Should have a Related tickets section");
  assert(
    ticketsBlock.text.text.includes("(In Progress)"),
    "Should show In Progress state"
  );
  assert(
    ticketsBlock.text.text.includes("(Done)"),
    "Should show Done state"
  );
});

Deno.test("buildRunbookBlocks: includes follow-up button when threadKey provided", () => {
  const blocks = buildRunbookBlocks({
    summary: "Test",
    recommendation: "try_steps",
    classifier: makeClassifierResult(true),
    runbookHits: [],
    relatedTickets: [],
    actionId: "action-123",
    threadKey: "C123:1234567890.123456",
  });

  const actionsBlock = blocks.find((b: any) => b.type === "actions");
  assert(actionsBlock, "Should have an actions block");

  const followupButton = actionsBlock.elements?.find(
    (e: any) => e.action_id === "ask_followup"
  );
  assert(followupButton, "Should have follow-up button");
  assertEquals(followupButton.value, "C123:1234567890.123456");
});

console.log("All slackBlocks tests defined. Run with: deno test tests/slackBlocks.test.ts --allow-import");

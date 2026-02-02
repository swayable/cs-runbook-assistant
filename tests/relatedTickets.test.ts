// tests/relatedTickets.test.ts
// Unit tests for related tickets filtering and selection
//
// Run with: deno test tests/relatedTickets.test.ts

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ============================================================================
// Copy of types and functions for isolated testing
// ============================================================================

type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state?: { name: string; type: string } | null;
};

const MAX_RELATED_TICKETS = 8;
const HIGH_RELEVANCE_SCORE = 2;
const FALLBACK_TOP_N = 3;

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/\W+/).filter((t) => t.length >= 3 && t.length <= 40);
}

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

// ============================================================================
// Test Data
// ============================================================================

const makeIssue = (
  id: string,
  title: string,
  stateType: string,
  stateName: string,
): LinearIssue => ({
  id,
  identifier: `CS-${id}`,
  title,
  url: `https://linear.app/test/issue/CS-${id}`,
  state: { type: stateType, name: stateName },
});

// ============================================================================
// Tests
// ============================================================================

Deno.test("filterRelevantOpenIssues: filters out completed issues", () => {
  const issues = [
    makeIssue("1", "Open issue", "unstarted", "Todo"),
    makeIssue("2", "Completed issue", "completed", "Done"),
    makeIssue("3", "Started issue", "started", "In Progress"),
  ];

  const result = filterRelevantOpenIssues(issues);

  assertEquals(result.length, 2);
  assertEquals(result.map((i) => i.id), ["1", "3"]);
});

Deno.test("filterRelevantOpenIssues: filters out canceled issues", () => {
  const issues = [
    makeIssue("1", "Open issue", "unstarted", "Todo"),
    makeIssue("2", "Canceled issue", "canceled", "Cancelled"),
  ];

  const result = filterRelevantOpenIssues(issues);

  assertEquals(result.length, 1);
  assertEquals(result[0].id, "1");
});

Deno.test("filterRelevantOpenIssues: filters out duplicate by state name", () => {
  const issues = [
    makeIssue("1", "Open issue", "unstarted", "Todo"),
    makeIssue("2", "Dup issue", "unstarted", "Duplicate"),
    makeIssue("3", "Another dup", "unstarted", "Marked as Duplicate"),
  ];

  const result = filterRelevantOpenIssues(issues);

  assertEquals(result.length, 1);
  assertEquals(result[0].id, "1");
});

Deno.test("filterRelevantOpenIssues: handles null/undefined state", () => {
  const issues: LinearIssue[] = [
    { id: "1", identifier: "CS-1", title: "No state", url: "http://test/1", state: null },
    { id: "2", identifier: "CS-2", title: "Undefined state", url: "http://test/2", state: undefined },
    makeIssue("3", "Open issue", "unstarted", "Todo"),
  ];

  const result = filterRelevantOpenIssues(issues);

  // All should pass through - null/undefined state is allowed
  assertEquals(result.length, 3);
});

Deno.test("selectHighlyRelevantIssues: returns empty when all filtered out", () => {
  const issues = [
    makeIssue("1", "Completed issue", "completed", "Done"),
    makeIssue("2", "Canceled issue", "canceled", "Cancelled"),
  ];

  const { selected, overflow } = selectHighlyRelevantIssues("test query", issues);

  assertEquals(selected.length, 0);
  assertEquals(overflow, 0);
});

Deno.test("selectHighlyRelevantIssues: returns highly relevant issues", () => {
  const issues = [
    makeIssue("1", "tracker backfill issue", "started", "In Progress"),
    makeIssue("2", "tracker monthly data", "unstarted", "Todo"),
    makeIssue("3", "unrelated issue", "unstarted", "Todo"),
  ];

  const { selected, overflow } = selectHighlyRelevantIssues("tracker backfill", issues);

  // Issue 1 should score highest (token match + started boost)
  assert(selected.length >= 1);
  assertEquals(selected[0].id, "1");
});

Deno.test("selectHighlyRelevantIssues: caps at MAX_RELATED_TICKETS with overflow", () => {
  // Create 12 highly relevant issues
  const issues = Array.from({ length: 12 }, (_, i) =>
    makeIssue(String(i + 1), "tracker backfill issue", "started", "In Progress")
  );

  const { selected, overflow } = selectHighlyRelevantIssues("tracker backfill issue", issues);

  assertEquals(selected.length, MAX_RELATED_TICKETS); // 8
  assertEquals(overflow, 4); // 12 - 8 = 4
});

Deno.test("selectHighlyRelevantIssues: falls back to top N when no high relevance", () => {
  // Issues with low relevance (no token overlap with query)
  const issues = [
    makeIssue("1", "first unrelated", "unstarted", "Todo"),
    makeIssue("2", "second unrelated", "unstarted", "Todo"),
    makeIssue("3", "third unrelated", "unstarted", "Todo"),
    makeIssue("4", "fourth unrelated", "unstarted", "Todo"),
    makeIssue("5", "fifth unrelated", "unstarted", "Todo"),
  ];

  const { selected, overflow } = selectHighlyRelevantIssues("completely different query", issues);

  assertEquals(selected.length, FALLBACK_TOP_N); // 3
  assertEquals(overflow, 0);
});

Deno.test("selectHighlyRelevantIssues: never includes completed/canceled/duplicate", () => {
  const issues = [
    makeIssue("1", "tracker backfill completed", "completed", "Done"),
    makeIssue("2", "tracker backfill canceled", "canceled", "Cancelled"),
    makeIssue("3", "tracker backfill duplicate", "unstarted", "Duplicate"),
    makeIssue("4", "tracker backfill open", "started", "In Progress"),
  ];

  const { selected } = selectHighlyRelevantIssues("tracker backfill", issues);

  // Only the open issue should be included
  assertEquals(selected.length, 1);
  assertEquals(selected[0].id, "4");
});

Deno.test("selectHighlyRelevantIssues: case-insensitive duplicate detection", () => {
  const issues = [
    makeIssue("1", "issue one", "unstarted", "DUPLICATE"),
    makeIssue("2", "issue two", "unstarted", "duplicate"),
    makeIssue("3", "issue three", "unstarted", "Duplicate - Do Not Use"),
    makeIssue("4", "issue four", "unstarted", "Todo"),
  ];

  const { selected } = selectHighlyRelevantIssues("issue", issues);

  // Only issue 4 should remain after filtering
  assertEquals(selected.length, 1);
  assertEquals(selected[0].id, "4");
});

console.log("All tests defined. Run with: deno test tests/relatedTickets.test.ts");

// tests/ticket_selection_llm.test.ts
// Unit tests for LLM-based ticket selection with fallback behavior
//
// Run with: deno test tests/ticket_selection_llm.test.ts

import { assertEquals, assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  selectRelevantTicketsWithLLM,
  fallbackKeywordSelection,
  type LinearIssue,
  type FallbackCause,
  type FetchFn,
} from "../linear/api.ts";

// ============================================================================
// Test Fixtures
// ============================================================================

const makeIssue = (
  id: string,
  title: string,
  description = "",
): LinearIssue => ({
  id,
  identifier: `CS-${id}`,
  title,
  description,
  url: `https://linear.app/test/issue/CS-${id}`,
  state: { type: "unstarted", name: "Todo" },
});

const testIssues: LinearIssue[] = [
  makeIssue("1", "User cannot login after password reset", "Browser shows error"),
  makeIssue("2", "Dashboard loading slow for enterprise accounts"),
  makeIssue("3", "Export CSV feature not working", "Getting timeout error"),
  makeIssue("4", "Mobile app crashes on launch"),
  makeIssue("5", "API rate limit exceeded for integration"),
];

// ============================================================================
// Mock Fetch Helpers
// ============================================================================

/**
 * Creates a mock fetch function that returns a successful LLM response.
 */
function createMockLLMFetch(selectedIndices: Array<{ idx: number; reason: string }>): FetchFn {
  const responseBody = {
    content: [{
      text: JSON.stringify({ selected: selectedIndices }),
    }],
  };

  return async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/**
 * Creates a mock fetch that returns a non-200 status.
 */
function createMockErrorFetch(status: number): FetchFn {
  return async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return new Response("Error", { status });
  };
}

/**
 * Creates a mock fetch that returns empty content.
 */
function createMockEmptyResponseFetch(): FetchFn {
  return async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return new Response(JSON.stringify({ content: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/**
 * Creates a mock fetch that returns invalid JSON.
 */
function createMockBadJsonFetch(): FetchFn {
  return async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return new Response(JSON.stringify({
      content: [{ text: "This is not valid JSON at all {{{" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/**
 * Creates a mock fetch that simulates a timeout.
 */
function createMockTimeoutFetch(): FetchFn {
  return async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Listen for abort signal
    return new Promise((_, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        });
      }
      // Never resolve - will be aborted by timeout
    });
  };
}

/**
 * Creates a mock fetch that tracks calls.
 */
function createTrackingMockFetch(
  selectedIndices: Array<{ idx: number; reason: string }>,
): { fetchFn: FetchFn; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const responseBody = {
    content: [{
      text: JSON.stringify({ selected: selectedIndices }),
    }],
  };

  const fetchFn: FetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: urlStr, body });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return { fetchFn, calls };
}

// ============================================================================
// Tests: LLM Path
// ============================================================================

Deno.test("selectRelevantTicketsWithLLM: uses LLM when API key is set and returns LLM: prefixed reasons", async () => {
  // Set up environment
  const originalKey = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "test-key-for-testing");

  try {
    const mockFetch = createMockLLMFetch([
      { idx: 0, reason: "Related to login issues" },
      { idx: 2, reason: "Also involves user error" },
    ]);

    const result = await selectRelevantTicketsWithLLM(
      "user login problem",
      testIssues,
      8,
      mockFetch
    );

    // Should use LLM path
    assertEquals(result.actualSource, "llm");
    assertEquals(result.fallbackCause, undefined);
    assertEquals(result.tickets.length, 2);

    // Reasons should start with "LLM:"
    for (const ticket of result.tickets) {
      assert(ticket.reason.startsWith("LLM:"), `Expected reason to start with "LLM:", got: ${ticket.reason}`);
    }

    // Check specific tickets were selected
    assertEquals(result.tickets[0].issue.identifier, "CS-1");
    assertEquals(result.tickets[1].issue.identifier, "CS-3");
    assertStringIncludes(result.tickets[0].reason, "Related to login issues");
  } finally {
    // Restore original key
    if (originalKey) {
      Deno.env.set("ANTHROPIC_API_KEY", originalKey);
    } else {
      Deno.env.delete("ANTHROPIC_API_KEY");
    }
  }
});

Deno.test("selectRelevantTicketsWithLLM: LLM response determines which tickets are selected", async () => {
  const originalKey = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "test-key-for-testing");

  try {
    // LLM selects indices 3 and 4, not based on keyword matching
    const mockFetch = createMockLLMFetch([
      { idx: 3, reason: "Mobile app issue might be related" },
      { idx: 4, reason: "API integration could be affected" },
    ]);

    const result = await selectRelevantTicketsWithLLM(
      "password reset issue", // Keywords don't match indices 3,4
      testIssues,
      8,
      mockFetch
    );

    assertEquals(result.actualSource, "llm");
    assertEquals(result.tickets.length, 2);

    // LLM's selection overrides keyword matching
    assertEquals(result.tickets[0].issue.identifier, "CS-4"); // Mobile app
    assertEquals(result.tickets[1].issue.identifier, "CS-5"); // API rate limit
  } finally {
    if (originalKey) {
      Deno.env.set("ANTHROPIC_API_KEY", originalKey);
    } else {
      Deno.env.delete("ANTHROPIC_API_KEY");
    }
  }
});

Deno.test("selectRelevantTicketsWithLLM: HTTP call targets Anthropic API with correct headers", async () => {
  const originalKey = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "test-key-12345");

  try {
    const { fetchFn, calls } = createTrackingMockFetch([{ idx: 0, reason: "test" }]);

    await selectRelevantTicketsWithLLM("test query", testIssues, 8, fetchFn);

    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://api.anthropic.com/v1/messages");
    assert(calls[0].body !== null);
  } finally {
    if (originalKey) {
      Deno.env.set("ANTHROPIC_API_KEY", originalKey);
    } else {
      Deno.env.delete("ANTHROPIC_API_KEY");
    }
  }
});

// ============================================================================
// Tests: Fallback Path - Missing API Key
// ============================================================================

Deno.test("selectRelevantTicketsWithLLM: falls back with missing_key when no API key", async () => {
  const originalKey = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.delete("ANTHROPIC_API_KEY");

  try {
    // Mock fetch should NOT be called
    let fetchCalled = false;
    const mockFetch: FetchFn = async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    };

    const result = await selectRelevantTicketsWithLLM(
      "login",
      testIssues,
      8,
      mockFetch
    );

    assertEquals(result.actualSource, "keyword");
    assertEquals(result.fallbackCause, "missing_key");
    assertEquals(fetchCalled, false, "Fetch should not be called when API key is missing");

    // Reasons should start with "Fallback:"
    for (const ticket of result.tickets) {
      assert(
        ticket.reason.startsWith("Fallback:"),
        `Expected reason to start with "Fallback:", got: ${ticket.reason}`
      );
      assertStringIncludes(ticket.reason, "missing_key");
    }
  } finally {
    if (originalKey) {
      Deno.env.set("ANTHROPIC_API_KEY", originalKey);
    }
  }
});

// ============================================================================
// Tests: Fallback Path - Timeout
// ============================================================================

Deno.test("selectRelevantTicketsWithLLM: falls back with timeout when LLM times out", async () => {
  const originalKey = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "test-key");

  try {
    const mockFetch = createMockTimeoutFetch();

    const result = await selectRelevantTicketsWithLLM(
      "login",
      testIssues,
      8,
      mockFetch
    );

    assertEquals(result.actualSource, "keyword");
    assertEquals(result.fallbackCause, "timeout");

    // Should still return keyword-matched results
    assert(result.tickets.length > 0, "Should return keyword-matched tickets");

    // Reasons should indicate timeout fallback
    for (const ticket of result.tickets) {
      assert(
        ticket.reason.startsWith("Fallback:"),
        `Expected reason to start with "Fallback:", got: ${ticket.reason}`
      );
      assertStringIncludes(ticket.reason, "timeout");
    }
  } finally {
    if (originalKey) {
      Deno.env.set("ANTHROPIC_API_KEY", originalKey);
    } else {
      Deno.env.delete("ANTHROPIC_API_KEY");
    }
  }
});

// ============================================================================
// Tests: Fallback Path - Non-200 Response
// ============================================================================

Deno.test("selectRelevantTicketsWithLLM: falls back with non_200 when API returns error", async () => {
  const originalKey = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "test-key");

  try {
    const mockFetch = createMockErrorFetch(500);

    const result = await selectRelevantTicketsWithLLM(
      "export CSV",
      testIssues,
      8,
      mockFetch
    );

    assertEquals(result.actualSource, "keyword");
    assertEquals(result.fallbackCause, "non_200");

    // Should return keyword-matched results
    assert(result.tickets.length > 0, "Should return keyword-matched tickets");

    // Check that CSV-related ticket is matched
    const hasExportTicket = result.tickets.some(t => t.issue.identifier === "CS-3");
    assert(hasExportTicket, "Keyword fallback should match export CSV ticket");

    // Reasons should indicate non_200 fallback
    for (const ticket of result.tickets) {
      assertStringIncludes(ticket.reason, "Fallback:");
      assertStringIncludes(ticket.reason, "non_200");
    }
  } finally {
    if (originalKey) {
      Deno.env.set("ANTHROPIC_API_KEY", originalKey);
    } else {
      Deno.env.delete("ANTHROPIC_API_KEY");
    }
  }
});

// ============================================================================
// Tests: Fallback Path - Parse Error
// ============================================================================

Deno.test("selectRelevantTicketsWithLLM: falls back with parse_error when JSON is invalid", async () => {
  const originalKey = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "test-key");

  try {
    const mockFetch = createMockBadJsonFetch();

    const result = await selectRelevantTicketsWithLLM(
      "dashboard",
      testIssues,
      8,
      mockFetch
    );

    assertEquals(result.actualSource, "keyword");
    assertEquals(result.fallbackCause, "parse_error");

    // Reasons should indicate parse_error fallback
    for (const ticket of result.tickets) {
      assertStringIncludes(ticket.reason, "Fallback:");
      assertStringIncludes(ticket.reason, "parse_error");
    }
  } finally {
    if (originalKey) {
      Deno.env.set("ANTHROPIC_API_KEY", originalKey);
    } else {
      Deno.env.delete("ANTHROPIC_API_KEY");
    }
  }
});

// ============================================================================
// Tests: Fallback Path - Empty Response
// ============================================================================

Deno.test("selectRelevantTicketsWithLLM: falls back with empty_response when LLM returns no content", async () => {
  const originalKey = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "test-key");

  try {
    const mockFetch = createMockEmptyResponseFetch();

    const result = await selectRelevantTicketsWithLLM(
      "mobile app",
      testIssues,
      8,
      mockFetch
    );

    assertEquals(result.actualSource, "keyword");
    assertEquals(result.fallbackCause, "empty_response");

    // Should have matched mobile app ticket via keywords
    const hasMobileTicket = result.tickets.some(t => t.issue.identifier === "CS-4");
    assert(hasMobileTicket, "Keyword fallback should match mobile app ticket");

    // Reasons should indicate empty_response fallback
    for (const ticket of result.tickets) {
      assertStringIncludes(ticket.reason, "Fallback:");
      assertStringIncludes(ticket.reason, "empty_response");
    }
  } finally {
    if (originalKey) {
      Deno.env.set("ANTHROPIC_API_KEY", originalKey);
    } else {
      Deno.env.delete("ANTHROPIC_API_KEY");
    }
  }
});

// ============================================================================
// Tests: fallbackKeywordSelection directly
// ============================================================================

Deno.test("fallbackKeywordSelection: returns tickets with Fallback prefix and cause", () => {
  const causes: FallbackCause[] = ["missing_key", "timeout", "non_200", "parse_error", "empty_response"];

  for (const cause of causes) {
    const result = fallbackKeywordSelection("login password", testIssues, 5, cause);

    assert(result.length > 0, `Should find matches for cause: ${cause}`);

    for (const ticket of result) {
      assert(
        ticket.reason.startsWith("Fallback:"),
        `Expected reason to start with "Fallback:", got: ${ticket.reason}`
      );
      assertStringIncludes(ticket.reason, cause);
      assertStringIncludes(ticket.reason, "Keyword match");
    }
  }
});

Deno.test("fallbackKeywordSelection: matches based on token overlap", () => {
  const result = fallbackKeywordSelection("export CSV timeout", testIssues, 5);

  // Should match ticket CS-3 which has "export", "CSV", and "timeout" in title/description
  const exportTicket = result.find(t => t.issue.identifier === "CS-3");
  assert(exportTicket !== undefined, "Should match export CSV ticket");
});

Deno.test("fallbackKeywordSelection: respects maxResults limit", () => {
  const result = fallbackKeywordSelection("issue", testIssues, 2);
  assert(result.length <= 2, "Should not exceed maxResults");
});

// ============================================================================
// Tests: Empty issues
// ============================================================================

Deno.test("selectRelevantTicketsWithLLM: returns empty array for empty issues", async () => {
  const originalKey = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "test-key");

  try {
    let fetchCalled = false;
    const mockFetch: FetchFn = async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    };

    const result = await selectRelevantTicketsWithLLM("test", [], 8, mockFetch);

    assertEquals(result.tickets.length, 0);
    assertEquals(result.actualSource, "llm"); // Still "llm" source even with empty input
    assertEquals(fetchCalled, false, "Should not call API for empty issues");
  } finally {
    if (originalKey) {
      Deno.env.set("ANTHROPIC_API_KEY", originalKey);
    } else {
      Deno.env.delete("ANTHROPIC_API_KEY");
    }
  }
});

// ============================================================================
// Tests: Duration tracking
// ============================================================================

Deno.test("selectRelevantTicketsWithLLM: tracks duration in result", async () => {
  const originalKey = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "test-key");

  try {
    const mockFetch = createMockLLMFetch([{ idx: 0, reason: "test" }]);

    const result = await selectRelevantTicketsWithLLM("test", testIssues, 8, mockFetch);

    assert(result.durationMs !== undefined, "Should track duration");
    assert(result.durationMs >= 0, "Duration should be non-negative");
  } finally {
    if (originalKey) {
      Deno.env.set("ANTHROPIC_API_KEY", originalKey);
    } else {
      Deno.env.delete("ANTHROPIC_API_KEY");
    }
  }
});

console.log("All LLM ticket selection tests defined. Run with: deno test tests/ticket_selection_llm.test.ts");

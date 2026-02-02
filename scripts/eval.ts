#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read

/**
 * Retrieval Evaluation Script
 *
 * Runs golden queries against the /search endpoint and reports pass/fail metrics.
 *
 * Usage:
 *   deno task eval                    # Run against local dev server
 *   deno task eval --url=https://...  # Run against production
 *   deno task eval --json             # Output JSON instead of markdown
 */

import goldenQueries from "../tests/golden_queries.json" with { type: "json" };

// Types
interface GoldenQuery {
  id: string;
  query: string;
  type: string;
  expected_docs?: string[];
  expected_score_min?: number;
  expected_score_max?: number;
  expected_tickets_min?: number;
  description?: string;
}

interface SearchHit {
  pageTitle: string;
  sectionTitle: string;
  url: string;
  score: number;
  snippet?: string;
}

interface SearchResponse {
  q: string;
  summary: string;
  recommendation: string;
  next_actions?: string[];
  hits: SearchHit[];
  related_tickets?: Array<{
    identifier: string;
    title: string;
    reason: string;
  }>;
  search_source: string;
  latency_ms: number;
  debug?: {
    tokens_extracted: string[];
    top_candidate_score: number;
    top_candidate_title: string;
  };
}

interface QueryResult {
  id: string;
  query: string;
  type: string;
  passed: boolean;
  reason: string;
  top_score: number | null;
  top_title: string | null;
  latency_ms: number;
  expected_docs: string[];
  matched_doc: boolean;
}

interface EvalResults {
  timestamp: string;
  base_url: string;
  total_queries: number;
  passed: number;
  failed: number;
  precision_at_1: number;
  precision_at_3: number;
  negative_rejection_rate: number;
  avg_latency_ms: number;
  results: QueryResult[];
}

// Parse CLI args
function parseArgs(): { baseUrl: string; jsonOutput: boolean } {
  const args = Deno.args;
  let baseUrl = goldenQueries.config.base_url;
  let jsonOutput = false;

  for (const arg of args) {
    if (arg.startsWith("--url=")) {
      baseUrl = arg.slice("--url=".length);
    }
    if (arg === "--json") {
      jsonOutput = true;
    }
  }

  return { baseUrl, jsonOutput };
}

// Run single query evaluation
async function evaluateQuery(
  baseUrl: string,
  gq: GoldenQuery,
  timeoutMs: number
): Promise<QueryResult> {
  const startTime = Date.now();
  const url = `${baseUrl}/search?q=${encodeURIComponent(gq.query)}&debug=1`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        id: gq.id,
        query: gq.query,
        type: gq.type,
        passed: false,
        reason: `HTTP error: ${response.status}`,
        top_score: null,
        top_title: null,
        latency_ms: Date.now() - startTime,
        expected_docs: gq.expected_docs || [],
        matched_doc: false,
      };
    }

    const data: SearchResponse = await response.json();
    const latencyMs = Date.now() - startTime;
    const topHit = data.hits[0];
    const topScore = topHit?.score ?? 0;
    const topTitle = topHit?.pageTitle ?? "";

    // Check if any expected doc word appears in top 3 results
    const expectedDocs = gq.expected_docs || [];
    const top3Titles = data.hits.slice(0, 3).map(h => h.pageTitle.toLowerCase());
    const matchedDoc = expectedDocs.length === 0 || expectedDocs.some(doc =>
      top3Titles.some(title => title.includes(doc.toLowerCase()))
    );

    // Evaluate pass/fail
    let passed = true;
    let reason = "Passed";

    if (gq.type === "negative") {
      // Negative tests: score should be below max
      const maxScore = gq.expected_score_max ?? 0.25;
      if (topScore > maxScore) {
        passed = false;
        reason = `Score ${topScore.toFixed(3)} exceeds max ${maxScore}`;
      } else {
        reason = `Score ${topScore.toFixed(3)} correctly below ${maxScore}`;
      }
    } else {
      // Positive tests: score should meet minimum
      const minScore = gq.expected_score_min ?? 0.3;
      if (topScore < minScore) {
        passed = false;
        reason = `Score ${topScore.toFixed(3)} below min ${minScore}`;
      } else if (!matchedDoc && expectedDocs.length > 0) {
        passed = false;
        reason = `Expected doc not in top 3: wanted one of [${expectedDocs.join(", ")}], got [${top3Titles.join(", ")}]`;
      } else {
        reason = `Score ${topScore.toFixed(3)} >= ${minScore}, doc match OK`;
      }

      // Check ticket queries
      if (gq.expected_tickets_min !== undefined) {
        const ticketCount = data.related_tickets?.length ?? 0;
        if (ticketCount < gq.expected_tickets_min) {
          passed = false;
          reason = `Expected ${gq.expected_tickets_min}+ tickets, got ${ticketCount}`;
        }
      }
    }

    return {
      id: gq.id,
      query: gq.query,
      type: gq.type,
      passed,
      reason,
      top_score: topScore,
      top_title: topTitle,
      latency_ms: latencyMs,
      expected_docs: expectedDocs,
      matched_doc: matchedDoc,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return {
      id: gq.id,
      query: gq.query,
      type: gq.type,
      passed: false,
      reason: `Error: ${errMsg}`,
      top_score: null,
      top_title: null,
      latency_ms: Date.now() - startTime,
      expected_docs: gq.expected_docs || [],
      matched_doc: false,
    };
  }
}

// Calculate metrics
function calculateMetrics(results: QueryResult[]): {
  precision_at_1: number;
  precision_at_3: number;
  negative_rejection_rate: number;
  avg_latency_ms: number;
} {
  const positiveResults = results.filter(r => !r.type.includes("negative"));
  const negativeResults = results.filter(r => r.type.includes("negative"));

  // Precision@1: % of positive queries where expected doc is in top result
  const p1Matches = positiveResults.filter(r => r.matched_doc && r.top_score !== null);
  const precision_at_1 = positiveResults.length > 0
    ? p1Matches.length / positiveResults.length
    : 0;

  // Precision@3: % of positive queries where expected doc is in top 3
  const p3Matches = positiveResults.filter(r => r.matched_doc);
  const precision_at_3 = positiveResults.length > 0
    ? p3Matches.length / positiveResults.length
    : 0;

  // Negative rejection rate: % of negative queries that passed (low score)
  const negativeRejections = negativeResults.filter(r => r.passed);
  const negative_rejection_rate = negativeResults.length > 0
    ? negativeRejections.length / negativeResults.length
    : 1;

  // Average latency
  const totalLatency = results.reduce((sum, r) => sum + r.latency_ms, 0);
  const avg_latency_ms = results.length > 0
    ? totalLatency / results.length
    : 0;

  return { precision_at_1, precision_at_3, negative_rejection_rate, avg_latency_ms };
}

// Format results as markdown
function formatMarkdown(evalResults: EvalResults): string {
  const lines: string[] = [];

  lines.push("# Retrieval Evaluation Results");
  lines.push("");
  lines.push(`**Timestamp:** ${evalResults.timestamp}`);
  lines.push(`**Base URL:** ${evalResults.base_url}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value | Target |`);
  lines.push(`|--------|-------|--------|`);
  lines.push(`| Total Queries | ${evalResults.total_queries} | - |`);
  lines.push(`| Passed | ${evalResults.passed} | - |`);
  lines.push(`| Failed | ${evalResults.failed} | 0 |`);
  lines.push(`| Precision@1 | ${(evalResults.precision_at_1 * 100).toFixed(1)}% | ≥80% |`);
  lines.push(`| Precision@3 | ${(evalResults.precision_at_3 * 100).toFixed(1)}% | ≥90% |`);
  lines.push(`| Negative Rejection | ${(evalResults.negative_rejection_rate * 100).toFixed(1)}% | 100% |`);
  lines.push(`| Avg Latency | ${evalResults.avg_latency_ms.toFixed(0)}ms | <5000ms |`);
  lines.push("");

  // Overall pass/fail
  const p1Pass = evalResults.precision_at_1 >= 0.80;
  const p3Pass = evalResults.precision_at_3 >= 0.90;
  const negPass = evalResults.negative_rejection_rate >= 1.0;
  const latPass = evalResults.avg_latency_ms < 5000;

  if (p1Pass && p3Pass && negPass && latPass && evalResults.failed === 0) {
    lines.push("**OVERALL: PASS** ✓");
  } else {
    lines.push("**OVERALL: FAIL** ✗");
    if (!p1Pass) lines.push("- Precision@1 below target");
    if (!p3Pass) lines.push("- Precision@3 below target");
    if (!negPass) lines.push("- Negative rejection below target");
    if (!latPass) lines.push("- Latency above target");
    if (evalResults.failed > 0) lines.push(`- ${evalResults.failed} queries failed`);
  }

  lines.push("");
  lines.push("## Detailed Results");
  lines.push("");

  // Group by type
  const byType = new Map<string, QueryResult[]>();
  for (const r of evalResults.results) {
    const arr = byType.get(r.type) || [];
    arr.push(r);
    byType.set(r.type, arr);
  }

  for (const [type, results] of byType) {
    lines.push(`### ${type}`);
    lines.push("");
    lines.push("| ID | Query | Score | Title | Status | Reason |");
    lines.push("|-----|-------|-------|-------|--------|--------|");

    for (const r of results) {
      const status = r.passed ? "✓" : "✗";
      const score = r.top_score?.toFixed(3) ?? "N/A";
      const title = r.top_title ? r.top_title.slice(0, 25) : "N/A";
      const query = r.query.slice(0, 30);
      const reason = r.reason.slice(0, 50);
      lines.push(`| ${r.id} | ${query} | ${score} | ${title} | ${status} | ${reason} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Main execution
async function main() {
  const { baseUrl, jsonOutput } = parseArgs();
  const queries = goldenQueries.golden_queries as GoldenQuery[];
  const timeoutMs = goldenQueries.config.timeout_ms;

  console.error(`Running ${queries.length} golden queries against ${baseUrl}...`);
  console.error("");

  const results: QueryResult[] = [];

  for (const gq of queries) {
    const result = await evaluateQuery(baseUrl, gq, timeoutMs);
    results.push(result);

    const status = result.passed ? "✓" : "✗";
    console.error(`  ${status} ${result.id}: ${result.reason}`);
  }

  console.error("");

  const metrics = calculateMetrics(results);
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;

  const evalResults: EvalResults = {
    timestamp: new Date().toISOString(),
    base_url: baseUrl,
    total_queries: results.length,
    passed,
    failed,
    ...metrics,
    results,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(evalResults, null, 2));
  } else {
    console.log(formatMarkdown(evalResults));
  }

  // Exit with error code if any failures
  if (failed > 0) {
    Deno.exit(1);
  }
}

main();

// retrieval/notionSearch.ts — Direct Notion search (no pre-built index)
// This module fetches runbook content directly from Notion API on each request.
// NO blob index required - works from cold start.

import { NOTION_TOKEN, NOTION_ROOT_PAGE_ID } from "../env.ts";
import type { Chunk, Ranked } from "../types/index.ts";
import { normalizeQuery, normalizeSearchQuery, tokenize, uniq, extractLinearRefs } from "../util/text.ts";

// ============================================================================
// Types
// ============================================================================

export type DocResult = {
  chunk: Chunk;
  score: number;
  provenance: "semantic" | "keyword" | "both";
};

// ============================================================================
// Notion API Helpers
// ============================================================================

const NOTION_SEARCH_TIMEOUT_MS = 8000;
const NOTION_BLOCKS_TIMEOUT_MS = 5000;
const MAX_PAGES_TO_FETCH = 10;
const MAX_BLOCKS_PER_PAGE = 50;

/**
 * Search Notion using the Search API.
 * Returns pages matching the query text.
 */
async function notionSearch(query: string, maxResults = 15): Promise<Array<{ id: string; title: string }>> {
  if (!NOTION_TOKEN) {
    console.warn("[notionSearch] No NOTION_TOKEN set");
    return [];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOTION_SEARCH_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        filter: { property: "object", value: "page" },
        page_size: maxResults,
        sort: { direction: "descending", timestamp: "last_edited_time" },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error("[notionSearch] API error:", res.status, await res.text().catch(() => ""));
      return [];
    }

    const data = await res.json();
    const pages: Array<{ id: string; title: string }> = [];

    for (const result of data.results || []) {
      if (result.object !== "page") continue;

      // Extract title from properties
      let title = "";
      const props = result.properties || {};
      for (const key of Object.keys(props)) {
        const prop = props[key];
        if (prop.type === "title" && Array.isArray(prop.title)) {
          title = prop.title.map((t: any) => t.plain_text || "").join("");
          break;
        }
      }

      // Fallback: try child_page format
      if (!title && result.child_page?.title) {
        title = result.child_page.title;
      }

      if (title && result.id) {
        pages.push({ id: result.id, title });
      }
    }

    return pages;
  } catch (e) {
    clearTimeout(timeoutId);
    if ((e as Error).name === "AbortError") {
      console.warn("[notionSearch] Timeout");
    } else {
      console.error("[notionSearch] Error:", e);
    }
    return [];
  }
}

/**
 * Fetch block content for a Notion page.
 * Returns concatenated text content.
 */
async function fetchPageBlocks(pageId: string, maxBlocks = MAX_BLOCKS_PER_PAGE): Promise<string> {
  if (!NOTION_TOKEN) return "";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOTION_BLOCKS_TIMEOUT_MS);

  try {
    const url = `https://api.notion.com/v1/blocks/${pageId}/children?page_size=${maxBlocks}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`[fetchPageBlocks] API error for ${pageId}:`, res.status);
      return "";
    }

    const data = await res.json();
    const textParts: string[] = [];

    for (const block of data.results || []) {
      const blockType = block.type;
      const blockContent = block[blockType];

      // Extract rich_text
      if (blockContent?.rich_text && Array.isArray(blockContent.rich_text)) {
        const text = blockContent.rich_text.map((rt: any) => rt.plain_text || "").join("");
        if (text.trim()) textParts.push(text.trim());
      }

      // Extract title (for child_page blocks)
      if (blockContent?.title && Array.isArray(blockContent.title)) {
        const text = blockContent.title.map((rt: any) => rt.plain_text || "").join("");
        if (text.trim()) textParts.push(text.trim());
      }
    }

    return textParts.join("\n");
  } catch (e) {
    clearTimeout(timeoutId);
    if ((e as Error).name === "AbortError") {
      console.warn(`[fetchPageBlocks] Timeout for ${pageId}`);
    }
    return "";
  }
}

/**
 * Convert page ID to Notion URL
 */
function notionUrlForId(pageId: string): string {
  const clean = pageId.replace(/-/g, "");
  return `https://notion.so/${clean}`;
}

/**
 * Count code signals in text (for engineering content detection)
 */
function codeSignalsCount(text: string): number {
  const patterns: Array<[RegExp, number]> = [
    [/db\./g, 2],
    [/ObjectId\(/g, 2],
    [/console\.log/g, 1],
    [/```/g, 2],
    [/\bdeleteOne\b|\bdeleteMany\b|\bupdateOne\b|\bupdateMany\b/g, 2],
    [/\bfind\(|\btoArray\(|\baggregate\(/g, 2],
    [/\bmongodb\b|\bcompass\b|\bshell\b/g, 2],
    [/\bconst\b|\blet\b|\bfunction\b/g, 1],
  ];

  let total = 0;
  for (const [re, w] of patterns) {
    const m = text.match(re);
    if (m) total += m.length * w;
  }
  return total;
}

// ============================================================================
// Keyword Scoring
// ============================================================================

/**
 * Score a chunk against a query using keyword matching.
 */
function keywordScore(queryRaw: string, pageTitle: string, sectionTitle: string, text: string): number {
  const q = normalizeSearchQuery(queryRaw);
  const hay = (pageTitle + "\n" + sectionTitle + "\n" + text).toLowerCase();
  const terms = uniq(tokenize(q));

  let s = 0;
  for (const t of terms) if (hay.includes(t)) s += 1;

  for (const t of terms) {
    if (pageTitle.toLowerCase().includes(t)) s += 3;
    if (sectionTitle.toLowerCase().includes(t)) s += 2;
  }

  // Intent boosts
  if (q.includes("pending") || q.includes("finalize")) {
    const title = pageTitle.toLowerCase();
    if (title.includes("pending")) s += 4;
    if (title.includes("finalize")) s += 4;
    if (title.includes("preprocess")) s += 2;
  }

  return s;
}

// ============================================================================
// Main Search Function
// ============================================================================

/**
 * Search Notion runbooks using semantic search + keyword scoring.
 * NO pre-built index required - fetches content directly from Notion API.
 *
 * @param query - User's search query
 * @param maxResults - Maximum results to return
 * @returns Array of DocResult with provenance indicators
 */
export async function searchNotionDirect(
  query: string,
  maxResults = 6
): Promise<{ results: DocResult[]; source: "notion_direct" }> {
  console.log(`[searchNotionDirect] Starting search for: "${query.slice(0, 50)}..."`);
  const startTime = Date.now();

  // Step 1: Semantic search via Notion API
  const searchResults = await notionSearch(query, 15);
  console.log(`[searchNotionDirect] Notion search returned ${searchResults.length} pages`);

  if (searchResults.length === 0) {
    return { results: [], source: "notion_direct" };
  }

  // Step 2: Fetch block content for top pages (rate-limited to avoid API throttling)
  // Fetch in batches of 3 with small delays to prevent rate limiting
  const pagesToFetch = searchResults.slice(0, MAX_PAGES_TO_FETCH);
  const pageContents: Array<{ id: string; title: string; content: string }> = [];
  const BATCH_SIZE = 3;
  const BATCH_DELAY_MS = 50;

  for (let i = 0; i < pagesToFetch.length; i += BATCH_SIZE) {
    const batch = pagesToFetch.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (page) => {
        const content = await fetchPageBlocks(page.id);
        return { ...page, content };
      })
    );
    pageContents.push(...batchResults);

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < pagesToFetch.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Step 3: Create chunks and score them
  const allResults: DocResult[] = [];

  for (const page of pageContents) {
    const url = notionUrlForId(page.id);
    const text = page.content || `Runbook: ${page.title}`;
    const codeSignals = codeSignalsCount(text);

    // Calculate keyword score
    const kwScore = keywordScore(query, page.title, "Overview", text);

    // Determine provenance
    // Semantic: came from Notion search (always true for these results)
    // Keyword: also has positive keyword score
    const searchRank = searchResults.findIndex((r) => r.id === page.id);
    const semanticScore = searchRank >= 0 ? (15 - searchRank) / 15 : 0; // Normalize to 0-1

    let provenance: "semantic" | "keyword" | "both" = "semantic";
    if (kwScore > 0 && semanticScore > 0) {
      provenance = "both";
    } else if (kwScore > 0) {
      provenance = "keyword";
    }

    // Combined score: weighted average
    const normalizedKwScore = Math.min(kwScore / 10, 1);
    const combinedScore = 0.4 * normalizedKwScore + 0.6 * semanticScore;

    // Apply code penalty
    let finalScore = combinedScore;
    if (codeSignals >= 12) {
      finalScore -= 0.2;
    } else if (codeSignals >= 6) {
      finalScore -= 0.1;
    }

    const chunk: Chunk = {
      pageId: page.id,
      pageTitle: page.title,
      sectionTitle: "Overview",
      text: text.slice(0, 2000), // Truncate for reasonable size
      url,
      ticketRefs: extractLinearRefs(text),
      codeSignals,
    };

    allResults.push({
      chunk,
      score: finalScore,
      provenance,
    });
  }

  // Step 4: Sort by score and dedupe by page title
  allResults.sort((a, b) => b.score - a.score);

  const deduped: DocResult[] = [];
  const seenTitles = new Set<string>();
  for (const result of allResults) {
    if (seenTitles.has(result.chunk.pageTitle)) continue;
    seenTitles.add(result.chunk.pageTitle);
    deduped.push(result);
    if (deduped.length >= maxResults) break;
  }

  console.log(`[searchNotionDirect] Returning ${deduped.length} results in ${Date.now() - startTime}ms`);
  return { results: deduped, source: "notion_direct" };
}

/**
 * Convert DocResult to Ranked (for compatibility with existing code).
 */
export function docResultToRanked(result: DocResult): Ranked {
  return {
    chunk: result.chunk,
    score: result.score,
  };
}

/**
 * Check if NOTION_TOKEN is available.
 */
export function isNotionConfigured(): boolean {
  return Boolean(NOTION_TOKEN && NOTION_ROOT_PAGE_ID);
}

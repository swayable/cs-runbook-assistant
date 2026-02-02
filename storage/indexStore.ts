// storage/indexStore.ts — Blob index + Notion crawl + cache

import { blob } from "https://esm.town/v/std/blob";
import {
  BLOB_KEY,
  MEM_CACHE_TTL_MS,
  BLOB_MAX_AGE_MS,
  NOTION_ROOT_PAGE_ID,
  NOTION_TOKEN,
  PUBLIC_BASE_URL,
} from "../env.ts";
import type { Chunk, IndexPayload, NotionBlock, BuildOpts } from "../types/index.ts";
import { extractLinearRefs, notionUrlForId, uniq } from "../util/text.ts";

// In-memory cache (resets on code changes / cold starts)
let CACHE: { builtAtMs: number; chunks: Chunk[]; diag: any } | null = null;

export function getCache(): typeof CACHE {
  return CACHE;
}

// Blob operations
export async function blobGetIndex(): Promise<IndexPayload | null> {
  try {
    const payload = await blob.getJSON(BLOB_KEY) as IndexPayload | null;
    if (!payload) return null;
    if (!payload.builtAtMs || !Array.isArray(payload.chunks)) return null;
    return payload;
  } catch (e) {
    console.warn("blobGetIndex failed:", String((e as any)?.message || e));
    return null;
  }
}

export async function blobSetIndex(payload: IndexPayload): Promise<void> {
  try {
    await blob.setJSON(BLOB_KEY, payload);
  } catch (e) {
    console.warn("blobSetIndex failed:", String((e as any)?.message || e));
  }
}

// Notion helpers
function richTextToPlain(rt: any[] | undefined): string {
  if (!Array.isArray(rt)) return "";
  return rt.map((r) => r?.plain_text || "").join("");
}

function blockText(b: NotionBlock): string {
  const t = b?.type;
  const rich = b?.[t]?.rich_text;
  if (Array.isArray(rich)) return richTextToPlain(rich);

  const title = b?.[t]?.title;
  if (Array.isArray(title)) return richTextToPlain(title);

  if (t === "child_page") return b?.child_page?.title || "";
  return "";
}

function isHeading(b: NotionBlock): boolean {
  return b?.type === "heading_1" || b?.type === "heading_2" ||
    b?.type === "heading_3";
}

async function fetchBlockChildren(blockId: string): Promise<NotionBlock[]> {
  let results: NotionBlock[] = [];
  let cursor: string | undefined;

  while (true) {
    const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
      },
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(
        `Notion children failed ${res.status}: ${t.slice(0, 400)}`,
      );
    }

    const j = await res.json();
    results = results.concat(j.results || []);
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }

  return results;
}

async function fetchBlocksRecursive(
  rootId: string,
  maxBlocks = 4000,
): Promise<NotionBlock[]> {
  const out: NotionBlock[] = [];
  const queue: string[] = [rootId];

  while (queue.length > 0 && out.length < maxBlocks) {
    const id = queue.shift()!;
    const children = await fetchBlockChildren(id);

    for (const b of children) {
      out.push(b);
      if (b?.has_children) queue.push(b.id);
      if (out.length >= maxBlocks) break;
    }
  }
  return out;
}

async function listChildPages(
  parentPageId: string,
): Promise<{ id: string; title: string }[]> {
  const blocks = await fetchBlockChildren(parentPageId);
  return blocks
    .filter((b) => b.type === "child_page")
    .map((b) => ({ id: b.id, title: b.child_page?.title }))
    .filter((x) => Boolean(x.id && x.title));
}

// Chunking
function splitIntoSizedChunks(text: string, maxLen = 900): string[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf: string[] = [];
  let len = 0;

  for (const line of lines) {
    const addLen = line.length + 1;
    if (len + addLen > maxLen && buf.length > 0) {
      chunks.push(buf.join("\n"));
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += addLen;
  }
  if (buf.length) chunks.push(buf.join("\n"));
  return chunks;
}

export function codeSignalsCount(text: string): number {
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

function chunkPage(
  pageTitle: string,
  pageId: string,
  blocks: NotionBlock[],
): Chunk[] {
  const url = notionUrlForId(pageId);

  let currentSection = pageTitle;
  let buf: string[] = [];
  const chunks: Chunk[] = [];

  const flush = () => {
    const t = buf.join("\n").trim();
    if (t.length > 0) {
      for (const piece of splitIntoSizedChunks(t, 900)) {
        chunks.push({
          pageId,
          pageTitle,
          sectionTitle: currentSection,
          text: piece.slice(0, 5000),
          url,
          ticketRefs: extractLinearRefs(piece),
          codeSignals: codeSignalsCount(piece),
        });
      }
    }
    buf = [];
  };

  for (const b of blocks) {
    if (isHeading(b)) {
      flush();
      currentSection = blockText(b) || pageTitle;
    } else {
      const t = blockText(b);
      if (t) buf.push(t);
    }
  }
  flush();

  // title-only chunk to help title matches
  chunks.push({
    pageId,
    pageTitle,
    sectionTitle: "Page Summary",
    text: `Runbook: ${pageTitle}`,
    url,
    ticketRefs: [],
    codeSignals: 0,
  });

  return chunks.filter((c) => c.text.trim().length > 0);
}

// Build index (memory -> blob -> notion)
// New semantics:
// - Memory cache: use if fresh per MEM_CACHE_TTL_MS
// - Blob cache: ALWAYS use if exists (even if stale), track staleness in diag
// - Only throw "Index not ready" when blob is MISSING AND allowNotion=false
// - Only crawl Notion when allowNotion=true (i.e., /rebuild endpoint)
export async function buildIndex(
  force = false,
  opts: BuildOpts = {},
): Promise<{ chunks: Chunk[]; diag: any; source: string; stale?: boolean; blobAgeMs?: number }> {
  const allowNotion = opts.allowNotion === true;

  // 1) Memory cache: use if fresh per MEM_CACHE_TTL_MS
  if (!force && CACHE && Date.now() - CACHE.builtAtMs < MEM_CACHE_TTL_MS) {
    return { chunks: CACHE.chunks, diag: CACHE.diag, source: "memory" };
  }

  // 2) Blob cache: ALWAYS use if exists, even if stale
  // We only use blob age to compute staleness warning, NOT to reject the data
  if (!force) {
    const fromBlob = await blobGetIndex();
    if (fromBlob) {
      const blobAgeMs = Date.now() - fromBlob.builtAtMs;
      const isStale = blobAgeMs > BLOB_MAX_AGE_MS;

      // Refresh in-memory cache from blob
      CACHE = {
        builtAtMs: fromBlob.builtAtMs,
        chunks: fromBlob.chunks,
        diag: fromBlob.diag,
      };

      return {
        chunks: fromBlob.chunks,
        diag: fromBlob.diag,
        source: "blob",
        stale: isStale,
        blobAgeMs,
      };
    }
  }

  // 3) No blob found — either crawl Notion or throw error
  // Notion crawl (slow) — ONLY allowed on /rebuild
  if (!allowNotion) {
    const hint = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/rebuild` : "/rebuild";
    throw new Error(`Index not ready. Run ${hint}`);
  }

  const childPages = await listChildPages(NOTION_ROOT_PAGE_ID);

  const typeCounts: Record<string, number> = {};
  let totalBlocks = 0;
  let textBlocks = 0;

  const chunks: Chunk[] = [];
  const chunksPerPage: Array<
    { title: string; chunks: number; blocks: number; textBlocks: number }
  > = [];

  for (const p of childPages) {
    const blocks = await fetchBlocksRecursive(p.id, 4000);
    totalBlocks += blocks.length;

    let pageTextBlocks = 0;
    for (const b of blocks) {
      const t = b?.type || "unknown";
      typeCounts[t] = (typeCounts[t] || 0) + 1;
      const txt = blockText(b);
      if (txt && txt.trim()) {
        textBlocks += 1;
        pageTextBlocks += 1;
      }
    }

    const pageChunks = chunkPage(p.title, p.id, blocks);
    chunks.push(...pageChunks);
    chunksPerPage.push({
      title: p.title,
      chunks: pageChunks.length,
      blocks: blocks.length,
      textBlocks: pageTextBlocks,
    });
  }

  chunksPerPage.sort((a, b) => a.chunks - b.chunks);

  const diag = {
    pages: childPages.length,
    totalBlocks,
    textBlocks,
    chunkCount: chunks.length,
    topBlockTypes: Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(
      0,
      15,
    ),
    lowestChunkPages: chunksPerPage.slice(0, 10),
    highestChunkPages: chunksPerPage.slice(-10),
    builtAt: new Date().toISOString(),
    blobKey: BLOB_KEY,
  };

  const payload: IndexPayload = { builtAtMs: Date.now(), diag, chunks };
  CACHE = {
    builtAtMs: payload.builtAtMs,
    chunks: payload.chunks,
    diag: payload.diag,
  };

  await blobSetIndex(payload);
  return { chunks, diag, source: "notion" };
}

// Re-export blob for debug endpoint
export { blob, BLOB_KEY };

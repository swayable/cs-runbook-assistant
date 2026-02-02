// storage/indexStore.ts — Blob index + Notion crawl + cache

import { blob } from "https://esm.town/v/std/blob";
import {
  BLOB_KEY,
  BLOB_KEY_V2,
  MEM_CACHE_TTL_MS,
  BLOB_MAX_AGE_MS,
  NOTION_ROOT_PAGE_ID,
  NOTION_TOKEN,
  PUBLIC_BASE_URL,
  OPENAI_API_KEY,
  MAX_EMBED_CHUNKS,
} from "../env.ts";
import type {
  Chunk,
  IndexPayload,
  IndexPayloadV2,
  AnyIndexPayload,
  ChunkWithEmbedding,
  NotionBlock,
  BuildOpts,
} from "../types/index.ts";
import { isV2Index } from "../types/index.ts";
import { extractLinearRefs, notionUrlForId, uniq } from "../util/text.ts";
import { embedBatch, EMBEDDING_MODEL, EMBEDDING_DIMS } from "../retrieval/embeddings.ts";

// In-memory cache (resets on code changes / cold starts)
// Can hold either v1 or v2 index
let CACHE: { builtAtMs: number; chunks: Chunk[] | ChunkWithEmbedding[]; diag: any; version?: 1 | 2 } | null = null;

export function getCache(): typeof CACHE {
  return CACHE;
}

// Blob operations - prefer v2 index when available
export async function blobGetIndex(): Promise<{ payload: AnyIndexPayload; version: 1 | 2 } | null> {
  // Try v2 first
  try {
    const v2 = await blob.getJSON(BLOB_KEY_V2) as IndexPayloadV2 | null;
    if (v2 && isV2Index(v2) && v2.builtAtMs && Array.isArray(v2.chunks)) {
      return { payload: v2, version: 2 };
    }
  } catch (e) {
    console.warn("blobGetIndex v2 failed:", String((e as any)?.message || e));
  }

  // Fall back to v1
  try {
    const v1 = await blob.getJSON(BLOB_KEY) as IndexPayload | null;
    if (v1 && v1.builtAtMs && Array.isArray(v1.chunks)) {
      return { payload: v1, version: 1 };
    }
  } catch (e) {
    console.warn("blobGetIndex v1 failed:", String((e as any)?.message || e));
  }

  return null;
}

export async function blobSetIndexV1(payload: IndexPayload): Promise<void> {
  try {
    await blob.setJSON(BLOB_KEY, payload);
  } catch (e) {
    console.warn("blobSetIndex v1 failed:", String((e as any)?.message || e));
  }
}

export async function blobSetIndexV2(payload: IndexPayloadV2): Promise<void> {
  try {
    await blob.setJSON(BLOB_KEY_V2, payload);
  } catch (e) {
    console.warn("blobSetIndex v2 failed:", String((e as any)?.message || e));
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

// Helper to generate embeddings for chunks in batches
async function generateEmbeddings(
  chunks: Chunk[]
): Promise<{ chunksWithEmbeddings: ChunkWithEmbedding[]; chunksEmbedded: number } | null> {
  if (!OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY not set, skipping embedding generation");
    return null;
  }

  const chunksToEmbed = chunks.slice(0, MAX_EMBED_CHUNKS);
  if (chunksToEmbed.length < chunks.length) {
    console.warn(`Truncating to ${MAX_EMBED_CHUNKS} chunks for embedding (total: ${chunks.length})`);
  }

  // Prepare embedding texts: Title + Section + Content (truncated)
  const texts = chunksToEmbed.map((c) =>
    `Title: ${c.pageTitle}\nSection: ${c.sectionTitle}\nContent: ${c.text.slice(0, 800)}`
  );

  const chunksWithEmbeddings: ChunkWithEmbedding[] = [];
  const BATCH_SIZE = 100;
  const BATCH_DELAY_MS = 100;

  try {
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batchTexts = texts.slice(i, i + BATCH_SIZE);
      const batchChunks = chunksToEmbed.slice(i, i + BATCH_SIZE);

      const embeddings = await embedBatch(batchTexts);

      for (let j = 0; j < batchChunks.length; j++) {
        chunksWithEmbeddings.push({
          ...batchChunks[j],
          embedding: embeddings[j],
        });
      }

      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < texts.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    // Add remaining chunks without embeddings if truncated
    for (let i = chunksToEmbed.length; i < chunks.length; i++) {
      chunksWithEmbeddings.push({
        ...chunks[i],
        embedding: [], // Empty embedding for truncated chunks
      });
    }

    return { chunksWithEmbeddings, chunksEmbedded: chunksToEmbed.length };
  } catch (e) {
    console.error("Embedding generation failed:", String((e as any)?.message || e));
    return null;
  }
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
): Promise<{ chunks: Chunk[] | ChunkWithEmbedding[]; diag: any; source: string; stale?: boolean; blobAgeMs?: number; indexVersion: 1 | 2 }> {
  const allowNotion = opts.allowNotion === true;

  // 1) Memory cache: use if fresh per MEM_CACHE_TTL_MS
  if (!force && CACHE && Date.now() - CACHE.builtAtMs < MEM_CACHE_TTL_MS) {
    return {
      chunks: CACHE.chunks,
      diag: CACHE.diag,
      source: "memory",
      indexVersion: CACHE.version || 1,
    };
  }

  // 2) Blob cache: ALWAYS use if exists, even if stale
  // We only use blob age to compute staleness warning, NOT to reject the data
  if (!force) {
    const fromBlob = await blobGetIndex();
    if (fromBlob) {
      const blobAgeMs = Date.now() - fromBlob.payload.builtAtMs;
      const isStale = blobAgeMs > BLOB_MAX_AGE_MS;

      // Refresh in-memory cache from blob
      CACHE = {
        builtAtMs: fromBlob.payload.builtAtMs,
        chunks: fromBlob.payload.chunks,
        diag: fromBlob.payload.diag,
        version: fromBlob.version,
      };

      return {
        chunks: fromBlob.payload.chunks,
        diag: fromBlob.payload.diag,
        source: fromBlob.version === 2 ? "blob-v2" : "blob-v1",
        stale: isStale,
        blobAgeMs,
        indexVersion: fromBlob.version,
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

  // Generate embeddings if OPENAI_API_KEY is available
  const embeddingResult = await generateEmbeddings(chunks);

  // Base diagnostics
  const baseDiag = {
    pages: childPages.length,
    totalBlocks,
    textBlocks,
    chunkCount: chunks.length,
    topBlockTypes: Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 15),
    lowestChunkPages: chunksPerPage.slice(0, 10),
    highestChunkPages: chunksPerPage.slice(-10),
    builtAt: new Date().toISOString(),
    blobKey: BLOB_KEY,
  };

  const builtAtMs = Date.now();

  // Always write v1 index (without embeddings for backward compatibility)
  const v1Diag = {
    ...baseDiag,
    embeddingModel: null,
    embeddingDims: null,
    chunksEmbedded: 0,
  };
  const v1Payload: IndexPayload = { builtAtMs, diag: v1Diag, chunks };
  await blobSetIndexV1(v1Payload);

  // Write v2 index if embeddings were generated
  if (embeddingResult) {
    const v2Diag = {
      ...baseDiag,
      embeddingModel: EMBEDDING_MODEL,
      embeddingDims: EMBEDDING_DIMS,
      chunksEmbedded: embeddingResult.chunksEmbedded,
    };
    const v2Payload: IndexPayloadV2 = {
      version: 2,
      builtAtMs,
      diag: v2Diag,
      chunks: embeddingResult.chunksWithEmbeddings,
    };
    await blobSetIndexV2(v2Payload);

    // Cache v2 version
    CACHE = {
      builtAtMs,
      chunks: embeddingResult.chunksWithEmbeddings,
      diag: v2Diag,
      version: 2,
    };

    return {
      chunks: embeddingResult.chunksWithEmbeddings,
      diag: v2Diag,
      source: "notion",
      indexVersion: 2,
    };
  }

  // No embeddings - cache and return v1
  CACHE = {
    builtAtMs,
    chunks,
    diag: v1Diag,
    version: 1,
  };

  return { chunks, diag: v1Diag, source: "notion", indexVersion: 1 };
}

// Re-export blob for debug endpoint
export { blob, BLOB_KEY, BLOB_KEY_V2 };

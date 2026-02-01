// retrieval/rank.ts — Scoring and ranking

import type { Chunk, Ranked } from "../types/index.ts";
import { normalizeQuery, tokenize, uniq } from "../util/text.ts";

export function score(queryRaw: string, chunk: Chunk): number {
  const q = normalizeQuery(queryRaw);
  const hay = (chunk.pageTitle + "\n" + chunk.sectionTitle + "\n" + chunk.text)
    .toLowerCase();
  const terms = uniq(tokenize(q));

  let s = 0;
  for (const t of terms) if (hay.includes(t)) s += 1;

  for (const t of terms) {
    if (chunk.pageTitle.toLowerCase().includes(t)) s += 3;
    if (chunk.sectionTitle.toLowerCase().includes(t)) s += 2;
  }

  // Intent boosts
  if (q.includes("pending") || q.includes("finalize")) {
    const title = chunk.pageTitle.toLowerCase();
    if (title.includes("pending")) s += 4;
    if (title.includes("finalize")) s += 4;
    if (title.includes("preprocess")) s += 2;
  }

  // Code penalty
  if (chunk.codeSignals >= 6) s -= 4;
  if (chunk.codeSignals >= 12) s -= 8;

  return s;
}

export function rank(queryRaw: string, chunks: Chunk[], k = 6): Ranked[] {
  const scored = chunks
    .map((c) => ({ chunk: c, score: score(queryRaw, c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // Dedupe by pageTitle
  const out: Ranked[] = [];
  const seenPages = new Set<string>();
  for (const item of scored) {
    if (seenPages.has(item.chunk.pageTitle)) continue;
    out.push(item);
    seenPages.add(item.chunk.pageTitle);
    if (out.length >= k) break;
  }
  return out;
}

export function isEngineeringOnly(chunks: Chunk[]): boolean {
  if (!chunks.length) return true;
  const avg = chunks.reduce((s, c) => s + c.codeSignals, 0) / chunks.length;
  return avg >= 8;
}

// util/text.ts — Text utilities

/**
 * Basic query normalization: lowercase, remove quotes, trim.
 */
export function normalizeQuery(raw: string): string {
  return raw.toLowerCase().replaceAll('"', "").trim();
}

/**
 * CS-specific prefixes to strip from queries for better matching.
 * These are common ways CS agents phrase customer issues.
 */
const CS_PREFIXES = [
  /^customer\s+says?\s+/i,
  /^customer\s+reports?\s+/i,
  /^user\s+says?\s+/i,
  /^user\s+reports?\s+/i,
  /^client\s+says?\s+/i,
  /^they\s+say\s+/i,
  /^they\s+report\s+/i,
  /^the\s+customer\s+/i,
  /^a\s+customer\s+/i,
  /^getting\s+reports\s+of\s+/i,
  /^we('re|'ve|\s+are)\s+seeing\s+/i,
];

/**
 * Enhanced query normalization for search.
 * Strips CS-specific prefixes to get to the core issue.
 *
 * Example: "customer says export failed" -> "export failed"
 */
export function normalizeSearchQuery(raw: string): string {
  let q = raw.toLowerCase().replaceAll('"', "").trim();

  // Strip CS prefixes
  for (const prefix of CS_PREFIXES) {
    q = q.replace(prefix, "");
  }

  // Collapse whitespace
  q = q.replace(/\s+/g, " ").trim();

  return q;
}

export function tokenize(raw: string): string[] {
  return normalizeQuery(raw)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 40);
}

export function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function notionUrlForId(id: string): string {
  return `https://www.notion.so/${id.replaceAll("-", "")}`;
}

export function extractLinearRefs(t: string): string[] {
  const re =
    /https:\/\/linear\.app\/[a-z0-9\-]+\/issue\/[A-Z]+-\d+\/[^\s)"]+/gi;
  return uniq(Array.from(t.matchAll(re)).map((m) => m[0]));
}

export async function withTimeout<T>(
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

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

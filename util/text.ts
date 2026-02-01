// util/text.ts — Text utilities

export function normalizeQuery(raw: string): string {
  return raw.toLowerCase().replaceAll('"', "").trim();
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

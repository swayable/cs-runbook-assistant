// storage/dedupeStore.ts — Blob-backed event/command dedupe for Slack

import { blob } from "https://esm.town/v/std/blob";
import { SLACK_EVENT_DEDUPE_PREFIX, SLACK_EVENT_DEDUPE_TTL_MS, SLASH_DEDUPE_PREFIX, SLASH_DEDUPE_TTL_MS } from "../env.ts";

type DedupeRecord = { seenAt: number };

/** Check if an event has already been processed (blob-backed, durable across cold starts) */
export async function seenEvent(eventId: string): Promise<boolean> {
  const key = `${SLACK_EVENT_DEDUPE_PREFIX}${eventId}`;
  try {
    const record = await blob.getJSON(key) as DedupeRecord | null;
    if (!record) return false;
    if (Date.now() - record.seenAt > SLACK_EVENT_DEDUPE_TTL_MS) return false;
    return true;
  } catch { return false; }
}

/** Mark event as seen BEFORE processing to prevent double-post on crash+retry */
export async function markEventSeen(eventId: string): Promise<void> {
  const key = `${SLACK_EVENT_DEDUPE_PREFIX}${eventId}`;
  try { await blob.setJSON(key, { seenAt: Date.now() } as DedupeRecord); }
  catch (e) { console.warn("markEventSeen failed:", String((e as any)?.message || e)); }
}

/** Check if a slash command trigger_id has already been processed */
export async function seenSlashCommand(triggerId: string): Promise<boolean> {
  const key = `${SLASH_DEDUPE_PREFIX}${triggerId}`;
  try {
    const record = await blob.getJSON(key) as DedupeRecord | null;
    if (!record) return false;
    if (Date.now() - record.seenAt > SLASH_DEDUPE_TTL_MS) return false;
    return true;
  } catch { return false; }
}

/** Mark slash command as seen */
export async function markSlashCommandSeen(triggerId: string): Promise<void> {
  const key = `${SLASH_DEDUPE_PREFIX}${triggerId}`;
  try { await blob.setJSON(key, { seenAt: Date.now() } as DedupeRecord); }
  catch (e) { console.warn("markSlashCommandSeen failed:", String((e as any)?.message || e)); }
}

/** Log Slack retry headers if present */
export function logRetryHeaders(req: Request, context: string): void {
  const retryNum = req.headers.get("x-slack-retry-num");
  const retryReason = req.headers.get("x-slack-retry-reason");
  if (retryNum || retryReason) {
    console.log(`[${context}] Slack retry: num=${retryNum}, reason=${retryReason}`);
  }
}

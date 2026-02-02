// storage/threadStore.ts — Blob-backed thread state for follow-up conversations

import { blob } from "https://esm.town/v/std/blob";
import { THREAD_STATE_BLOB_PREFIX, THREAD_STATE_TTL_MS, MAX_FOLLOWUPS } from "../env.ts";
import type { ThreadState, Ranked, LlmSummary, FollowupEntry } from "../types/index.ts";

/**
 * Generate a unique key for a thread.
 */
export function threadKey(channelId: string, threadTs: string): string {
  return `${THREAD_STATE_BLOB_PREFIX}${channelId}:${threadTs}`;
}

/**
 * Get thread state from blob storage.
 * Returns null if not found or expired.
 */
export async function getThreadState(
  channelId: string,
  threadTs: string,
): Promise<ThreadState | null> {
  const key = threadKey(channelId, threadTs);
  try {
    const state = await blob.getJSON(key) as ThreadState | null;
    if (!state) return null;

    // Check if expired
    if (Date.now() - state.createdAt > THREAD_STATE_TTL_MS) {
      // Expired - delete and return null
      await blob.delete(key);
      return null;
    }

    return state;
  } catch (e) {
    console.warn("getThreadState failed:", String((e as any)?.message || e));
    return null;
  }
}

/**
 * Save thread state to blob storage.
 */
export async function putThreadState(state: ThreadState): Promise<void> {
  const key = threadKey(state.channelId, state.threadTs);
  try {
    await blob.setJSON(key, state);
  } catch (e) {
    console.warn("putThreadState failed:", String((e as any)?.message || e));
  }
}

/**
 * Create a new thread state or update existing one.
 */
export async function createOrUpdateThreadState(params: {
  channelId: string;
  threadTs: string;
  rootQuestion: string;
  rootUser: string;
  hits: Ranked[];
  llm: LlmSummary;
  ticketDraft: string;
}): Promise<ThreadState> {
  const existing = await getThreadState(params.channelId, params.threadTs);

  if (existing) {
    // Update existing state with new hits/llm/ticketDraft
    const updated: ThreadState = {
      ...existing,
      lastHits: params.hits,
      lastLlm: params.llm,
      ticketDraft: params.ticketDraft,
    };
    await putThreadState(updated);
    return updated;
  }

  // Create new state
  const state: ThreadState = {
    channelId: params.channelId,
    threadTs: params.threadTs,
    createdAt: Date.now(),
    rootQuestion: params.rootQuestion,
    rootUser: params.rootUser,
    followups: [],
    lastHits: params.hits,
    lastLlm: params.llm,
    ticketDraft: params.ticketDraft,
  };
  await putThreadState(state);
  return state;
}

/**
 * Add a follow-up to thread state.
 * Limits to MAX_FOLLOWUPS to prevent unbounded growth.
 */
export async function addFollowup(
  channelId: string,
  threadTs: string,
  followup: FollowupEntry,
  newHits: Ranked[],
  newLlm: LlmSummary,
  newTicketDraft: string,
): Promise<ThreadState | null> {
  const state = await getThreadState(channelId, threadTs);
  if (!state) return null;

  // Add followup, keeping only the last MAX_FOLLOWUPS
  const followups = [...state.followups, followup].slice(-MAX_FOLLOWUPS);

  const updated: ThreadState = {
    ...state,
    followups,
    lastHits: newHits,
    lastLlm: newLlm,
    ticketDraft: newTicketDraft,
  };

  await putThreadState(updated);
  return updated;
}

/**
 * Delete expired thread states (cleanup utility).
 * Can be called periodically to clean up old states.
 */
export async function expireThreadStates(): Promise<number> {
  let count = 0;
  try {
    const entries = await blob.list(THREAD_STATE_BLOB_PREFIX);
    for (const entry of entries) {
      try {
        const state = await blob.getJSON(entry.key) as ThreadState | null;
        if (state && Date.now() - state.createdAt > THREAD_STATE_TTL_MS) {
          await blob.delete(entry.key);
          count++;
        }
      } catch {
        // Ignore individual key errors
      }
    }
  } catch (e) {
    console.warn("expireThreadStates failed:", String((e as any)?.message || e));
  }
  return count;
}

// Re-export blob and prefix for debug endpoint
export { blob, THREAD_STATE_BLOB_PREFIX };

// storage/actionStore.ts — Blob-backed action store (durable across restarts)

import { blob } from "https://esm.town/v/std/blob";
import { ACTION_BLOB_PREFIX, ACTION_TTL_MS } from "../env.ts";
import type { ActionPayload } from "../types/index.ts";

async function blobSet(key: string, value: unknown): Promise<void> {
  await blob.setJSON(key, value);
}

async function blobGet<T>(key: string): Promise<T | null> {
  return (await blob.getJSON(key)) as T | null;
}

function newActionId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20);
}

export async function putAction(payload: {
  title: string;
  description: string;
}): Promise<string> {
  const id = newActionId();
  const key = ACTION_BLOB_PREFIX + id;

  const record: ActionPayload = {
    ...payload,
    createdAt: Date.now(),
  };

  await blobSet(key, record);
  return id;
}

export async function getAction(actionId: string): Promise<ActionPayload | null> {
  const key = ACTION_BLOB_PREFIX + actionId;
  const record = await blobGet<ActionPayload>(key);
  if (!record) return null;

  if (record.consumedAt) return null;

  if (Date.now() - record.createdAt > ACTION_TTL_MS) {
    // expire by marking consumed (so we don't keep using it)
    await blobSet(key, { ...record, consumedAt: Date.now() });
    return null;
  }
  return record;
}

export async function consumeAction(
  actionId: string,
): Promise<ActionPayload | null> {
  const key = ACTION_BLOB_PREFIX + actionId;
  const record = await getAction(actionId);
  if (!record) return null;

  // One-time use to prevent double-click duplicate tickets
  await blobSet(key, { ...record, consumedAt: Date.now() });
  return record;
}

// Re-export for debug endpoint
export { blob, ACTION_BLOB_PREFIX };

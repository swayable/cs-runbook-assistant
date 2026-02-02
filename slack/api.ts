// slack/api.ts — Slack API helpers

import { SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET } from "../env.ts";
import { timingSafeEqual } from "../util/text.ts";

export async function slackApi(
  method: string,
  body: Record<string, unknown>,
): Promise<any> {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`Slack API error ${method}: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function verifySlackSignature(
  req: Request,
  rawBody: string,
): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");
  if (!ts || !sig) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > 60 * 5) return false;

  const base = `v0:${ts}:${rawBody}`;

  const key = new TextEncoder().encode(SLACK_SIGNING_SECRET);
  const data = new TextEncoder().encode(base);

  const hmacKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", hmacKey, data);

  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const expected = `v0=${hex}`;
  return timingSafeEqual(expected, sig);
}

// ============================================================================
// Thread Context Helpers
// ============================================================================

export type SlackMessage = {
  ts: string;
  user?: string;
  text?: string;
  bot_id?: string;
};

export type ThreadContext = {
  messages: SlackMessage[];
  linearUrls: string[];
  summary: string;
};

/**
 * Fetch recent messages from a Slack thread.
 * Requires channels:history scope for public channels.
 * Returns up to `limit` messages (default 10).
 */
export async function fetchThreadMessages(
  channel: string,
  threadTs: string,
  limit = 10
): Promise<SlackMessage[]> {
  try {
    const resp = await slackApi("conversations.replies", {
      channel,
      ts: threadTs,
      limit,
    });
    return resp.messages || [];
  } catch (e) {
    console.warn("[fetchThreadMessages] Failed:", String((e as Error)?.message || e));
    return [];
  }
}

/**
 * Extract Linear ticket URLs from Slack messages.
 */
export function extractLinearUrlsFromMessages(messages: SlackMessage[]): string[] {
  const urls: string[] = [];
  const linearUrlPattern = /https?:\/\/linear\.app\/[a-z0-9-]+\/issue\/[A-Z]+-\d+[^\s)>\]"]*/gi;

  for (const msg of messages) {
    if (msg.text) {
      const matches = msg.text.match(linearUrlPattern) || [];
      urls.push(...matches);
    }
  }

  // Dedupe
  return Array.from(new Set(urls));
}

/**
 * Get thread context including messages and any Linear URLs mentioned.
 * Degrades gracefully if permissions aren't available.
 */
export async function getThreadContext(
  channel: string,
  threadTs: string,
  limit = 10
): Promise<ThreadContext> {
  const messages = await fetchThreadMessages(channel, threadTs, limit);
  const linearUrls = extractLinearUrlsFromMessages(messages);

  // Build a brief summary of the conversation (for context, not display)
  const userMessages = messages
    .filter((m) => !m.bot_id && m.text)
    .map((m) => m.text || "")
    .slice(0, 5);

  const summary = userMessages.length > 0
    ? userMessages.join(" | ").slice(0, 300)
    : "";

  return { messages, linearUrls, summary };
}

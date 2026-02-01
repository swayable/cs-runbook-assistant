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

// main.ts — Entry point + routing (Val Town HTTP val)
//
// Single default export required by Val Town.
// All business logic imported from modules.

import { mustEnv, BLOB_KEY } from "./env.ts";
import { json, text } from "./util/response.ts";
import {
  buildIndex,
  getCache,
  blobGetIndex,
  blob,
  BLOB_KEY as INDEX_BLOB_KEY,
} from "./storage/indexStore.ts";
import { blob as actionBlob, ACTION_BLOB_PREFIX } from "./storage/actionStore.ts";
import { rank } from "./retrieval/rank.ts";
import { shortStepFromChunkText, answerQuestion } from "./pipeline/answerQuestion.ts";
import { slackApi, verifySlackSignature } from "./slack/api.ts";
import { handleSlackActions } from "./slack/actions.ts";

// Route handlers

async function handleHealth(): Promise<Response> {
  const cache = getCache();
  const ageSec = cache
    ? Math.floor((Date.now() - cache.builtAtMs) / 1000)
    : null;
  return json({
    ok: true,
    cached: Boolean(cache),
    cache_age_sec: ageSec,
    chunkCount: cache?.chunks?.length || 0,
    builtAt: cache?.diag?.builtAt || null,
    blobKey: BLOB_KEY,
  });
}

async function handleRebuild(url: URL): Promise<Response> {
  const force = url.searchParams.get("force") === "1";
  const t0 = Date.now();
  const { chunks, diag, source } = await buildIndex(true || force, {
    allowNotion: true,
  });
  const t1 = Date.now();
  const cache = getCache();
  const age = cache ? Math.floor((Date.now() - cache.builtAtMs) / 1000) : "n/a";
  return text(
    `OK\nchunks=${chunks.length}\ncache_age_sec=${age}\nsource=${source}\nbuiltAt=${diag?.builtAt}\nblobKey=${BLOB_KEY}\nms=${
      t1 - t0
    }\n\nTry: /search?q=finalize pending\nTry: /debug\nTry: /rebuild?force=1\n`,
  );
}

async function handleDebug(): Promise<Response> {
  const { diag } = await buildIndex(false, { allowNotion: false });
  return json(diag);
}

async function handleSearch(url: URL): Promise<Response> {
  const q = url.searchParams.get("q") || "";
  const { chunks, source } = await buildIndex(false, { allowNotion: false });
  const hits = rank(q, chunks, 6);

  const out = [
    `Query: ${q}`,
    `Matches: ${hits.length}`,
    `Index source: ${source}`,
    "",
    ...hits.map((h, i) => {
      const label = shortStepFromChunkText(h.chunk.text, h.chunk.pageTitle);
      const snippet = h.chunk.text.slice(0, 260).replaceAll("\n", " ");
      return [
        `${
          i + 1
        }. ${h.chunk.pageTitle} — ${h.chunk.sectionTitle} (score=${h.score})`,
        `   Source: ${h.chunk.url}`,
        `   Step label: ${label}`,
        `   Snippet: ${snippet}${h.chunk.text.length > 260 ? "…" : ""}`,
      ].join("\n");
    }),
  ].join("\n");

  return text(out);
}

// Slack handlers

async function handleSlackCommand(
  _req: Request,
  rawBody: string,
): Promise<Response> {
  const form = new URLSearchParams(rawBody);
  const question = (form.get("text") || "").trim();
  const user_name = form.get("user_name") || "unknown";
  const channel_id = form.get("channel_id") || "";
  const channel_name = form.get("channel_name") || "unknown";

  const ack = new Response(
    JSON.stringify({
      response_type: "ephemeral",
      text: `Working on it… I'll post in a thread in #${channel_name}.`,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );

  (async () => {
    try {
      if (!channel_id) {
        throw new Error("Missing channel_id from Slack command payload.");
      }

      const parent = await slackApi("chat.postMessage", {
        channel: channel_id,
        text: `🧭 CS Helper request from @${user_name}: *${
          question || "help"
        }*`,
      });
      const thread_ts = parent.ts;

      const result = await answerQuestion(question, user_name, channel_name, {
        includeLinear: false,
      });

      await slackApi("chat.postMessage", {
        channel: channel_id,
        thread_ts,
        text: "CS helper response",
        blocks: result.blocks,
      });
    } catch (e) {
      console.error("Slash command background error:", e);
      try {
        if (channel_id) {
          await slackApi("chat.postMessage", {
            channel: channel_id,
            text: `⚠️ CS Helper error. Try /rebuild then rerun.\nError: ${
              String((e as any)?.message || e)
            }`,
          });
        }
      } catch {}
    }
  })();

  return ack;
}

async function handleSlackEvents(
  _req: Request,
  rawBody: string,
): Promise<Response> {
  const payload = JSON.parse(rawBody);

  if (payload.type === "url_verification") {
    return json({ challenge: payload.challenge });
  }

  if (payload.type !== "event_callback") return json({ ok: true });

  const ev = payload.event;
  if (ev?.bot_id || ev?.subtype === "bot_message") return json({ ok: true });
  if (ev?.type !== "app_mention") return json({ ok: true });

  const channel = ev.channel;
  const ts = ev.ts;
  const thread_ts = ev.thread_ts || ts;
  const user = ev.user || "unknown";
  const question = String(ev.text || "").replace(/<@[^>]+>/g, "").trim();

  try {
    const result = await answerQuestion(question, user, channel, {
      includeLinear: true,
      linearTimeoutMs: 1200,
    });

    await slackApi("chat.postMessage", {
      channel,
      thread_ts,
      text: "CS helper response",
      blocks: result.blocks,
    });

    return json({ ok: true });
  } catch (e) {
    console.error("Slack event handler error:", e);
    await slackApi("chat.postMessage", {
      channel,
      thread_ts,
      text:
        `⚠️ I hit an error answering that. Try /rebuild then ask again.\nError: ${
          String((e as any)?.message || e)
        }`,
    });
    return json({ ok: true, error: String((e as any)?.message || e) });
  }
}

async function handleBlobDebug(): Promise<Response> {
  try {
    const allKeys = await blob.list();
    const indexData = await blobGetIndex();
    const actionKeys = await actionBlob.list(ACTION_BLOB_PREFIX);

    return json({
      ok: true,
      totalBlobs: allKeys.length,
      indexKey: INDEX_BLOB_KEY,
      indexExists: indexData !== null,
      indexChunks: indexData?.chunks?.length || 0,
      indexBuiltAt: indexData?.diag?.builtAt || null,
      actionBlobs: actionKeys.length,
      allBlobKeys: allKeys,
    });
  } catch (e) {
    return json({
      ok: false,
      error: String((e as any)?.message || e),
    }, 500);
  }
}

// Main handler (default export required by Val Town)

export default async function handler(req: Request): Promise<Response> {
  try {
    mustEnv();
    const url = new URL(req.url);

    // Root
    if (req.method === "GET" && url.pathname === "/") {
      try {
        const { chunks, source } = await buildIndex(false, {
          allowNotion: false,
        });
        const cache = getCache();
        const age = cache
          ? Math.floor((Date.now() - cache.builtAtMs) / 1000)
          : "n/a";
        return text(
          `OK\nchunks=${chunks.length}\ncache_age_sec=${age}\nsource=${source}\nblobKey=${BLOB_KEY}\n\nTry: /search?q=finalize pending\nTry: /debug\nTry: /rebuild\n`,
        );
      } catch {
        return text(`Index not ready.\nRun: /rebuild\n`, 200);
      }
    }

    // Basic endpoints
    if (req.method === "GET" && url.pathname === "/health") {
      return await handleHealth();
    }
    if (req.method === "GET" && url.pathname === "/rebuild") {
      return await handleRebuild(url);
    }
    if (req.method === "GET" && url.pathname === "/debug") {
      return await handleDebug();
    }
    if (req.method === "GET" && url.pathname === "/search") {
      return await handleSearch(url);
    }

    // Slack endpoints (verify signature)
    if (url.pathname === "/slack/command") {
      const rawBody = await req.text();
      const ok = await verifySlackSignature(req, rawBody);
      if (!ok) return text("Bad signature", 401);
      return await handleSlackCommand(req, rawBody);
    }

    if (url.pathname === "/slack/actions") {
      const rawBody = await req.text();
      const ok = await verifySlackSignature(req, rawBody);
      if (!ok) return text("Bad signature", 401);
      return await handleSlackActions(req, rawBody);
    }

    if (url.pathname === "/slack/events") {
      const rawBody = await req.text();
      const ok = await verifySlackSignature(req, rawBody);
      if (!ok) return text("Bad signature", 401);
      return await handleSlackEvents(req, rawBody);
    }

    if (url.pathname === "/slack/debug-command") {
      const rawBody = await req.text();
      return json({
        ok: true,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        rawBody,
      });
    }

    if (url.pathname === "/slack/ping") {
      return new Response("OK", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Debug endpoint
    if (req.method === "GET" && url.pathname === "/blob-debug") {
      return await handleBlobDebug();
    }

    return text("Not found", 404);
  } catch (e: any) {
    console.error(e);
    return text(`Exception: ${e?.stack || e?.message || String(e)}`, 500);
  }
}

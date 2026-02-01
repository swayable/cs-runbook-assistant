// slack/actions.ts — Slack interactive actions handler

import { LINEAR_LABEL_NAME, LINEAR_TEAM_KEY } from "../env.ts";
import { consumeAction } from "../storage/actionStore.ts";
import { json } from "../util/response.ts";
import { slackApi } from "./api.ts";
import { createLinearTicket } from "../pipeline/answerQuestion.ts";

export async function handleSlackActions(
  _req: Request,
  rawBody: string,
): Promise<Response> {
  const form = new URLSearchParams(rawBody);
  const payloadStr = form.get("payload");
  if (!payloadStr) return json({ ok: false, error: "Missing payload" }, 400);

  const payload = JSON.parse(payloadStr);
  const action = payload.actions?.[0];
  if (!action) return json({ ok: true });

  const channelId = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const threadTs = payload.message?.thread_ts || messageTs;

  const postThread = async (textMsg: string) => {
    if (!channelId || !threadTs) return;
    await slackApi("chat.postMessage", {
      channel: channelId,
      thread_ts: threadTs,
      text: textMsg,
    });
  };

  const disableButtons = async (textMsg: string) => {
    if (!channelId || !messageTs) return;
    try {
      await slackApi("chat.update", {
        channel: channelId,
        ts: messageTs,
        text: textMsg,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: textMsg } }],
      });
    } catch (e) {
      console.error("chat.update failed (non-fatal):", e);
    }
  };

  if (action.action_id === "dismiss") {
    await postThread(
      "Okay — add more context in this thread and mention @cs-helper to try again.",
    );
    await disableButtons("Dismissed — continue the discussion in-thread.");
    return json({ ok: true });
  }

  if (action.action_id === "create_linear_ticket") {
    const actionId = String(action.value || "").trim();
    if (!actionId) {
      await postThread("⚠️ Missing action id. Please run /cs-help again.");
      return json({ ok: true, missing: true });
    }

    const v = await consumeAction(actionId);
    if (!v) {
      await postThread(
        "That ticket action expired. Please run /cs-help again to regenerate it.",
      );
      await disableButtons("Ticket action expired — rerun /cs-help.");
      return json({ ok: true, expired: true });
    }

    try {
      const created = await createLinearTicket({
        title: v.title,
        description: v.description,
        teamKey: LINEAR_TEAM_KEY,
        labelName: LINEAR_LABEL_NAME,
      });

      await postThread(
        `✅ Ticket filed: ${created.identifier} — ${created.url}`,
      );
      await disableButtons(
        `✅ Ticket filed: ${created.identifier} — ${created.url}`,
      );
      return json({ ok: true, created });
    } catch (e) {
      console.error("Linear ticket creation failed:", e);
      await postThread(
        `⚠️ Failed to create ticket. Please try again, or file manually.\nError: ${
          String((e as any)?.message || e)
        }`,
      );
      return json({ ok: true, error: String((e as any)?.message || e) });
    }
  }

  return json({ ok: true });
}

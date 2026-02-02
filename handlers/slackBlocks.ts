// handlers/slackBlocks.ts — Slack block builders and response construction
// Extracted from main.ts to reduce file size

import type { ClassifierResult, FollowupEntry } from "../types/index.ts";
import type { DirectorDecision } from "../director/index.ts";
import type { LinearIssue, LLMSelectedIssue } from "../linear/api.ts";
import type { Ranked } from "./llm.ts";

// ============================================================================
// Utilities
// ============================================================================

function uniq<T>(a: T[]): T[] {
  return Array.from(new Set(a));
}

/**
 * Extract Linear ticket URLs from text content (runbook chunks, slack messages, etc.)
 * Looks for URLs like: https://linear.app/team/issue/TEAM-123
 */
export function extractLinearUrls(text: string): string[] {
  if (!text) return [];
  // Match Linear URLs - handles various formats
  const linearUrlPattern = /https?:\/\/linear\.app\/[a-z0-9-]+\/issue\/[A-Z]+-\d+[^\s)>\]"]*/gi;
  const matches = text.match(linearUrlPattern) || [];
  return uniq(matches);
}

/**
 * Extract Linear ticket URLs from an array of chunks
 */
export function extractLinearUrlsFromChunks(chunks: Array<{ text: string; ticketRefs?: string[] }>): string[] {
  const urls: string[] = [];
  for (const chunk of chunks) {
    // Get from text
    urls.push(...extractLinearUrls(chunk.text));
    // Get from ticketRefs if available
    if (chunk.ticketRefs) {
      urls.push(...chunk.ticketRefs.filter((r) => r.includes("linear.app")));
    }
  }
  return uniq(urls);
}

// ============================================================================
// Help Content Builders (CEO-friendly)
// ============================================================================

/**
 * Build plain text help content for web endpoints.
 */
export function buildHelpText(): string {
  return `CS Helper — Your Customer Support Assistant

I help CS teams quickly find the right runbook steps and triage customer issues.

📋 TRIAGING DELIVERY ISSUES
• "Analysis is stuck in pending state"
• "Finalize not showing up for test"
• "ModelPrepSyncError after adding segment"
• "Survey responses not appearing in tracker"

🔍 FINDING RUNBOOK STEPS
• "How do I reanalyze a test?"
• "Steps to reset participant data"
• "What to check when export fails"

📝 COLLECTING REQUIRED INFO
• "What info do I need for a stuck analysis?"
• "What should I gather before escalating a tracker issue?"

🎫 WHEN TO FILE A TICKET
• Describe the issue and I'll suggest whether to escalate
• I'll help you identify possible duplicate tickets
• I'll pre-fill the ticket with relevant context

💡 Tips:
• Include specific error messages for better matches
• Mention the feature area (tracker, analysis, export, etc.)
• Describe what the customer is trying to do`;
}

/**
 * Build Slack blocks for help response.
 */
export function buildHelpBlocks(): any[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*CS Helper — Your Customer Support Assistant*\n\nI help CS teams quickly find the right runbook steps and triage customer issues.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*📋 Triaging Delivery Issues*\n• `analysis is stuck in pending state`\n• `finalize not showing up for test`\n• `ModelPrepSyncError after adding segment`\n• `survey responses not appearing in tracker`",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*🔍 Finding Runbook Steps*\n• `how do I reanalyze a test?`\n• `steps to reset participant data`\n• `what to check when export fails`",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*📝 Collecting Required Info*\n• `what info do I need for a stuck analysis?`\n• `what should I gather before escalating?`",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*🎫 When to File a Ticket*\n• Describe the issue and I'll suggest whether to escalate\n• I'll help identify possible duplicate tickets\n• I'll pre-fill the ticket with relevant context",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "💡 *Tip:* Include specific error messages, feature area, and what the customer is trying to do for better matches.",
        },
      ],
    },
  ];
}

/**
 * Build Slack blocks for supportive response when unclear.
 * NOTE: This is now used for any unclear/unmatched query, not just "out of scope".
 */
export function buildSupportiveBlocks(llmSummary?: string, nextActions?: string[]): any[] {
  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: llmSummary
          ? `*Let me help you with that*\n\n${llmSummary}`
          : "*I'd like to help with this issue*\n\nI couldn't find a specific runbook match, but I can still assist you.",
      },
    },
  ];

  if (nextActions && nextActions.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Suggested next steps:*\n${nextActions.slice(0, 6).map((a) => `• ${a}`).join("\n")}`,
      },
    });
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*I can help with:*\n• Customer issues and troubleshooting\n• Finding runbook steps and procedures\n• Triaging delivery problems\n• Gathering required info for escalations",
    },
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "💡 For best results, include specific error messages, customer names, or feature areas in your question.",
      },
    ],
  });

  return blocks;
}

// ============================================================================
// Slack Modal Builder (for follow-up input)
// ============================================================================

/**
 * Build a Slack modal for follow-up question input.
 * @param channelId - The channel ID for thread context
 * @param threadTs - The thread timestamp for context
 * @returns Modal view object for Slack views.open
 */
export function buildFollowupModal(channelId: string, threadTs: string): any {
  return {
    type: "modal",
    callback_id: "followup_modal_submit",
    private_metadata: JSON.stringify({ channelId, threadTs }),
    title: {
      type: "plain_text",
      text: "Ask a follow-up",
    },
    submit: {
      type: "plain_text",
      text: "Send",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Ask a follow-up question about this issue. I'll search the same runbooks and provide additional guidance.",
        },
      },
      {
        type: "input",
        block_id: "followup_input_block",
        element: {
          type: "plain_text_input",
          action_id: "followup_text",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "e.g., What if the customer already tried refreshing? How do I check the diagnostics page?",
          },
        },
        label: {
          type: "plain_text",
          text: "Follow-up question",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "💡 *Tip:* Be specific about what you need clarification on. Include error messages or symptoms if relevant.",
          },
        ],
      },
    ],
  };
}

// ============================================================================
// Response Construction
// ============================================================================

export function requiredInfoList(question: string): string[] {
  const q = question.toLowerCase();
  const base = [
    "Test / survey URL(s) (setup / diagnostics / tracker links)",
    "Test ID(s) and client/org name",
    "Expected vs observed behavior",
    "Timestamp(s) + timezone, and what changed recently",
    "Whether this blocks delivery + deadline / urgency",
    "Screenshots of relevant UI state",
  ];
  if (q.includes("pending") || q.includes("finalize")) {
    base.unshift("Diagnostics URL + screenshot showing Pending/Finalize state");
  }
  if (q.includes("tracker") || q.includes("monthly") || q.includes("backfill")) {
    base.unshift("Tracker URL + requested breakdown/time buckets + exact questions/metrics");
  }
  return uniq(base);
}

export function shortStepFromChunkText(text: string, fallback: string): string {
  const lines = text.split("\n").map((x) => x.trim()).filter((x) => x.length > 0);

  const isJunk = (s: string) => {
    const t = s.toLowerCase();
    return (
      t.startsWith("🎫 ticket reference") ||
      t.startsWith("ticket reference") ||
      t.startsWith("keywords:") ||
      t.startsWith("why do this") ||
      t.startsWith("why/when") ||
      t.startsWith("note:") ||
      t.startsWith("todo:") ||
      t.startsWith("context:") ||
      t.startsWith("description") ||
      t.includes("linear.app/") ||
      t.includes("notion.so/") ||
      t === "—" ||
      t === "-"
    );
  };

  const looksLikeAction = (s: string) => {
    const t = s.toLowerCase();
    return (
      /^\d+[\).\s]/.test(s) ||
      t.startsWith("go to") ||
      t.startsWith("open") ||
      t.startsWith("check") ||
      t.startsWith("confirm") ||
      t.startsWith("click") ||
      t.startsWith("run") ||
      t.startsWith("refresh") ||
      t.startsWith("verify") ||
      t.startsWith("copy") ||
      t.startsWith("paste") ||
      t.startsWith("reanalyze") ||
      t.startsWith("finalize") ||
      t.startsWith("update") ||
      t.startsWith("disable") ||
      t.startsWith("enable")
    );
  };

  for (const line of lines) {
    if (!isJunk(line) && looksLikeAction(line)) {
      return line.length > 140 ? line.slice(0, 137) + "…" : line;
    }
  }
  for (const line of lines) {
    if (!isJunk(line)) {
      return line.length > 140 ? line.slice(0, 137) + "…" : line;
    }
  }
  return fallback.length > 140 ? fallback.slice(0, 137) + "…" : fallback;
}

export function buildTicketDescription(args: {
  question: string;
  slackUser?: string;
  slackChannel?: string;
  runbookHits: Ranked[];
  duplicates: LinearIssue[];
}): string {
  const runbookLines = args.runbookHits.length > 0
    ? args.runbookHits
        .map((h, i) => {
          const label = shortStepFromChunkText(h.chunk.text, h.chunk.pageTitle);
          return `${i + 1}. ${h.chunk.pageTitle} — ${h.chunk.sectionTitle}\n   ${h.chunk.url}\n   Step label: ${label}\n   score=${h.score} codeSignals=${h.chunk.codeSignals}`;
        })
        .join("\n")
    : "(none)";

  const dupLines = args.duplicates.length > 0
    ? args.duplicates
        .map((d) => `- ${d.identifier} — ${d.title} (${d.state?.name || "Unknown"})\n  ${d.url}`)
        .join("\n")
    : "(none found)";

  return [
    "## CS Escalation",
    "",
    `**Slack user:** ${args.slackUser || "unknown"}`,
    `**Slack channel:** ${args.slackChannel || "unknown"}`,
    "",
    "### Question",
    args.question,
    "",
    "### Runbook pointers (what the bot found)",
    runbookLines,
    "",
    "### Possible duplicates",
    dupLines,
    "",
    "### Required info checklist",
    requiredInfoList(args.question).map((x) => `- [ ] ${x}`).join("\n"),
  ].join("\n");
}

// Debug info type for no-match responses
export type NoMatchDebugInfo = {
  indexStatus: "ready" | "not_ready" | "empty";
  chunkCount: number;
  tokensExtracted: string[];
  topCandidateScore?: number;
  topCandidateTitle?: string;
  searchUrl?: string;
};

// Build Slack blocks for no_relevant response - SUPPORTIVE and ACTION-ORIENTED
export function buildNoRelevantBlocks(args: {
  question: string;
  requiredInfo: string[];
  llmSummary?: string;
  nextActions?: string[]; // From LLM response
  actionId?: string;
  threadKey?: string; // channelId:threadTs for follow-up button
  directorHint?: DirectorDecision;
  // New: sources and tickets
  weakHits?: Ranked[]; // Weak matches to show even when below threshold
  relatedTickets?: LLMSelectedIssue[]; // Related tickets from Linear
  debugInfo?: NoMatchDebugInfo; // Debug info for troubleshooting
}): any[] {
  // SUPPORTIVE header - never dismissive
  const headerText = "*Let me help you with this*";

  // Use LLM summary if available, otherwise provide supportive fallback
  const summaryText = args.llmSummary
    ? args.llmSummary
    : "I couldn't find a specific runbook match, but I can still help you work through this issue.";

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${headerText}\n\n${summaryText}`,
      },
    },
  ];

  // Show next actions from LLM if available
  if (args.nextActions && args.nextActions.length > 0) {
    const actionsText = args.nextActions.slice(0, 6).map((a) => `• ${a}`).join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Suggested next steps:*\n${actionsText}`,
      },
    });
  }

  // ALWAYS show Sources section - even when empty
  let sourcesText: string;
  if (args.weakHits && args.weakHits.length > 0) {
    // Show weak matches with low scores
    sourcesText = args.weakHits
      .slice(0, 3)
      .map((h) => {
        const snippet = shortStepFromChunkText(h.chunk.text, h.chunk.sectionTitle);
        return `• <${h.chunk.url}|${h.chunk.pageTitle}> — ${h.chunk.sectionTitle}\n  _${snippet}_`;
      })
      .join("\n");
    sourcesText = `*Sources* (weak matches, below threshold):\n${sourcesText}`;
  } else {
    // No matches at all
    sourcesText = "*Sources:* none found";

    // Add debug hints if available
    if (args.debugInfo) {
      const hints: string[] = [];
      if (args.debugInfo.indexStatus === "not_ready") {
        hints.push("• Index not ready — run `/rebuild` to build it");
      } else if (args.debugInfo.indexStatus === "empty") {
        hints.push("• Index is empty — run `/rebuild` to populate it");
      }
      if (args.debugInfo.tokensExtracted.length > 0) {
        hints.push(`• Searched for: ${args.debugInfo.tokensExtracted.slice(0, 5).join(", ")}`);
      }
      if (args.debugInfo.topCandidateScore !== undefined) {
        hints.push(`• Closest match: "${args.debugInfo.topCandidateTitle}" (score: ${args.debugInfo.topCandidateScore.toFixed(2)})`);
      }
      if (args.debugInfo.searchUrl) {
        hints.push(`• Try: ${args.debugInfo.searchUrl}`);
      }
      if (hints.length > 0) {
        sourcesText += "\n" + hints.join("\n");
      }
    }
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: sourcesText },
  });

  // ALWAYS show Related Tickets section - even when empty
  let ticketsText: string;
  if (args.relatedTickets && args.relatedTickets.length > 0) {
    ticketsText = args.relatedTickets
      .slice(0, 5)
      .map((t) => `• <${t.issue.url}|${t.issue.identifier}> — ${t.issue.title}\n  _${t.reason}_`)
      .join("\n");
  } else {
    ticketsText = "• None found in last 7 days";
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Related tickets (last 7 days):*\n${ticketsText}` },
  });

  // Always show info to collect (helpful for escalation)
  const reqInfoText = args.requiredInfo.slice(0, 6).map((x) => `• ${x}`).join("\n");
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Info to collect for this issue:*\n${reqInfoText}`,
    },
  });

  // Helpful hint with example refined questions
  const exampleQuestions = [
    "analysis stuck in pending for [customer name]",
    "finalize button missing on [test URL]",
    "ModelPrepSyncError after adding segment",
  ];
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `💡 *Tip:* Try rephrasing with specific error messages or feature areas.\n*Examples:* ${exampleQuestions.map((q) => `\`${q}\``).join(", ")}`,
      },
    ],
  });

  // Build action buttons
  const actionElements: any[] = [];

  // Add follow-up button if threadKey is provided
  if (args.threadKey) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Ask a follow-up" },
      action_id: "ask_followup",
      value: args.threadKey,
    });
  }

  if (args.actionId) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "File ENG ticket (CS Requests)" },
      action_id: "create_linear_ticket",
      value: args.actionId,
    });
  }

  actionElements.push({
    type: "button",
    text: { type: "plain_text", text: "Dismiss" },
    action_id: "dismiss",
    value: "dismiss",
  });

  if (actionElements.length > 0) {
    blocks.push({
      type: "actions",
      elements: actionElements,
    });
  }

  return blocks;
}

// Ticket source type for grouping
export type TicketSource = "runbook" | "linear" | "slack";

// Extended ticket info with source
export type TicketWithSource = LLMSelectedIssue & {
  source: TicketSource;
};

// Build Slack blocks for runbook response with classifier results
export function buildRunbookBlocks(args: {
  summary: string;
  nextActions?: string[]; // From LLM response
  recommendation: "file_ticket" | "try_steps";
  classifier: ClassifierResult;
  runbookHits: Ranked[];
  relatedTickets: LLMSelectedIssue[]; // Tickets with LLM-provided reasons
  embeddedTicketUrls?: string[]; // Linear URLs found in runbook chunks
  slackTicketUrls?: string[]; // Linear URLs found in Slack thread
  actionId: string;
  threadKey?: string; // channelId:threadTs for follow-up button
}): any[] {
  const { classifier, recommendation } = args;

  // Build classification header
  const canHandle = classifier.can_cs_handle;
  const classificationText = canHandle
    ? `*CS can handle this* (${classifier.confidence} confidence)`
    : `*Escalate to Engineering* (${classifier.confidence} confidence)`;

  const blocks: any[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${classificationText}\n\n*Summary*\n${args.summary}` },
    },
  ];

  // Show next actions from LLM (new feature)
  if (args.nextActions && args.nextActions.length > 0) {
    const actionsText = args.nextActions.slice(0, 6).map((a) => `• ${a}`).join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Suggested next steps:*\n${actionsText}` },
    });
  }

  // Build reasons
  const reasonsText = classifier.reasons.slice(0, 3).map((r) => `• ${r}`).join("\n");

  // Show reasons for classification
  if (reasonsText) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Why?*\n${reasonsText}` },
    });
  }

  // Build CS-safe steps (only if CS can handle)
  const stepsText = canHandle && classifier.cs_safe_steps.length > 0
    ? classifier.cs_safe_steps.slice(0, 5).map((s, i) => `${i + 1}. ${s}`).join("\n")
    : null;

  // Show CS-safe steps if CS can handle
  if (stepsText) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Steps CS can take*\n${stepsText}` },
    });
  }

  // Build escalation info (always show if not CS-handlable, or as backup)
  const escalationText = classifier.escalation_info_needed.slice(0, 6).map((x) => `• ${x}`).join("\n");

  // Show escalation info if engineer required
  if (!canHandle) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Info to collect for escalation*\n${escalationText}` },
    });
  }

  // Build citations from evidence OR runbook hits - WITH SNIPPETS
  let citations: string;
  if (classifier.evidence.length > 0) {
    citations = classifier.evidence
      .slice(0, 5)
      .map((e) => {
        const snippet = e.excerpt ? `\n  _${e.excerpt.slice(0, 100)}${e.excerpt.length > 100 ? "..." : ""}_` : "";
        return `• <${e.url}|${e.pageTitle}> — ${e.sectionTitle}${snippet}`;
      })
      .join("\n");
  } else if (args.runbookHits.length > 0) {
    citations = args.runbookHits
      .slice(0, 5)
      .map((h) => {
        const snippet = shortStepFromChunkText(h.chunk.text, h.chunk.sectionTitle);
        return `• <${h.chunk.url}|${h.chunk.pageTitle}> — ${h.chunk.sectionTitle}\n  _${snippet}_`;
      })
      .join("\n");
  } else {
    citations = "• (none found)";
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Runbook sources:*\n${citations}` },
  });

  // Build related tickets with grouping by source
  const ticketGroups: string[] = [];

  // Group 1: Runbook-embedded Linear URLs
  if (args.embeddedTicketUrls && args.embeddedTicketUrls.length > 0) {
    const embeddedText = args.embeddedTicketUrls
      .slice(0, 3)
      .map((url) => {
        const idMatch = url.match(/([A-Z]+-\d+)/);
        const identifier = idMatch ? idMatch[1] : "TICKET";
        return `• <${url}|${identifier}> _(referenced in runbook)_`;
      })
      .join("\n");
    ticketGroups.push(`_From runbooks:_\n${embeddedText}`);
  }

  // Group 2: Linear API search results
  if (args.relatedTickets.length > 0) {
    const linearText = args.relatedTickets
      .slice(0, 6)
      .map((t) => {
        const stateStr = t.issue.state?.name ? ` (${t.issue.state.name})` : "";
        return `• <${t.issue.url}|${t.issue.identifier}>${stateStr} — ${t.issue.title}\n  _${t.reason}_`;
      })
      .join("\n");
    ticketGroups.push(`_From Linear (last 7 days):_\n${linearText}`);
  }

  // Group 3: Slack thread references
  if (args.slackTicketUrls && args.slackTicketUrls.length > 0) {
    const slackText = args.slackTicketUrls
      .slice(0, 3)
      .map((url) => {
        const idMatch = url.match(/([A-Z]+-\d+)/);
        const identifier = idMatch ? idMatch[1] : "TICKET";
        return `• <${url}|${identifier}> _(mentioned in thread)_`;
      })
      .join("\n");
    ticketGroups.push(`_From Slack thread:_\n${slackText}`);
  }

  // Final ticket text
  let ticketText: string;
  if (ticketGroups.length === 0) {
    ticketText = "• None found in last 7 days";
  } else {
    ticketText = ticketGroups.join("\n\n");
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Related tickets:*\n${ticketText}` },
  });

  // Build action buttons
  const actionElements: any[] = [];

  // Add follow-up button first if threadKey is provided
  if (args.threadKey) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Ask a follow-up" },
      action_id: "ask_followup",
      value: args.threadKey,
    });
  }

  // Add file ticket button ONLY when recommendation is file_ticket OR not CS-handlable
  if (recommendation === "file_ticket" || !canHandle) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "File ENG ticket (CS Requests)" },
      style: "primary",
      action_id: "create_linear_ticket",
      value: args.actionId,
    });
  }

  // Add dismiss button
  actionElements.push({
    type: "button",
    text: { type: "plain_text", text: canHandle ? "Resolved — no ticket needed" : "Dismiss" },
    action_id: "dismiss",
    value: "dismiss",
  });

  blocks.push({
    type: "actions",
    elements: actionElements,
  });

  return blocks;
}

// Build Slack blocks for follow-up response
export function buildFollowupBlocks(args: {
  followupQuestion: string;
  summary: string;
  recommendation: "file_ticket" | "try_steps";
  runbookHits: Ranked[];
  actionId: string;
  threadKey: string;
}): any[] {
  const citations = args.runbookHits.length > 0
    ? args.runbookHits
        .slice(0, 3)
        .map((h) => `• <${h.chunk.url}|${h.chunk.pageTitle}>`)
        .join("\n")
    : "• (none found)";

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Follow-up:* ${args.followupQuestion}\n\n*Answer*\n${args.summary}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Runbook sources*\n${citations}`,
      },
    },
  ];

  // Build action buttons
  const actionElements: any[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "Ask another follow-up" },
      action_id: "ask_followup",
      value: args.threadKey,
    },
  ];

  // Only show file ticket button if recommendation is file_ticket
  if (args.recommendation === "file_ticket") {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "File ENG ticket" },
      style: "primary",
      action_id: "create_linear_ticket",
      value: args.actionId,
    });
  }

  actionElements.push({
    type: "button",
    text: { type: "plain_text", text: "Done" },
    action_id: "dismiss",
    value: "dismiss",
  });

  blocks.push({
    type: "actions",
    elements: actionElements,
  });

  return blocks;
}

// Build ticket description with follow-up history
export function buildTicketDescriptionWithFollowups(args: {
  question: string;
  slackUser?: string;
  slackChannel?: string;
  runbookHits: Ranked[];
  duplicates: LinearIssue[];
  followups: FollowupEntry[];
  lastSummary: string;
}): string {
  const runbookLines = args.runbookHits.length > 0
    ? args.runbookHits
        .map((h, i) => {
          const label = shortStepFromChunkText(h.chunk.text, h.chunk.pageTitle);
          return `${i + 1}. ${h.chunk.pageTitle} — ${h.chunk.sectionTitle}\n   ${h.chunk.url}\n   Step label: ${label}\n   score=${h.score} codeSignals=${h.chunk.codeSignals}`;
        })
        .join("\n")
    : "(none)";

  const dupLines = args.duplicates.length > 0
    ? args.duplicates
        .map((d) => `- ${d.identifier} — ${d.title} (${d.state?.name || "Unknown"})\n  ${d.url}`)
        .join("\n")
    : "(none found)";

  // Build follow-up conversation trail
  const followupLines = args.followups.length > 0
    ? args.followups.map((f, i) =>
        `**Follow-up ${i + 1}** (by ${f.user} at ${new Date(f.ts).toISOString()}):\n${f.text}`
      ).join("\n\n")
    : "(none)";

  return [
    "## CS Escalation",
    "",
    `**Slack user:** ${args.slackUser || "unknown"}`,
    `**Slack channel:** ${args.slackChannel || "unknown"}`,
    "",
    "### Original Question",
    args.question,
    "",
    "### Follow-up Conversation",
    followupLines,
    "",
    "### Bot Summary",
    args.lastSummary,
    "",
    "### Runbook pointers (what the bot found)",
    runbookLines,
    "",
    "### Possible duplicates",
    dupLines,
    "",
    "### Required info checklist",
    requiredInfoList(args.question).map((x) => `- [ ] ${x}`).join("\n"),
  ].join("\n");
}

import { ACTION_ID_PREFIX } from "./blocks";

export interface WorkflowNotificationData {
  githubNumber: number;
  title: string;
  url: string;
  classification: string;
  confidence?: number;
  team?: string;
  owner?: string;
  ownerSlackMention?: string;
  summary?: string;
  writeBlocked?: boolean;
  closeRecommended?: boolean;
  writesEnabled?: boolean;
  reproductionOutcome?: string;
  lifecycleComplete?: boolean;
}

/**
 * Rich Block Kit notification for workflow completion — replaces plain text
 * walls with structured, actionable messages.
 */
export function buildWorkflowCompletionBlocks(data: WorkflowNotificationData): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  // Header
  const emoji = getClassificationEmoji(data.classification);
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `${emoji} #${data.githubNumber} — ${data.classification}` },
  });

  // Issue title + link
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*<${data.url}|${data.title}>*` },
  });

  // Fields: classification, confidence, team, owner
  const fields: Array<{ type: string; text: string }> = [
    { type: "mrkdwn", text: `*Classification:*\n${data.classification}` },
  ];
  if (data.confidence !== undefined) {
    fields.push({ type: "mrkdwn", text: `*Confidence:*\n${(data.confidence * 100).toFixed(0)}%` });
  }
  if (data.team) {
    fields.push({ type: "mrkdwn", text: `*Team:*\n${data.team}` });
  }
  if (data.ownerSlackMention || data.owner) {
    fields.push({ type: "mrkdwn", text: `*Assigned to:*\n${data.ownerSlackMention ?? data.owner}` });
  }
  if (data.reproductionOutcome) {
    fields.push({ type: "mrkdwn", text: `*Reproduction:*\n${data.reproductionOutcome}` });
  }
  blocks.push({ type: "section", fields });

  // Summary
  if (data.summary) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: data.summary.length > 500 ? `${data.summary.slice(0, 500)}…` : data.summary },
    });
  }

  // Status bar
  if (data.writeBlocked || !data.writesEnabled) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "🚫 GitHub writes blocked — labels/assignments are recommendations only" }],
    });
  } else if (data.closeRecommended) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "⏳ Closure recommended — pending grace period" }],
    });
  }

  // Action buttons
  blocks.push({
    type: "actions",
    block_id: `workflow_actions_${data.githubNumber}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "📋 View Report" },
        action_id: `${ACTION_ID_PREFIX}view_report_${data.githubNumber}`,
        value: "view_report",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "🔄 Reprocess" },
        action_id: `${ACTION_ID_PREFIX}reprocess_${data.githubNumber}`,
        value: "reprocess",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "📌 Keep Open" },
        action_id: `${ACTION_ID_PREFIX}keep_open_${data.githubNumber}`,
        value: "keep_open",
      },
    ],
  });

  // Divider
  blocks.push({ type: "divider" });

  return blocks;
}

/**
 * Proactive notification posted to the team channel (not in a thread) when
 * a workflow event completes. This is the "teammate" behaviour.
 */
export function buildProactiveNotification(data: WorkflowNotificationData): {
  text: string;
  blocks: Array<Record<string, unknown>>;
} {
  const ownerTag = data.ownerSlackMention ? ` → ${data.ownerSlackMention}` : "";
  const text = `#${data.githubNumber} classified as ${data.classification}${ownerTag}`;
  return { text, blocks: buildWorkflowCompletionBlocks(data) };
}

function getClassificationEmoji(classification: string): string {
  switch (classification) {
    case "VERIFIED": return "🐛";
    case "CANNOT_REPRODUCE": return "🔍";
    case "NOT_OBSERVED_WITH_COMPLETE_COVERAGE": return "✅";
    case "LIKELY_FIXED": return "🔧";
    case "DUPLICATE": return "🔗";
    case "NEEDS_MANUAL_INVESTIGATION": return "👤";
    case "BLOCKED_BY_OTP": return "🔐";
    case "BLOCKED_BY_KYC": return "📋";
    case "BLOCKED_BY_PAYMENT": return "💳";
    case "BLOCKED_BY_CREDENTIALS": return "🔑";
    case "BLOCKED_BY_ENVIRONMENT": return "🖥️";
    default: return "📌";
  }
}

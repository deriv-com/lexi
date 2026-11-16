import type { SlackConversationStatus } from "./types";

export function formatAcknowledgement(githubNumber: number): string {
  return [
    `Got it - I am checking issue #${githubNumber} now.`,
    "I will validate the report, choose the appropriate reproduction path, and return with evidence.",
  ].join("\n");
}

export function formatProgressUpdate(githubNumber: number, stage: SlackConversationStatus, detail?: string): string {
  const lines = [`**Update on #${githubNumber}**`];
  switch (stage) {
    case "PLANNING":
      lines.push(`Planner selected: ${detail ?? "scenario pending"}`);
      break;
    case "REPRODUCING":
      lines.push("Reproduction is running.");
      if (detail) lines.push(`Current state: ${detail}`);
      break;
    case "ANALYSING":
      lines.push("Reproduction completed. I am reviewing lifecycle coverage and policy requirements.");
      break;
    case "POLICY_EVALUATION":
      lines.push("Evaluating policy gates and recommended actions.");
      if (detail) lines.push(detail);
      break;
    case "AWAITING_HUMAN_INPUT":
      lines.push("Waiting for reproduction evidence in the tracked thread.");
      break;
    default:
      if (detail) lines.push(detail);
  }
  return lines.join("\n");
}

export function formatReproductionReplyAck(githubNumber: number): string {
  return `Thanks - I received your reproduction result and linked it to issue #${githubNumber}.`;
}

export function formatShallowReplyFollowUp(): string {
  return [
    "I cannot treat this as a complete not-reproduced result yet.",
    "Please confirm:",
    "",
    "- account type used",
    "- environment",
    "- exact steps completed",
    "- lifecycle state reached",
    "- supporting evidence",
  ].join("\n");
}

export function formatHubReachQuestion(): string {
  return "You reported that the issue was not reproduced. Did you reach the signed-in home screen?";
}

export function formatBlockedFlowQuestion(): string {
  return "What blocked the flow?";
}

export interface OutcomeSummaryInput {
  githubNumber: number;
  classification: string;
  confidence?: number;
  summary?: string;
  reasoning?: string;
  actionsTaken: string[];
  replayHint?: string;
  writeBlocked?: boolean;
  closeRecommended?: boolean;
  writesEnabled?: boolean;
}

export function formatOutcomeSummary(input: OutcomeSummaryInput): string {
  const lines = [
    `**Verification completed for #${input.githubNumber}**`,
    "",
    `Result: ${humanClassification(input.classification)}`,
  ];
  if (input.confidence !== undefined) {
    lines.push(`Confidence: ${Math.round(input.confidence * 100)}%`);
  }
  if (input.summary || input.reasoning) {
    lines.push("");
    if (input.summary) lines.push(input.summary);
    if (input.reasoning) lines.push(input.reasoning);
  }
  if (input.writeBlocked || input.closeRecommended) {
    lines.push("");
    if (input.closeRecommended && input.writesEnabled === false) {
      lines.push(
        "Policy recommends closing this issue, but execution was blocked because GOVERNED_WRITES_ENABLED=false.",
      );
    } else if (input.writeBlocked && input.writesEnabled === false) {
      lines.push("No GitHub change was made because writes are disabled (GOVERNED_WRITES_ENABLED=false).");
    }
  }
  if (input.actionsTaken.length > 0) {
    lines.push("");
    lines.push("Action taken:");
    for (const action of input.actionsTaken) {
      lines.push(`- ${action}`);
    }
  }
  if (input.replayHint) {
    lines.push("");
    lines.push(`Replay: ${input.replayHint}`);
  }
  return lines.join("\n");
}

function humanClassification(classification: string): string {
  return classification
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export const NOTIFICATION_TEMPLATES = [
  "VERIFIED",
  "NEEDS_INFO",
  "CANNOT_REPRODUCE",
  "MANUAL_INVESTIGATION",
  "REMINDER",
  "ESCALATION",
] as const;

export type NotificationTemplateName = (typeof NOTIFICATION_TEMPLATES)[number];

export interface NotificationIssueContext {
  number: number;
  title: string;
  url: string;
  repoOwner: string;
  repoName: string;
}

export interface NotificationDecisionContext {
  classification: string;
  summary: string;
  reasoning: string;
  nextAction: string;
  confidence: number;
}

export interface NotificationContext {
  issue: NotificationIssueContext;
  decision?: NotificationDecisionContext;
  team?: string;
  owner?: string;
  daysSinceLastUpdate?: number;
  reason?: string;
}

export interface RenderedNotification {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

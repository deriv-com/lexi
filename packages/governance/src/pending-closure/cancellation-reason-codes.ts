/**
 * Standard cancellation reason codes for pending-closure governance.
 */
export const CANCELLATION_REASON_CODES = {
  HUMAN_REACTION: "HUMAN_REACTION",
  NEW_EVIDENCE: "NEW_EVIDENCE",
  PRIORITY_ESCALATED: "PRIORITY_ESCALATED",
  SEVERITY_ESCALATED: "SEVERITY_ESCALATED",
  MATCHING_INTAKE: "MATCHING_INTAKE",
  LINKED_PR_OPENED: "LINKED_PR_OPENED",
  KEEP_OPEN: "KEEP_OPEN",
  HOLD_APPLIED: "HOLD_APPLIED",
  HUMAN_COMMENT: "HUMAN_COMMENT",
} as const;

export type CancellationReasonCode =
  (typeof CANCELLATION_REASON_CODES)[keyof typeof CANCELLATION_REASON_CODES];

export interface ClosureCancellationRecord {
  pendingClosureId: string;
  reasonCode: CancellationReasonCode;
  detectedAt: Date;
  sourceActor: string | null;
  sourceUrl: string | null;
  previousScheduledClosureAt: Date;
}

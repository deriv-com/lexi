/**
 * Agent-routing contracts.
 */

/**
 * Coarse request classification. Its only job is tool subsetting: the registry
 * sends the schemas for the classified class instead of all ~40 on every turn,
 * which is fixed overhead paid on every turn of every loop iteration today.
 *
 * These are *classes*, not the individual intents in `fast-intent-router.ts` —
 * several fast intents map onto one class.
 */
export type IntentClass =
  /** Someone is reporting a bug and wants it triaged or fixed. */
  | "bug_intake"
  /** Questions about a specific issue: status, evidence, why it is open. */
  | "issue_query"
  /** Cross-issue analysis: portfolio queries, batches, corpus health. */
  | "portfolio"
  /** A code change that is not a bug fix. */
  | "code_task"
  /** Clarification and spec drafting. */
  | "spec"
  /** Work-item lifecycle: create, assign, board placement. */
  | "work_item"
  /** Delivery tracking, reminders, escalation. */
  | "delivery"
  /** Product questions answered from indexed knowledge. */
  | "knowledge"
  /** Diagnostics and self-reporting: `/lexi diag`, capabilities, cost. */
  | "diagnostics"
  /** Unclassified — receives the full tool set, so routing never loses ability. */
  | "unknown";

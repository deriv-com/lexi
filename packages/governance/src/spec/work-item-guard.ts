/**
 * Work-item guard — the feature variant of the bug vocabulary
 *.
 *
 * `never-touch-policy.ts` is not replaced or forked by this module. It stays
 * the guard for production *issues*, where P0/P1 and S1/S2 are real and
 * meaningful. This is its sibling for work items, where they are not: a
 * feature has no severity, and asking whether one was "reproduced" is a
 * category error.
 *
 * What the two share is the shape of the answer — `{ protected, reasons }` —
 * so `evaluateMutationGuard` and every caller downstream of it reads the same
 * decision regardless of which vocabulary produced it.
 */

import {
  isKnownWorkItemKind,
  type FeaturePolicy,
  type WorkItemKind,
  type WorkItemPredicate,
} from "./feature-policy.schema";

export const WORK_ITEM_GUARD_REASONS = {
  UNKNOWN_KIND: "unknown_work_item_kind",
  UNKNOWN_STATUS: "unknown_work_item_status",
  MISSING_REQUIRED_FIELDS: "missing_required_fields",
  NO_POLICY_MATCH: "no_policy_match",
} as const;

export type WorkItemGuardReason =
  (typeof WORK_ITEM_GUARD_REASONS)[keyof typeof WORK_ITEM_GUARD_REASONS];

export interface WorkItemNeverTouchInput {
  kind: WorkItemKind;
  status: string;
  hasRecentHumanActivity: boolean;
  hasOpenLinkedPR: boolean;
  isExplicitlyAssigned: boolean;
  /** Whether an approved spec backs this item. Informational here; enforced at dispatch. */
  hasApprovedSpec: boolean;
  /** Whether other work items were broken down from this one. */
  hasDependentWorkItems: boolean;
}

export interface WorkItemNeverTouchEvaluation {
  protected: boolean;
  reasons: string[];
  requiredOverride?: "human-gated" | "prohibited";
}

export interface RequiredFieldsResult {
  satisfied: boolean;
  missing: string[];
  reasons: WorkItemGuardReason[];
}

/** A field counts as present only when it carries non-blank content. */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Which fields must be present before an item of this kind may be dispatched.
 *
 * Fails closed twice: an unrecognised kind is refused outright, and a kind
 * with no configured row is refused rather than treated as "requires
 * nothing" — an empty policy row is an unconfigured policy, not a permissive
 * one.
 */
export function evaluateRequiredFields(
  kind: WorkItemKind,
  fields: Record<string, unknown>,
  policy: FeaturePolicy,
): RequiredFieldsResult {
  if (!isKnownWorkItemKind(kind)) {
    return {
      satisfied: false,
      missing: [],
      reasons: [WORK_ITEM_GUARD_REASONS.UNKNOWN_KIND],
    };
  }

  const required = policy.vocabulary.requiredFields[kind];
  if (required.length === 0) {
    return {
      satisfied: false,
      missing: [],
      reasons: [WORK_ITEM_GUARD_REASONS.NO_POLICY_MATCH],
    };
  }

  const missing = required.filter((field) => !isPresent(fields[field]));
  return {
    satisfied: missing.length === 0,
    missing,
    reasons: missing.length === 0 ? [] : [WORK_ITEM_GUARD_REASONS.MISSING_REQUIRED_FIELDS],
  };
}

/** Reads a predicate off the input by its configured name. */
function predicateValue(input: WorkItemNeverTouchInput, predicate: WorkItemPredicate): boolean {
  switch (predicate) {
    case "hasRecentHumanActivity":
      return input.hasRecentHumanActivity;
    case "hasOpenLinkedPR":
      return input.hasOpenLinkedPR;
    case "isExplicitlyAssigned":
      return input.isExplicitlyAssigned;
    case "hasDependentWorkItems":
      return input.hasDependentWorkItems;
    default: {
      // Exhaustiveness: adding a predicate to the schema without handling it
      // here is a compile error rather than a silently absent protection.
      const never: never = predicate;
      return never;
    }
  }
}

/** Human-readable label for a predicate, used in the reason strings. */
const PREDICATE_LABELS: Record<WorkItemPredicate, string> = {
  hasRecentHumanActivity: "Recent human activity on the work item",
  hasOpenLinkedPR: "Open linked PR — active engineering work in progress",
  isExplicitlyAssigned: "Explicitly assigned to a person",
  hasDependentWorkItems: "Other work items depend on this one",
};

/**
 * Evaluate whether a work item is protected from destructive automation.
 *
 * Fails closed on both unknowns: a status outside the configured list and a
 * kind outside the configured kinds both protect. An item this build cannot
 * classify is precisely the item automation should not be rewriting.
 */
export function evaluateWorkItemNeverTouch(
  input: WorkItemNeverTouchInput,
  policy: FeaturePolicy,
): WorkItemNeverTouchEvaluation {
  const reasons: string[] = [];

  if (!isKnownWorkItemKind(input.kind) || !policy.workItems.kinds.includes(input.kind)) {
    reasons.push(`Unknown work-item kind: ${input.kind}`);
    return { protected: true, reasons, requiredOverride: "human-gated" };
  }

  if (policy.workItems.statuses.length > 0 && !policy.workItems.statuses.includes(input.status)) {
    reasons.push(`Unknown status: ${input.status}`);
    return { protected: true, reasons, requiredOverride: "human-gated" };
  }

  if (policy.workItems.terminalStatuses.includes(input.status)) {
    reasons.push(`Work item is in a terminal status: ${input.status}`);
  }

  for (const predicate of policy.vocabulary.neverTouchPredicates[input.kind]) {
    if (predicateValue(input, predicate)) {
      reasons.push(PREDICATE_LABELS[predicate]);
    }
  }

  const isProtected = reasons.length > 0;
  return {
    protected: isProtected,
    reasons,
    // Nothing here is prohibited-level. A work item is planning state; the
    // prohibited tier stays reserved for merge, security mutation and
    // direct AI closure.
    requiredOverride: isProtected ? "human-gated" : undefined,
  };
}

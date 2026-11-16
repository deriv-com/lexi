/**
 * Never-Touch Policy.
 *
 * Automation must NOT destructively act on protected issues.
 * Violations produce a governance incident, not a silent skip.
 */

export interface NeverTouchInput {
  labels: string[];
  priority?: string;
  severity?: string;
  hasRecentHumanActivity: boolean; // Comment/reaction within 48h
  hasOpenLinkedPR: boolean;
  isExplicitlyAssigned: boolean;
  hasActiveEngineeringWork: boolean;
  state: "open" | "closed";
}

export interface NeverTouchEvaluation {
  protected: boolean;
  reasons: string[];
  /** If protected, the action class that would be required to override */
  requiredOverride?: "human-gated" | "prohibited";
}

export interface NeverTouchConfig {
  protectedLabels: string[];
  protectedPriorities: string[];
  protectedSeverities: string[];
  humanActivityWindowHours: number;
}

const DEFAULT_CONFIG: NeverTouchConfig = {
  protectedLabels: [
    "security",
    "security-issue",
    "compliance",
    "payment",
    "kyc",
    "keep-open",
    "hold",
    "do-not-close",
    "escalated",
  ],
  protectedPriorities: ["P0", "P1"],
  protectedSeverities: ["S1", "S2"],
  humanActivityWindowHours: 48,
};

/**
 * Evaluate whether an issue is protected from destructive automation.
 *
 * This is a HARD gate — if protected=true, destructive actions MUST NOT proceed.
 * Constructive actions (label, comment) may still be allowed.
 */
export function evaluateNeverTouch(
  input: NeverTouchInput,
  config: NeverTouchConfig = DEFAULT_CONFIG,
): NeverTouchEvaluation {
  const reasons: string[] = [];

  // Security/compliance labels — PROHIBITED
  const matchedProtectedLabels = input.labels.filter((l) =>
    config.protectedLabels.some((p) => l.toLowerCase().includes(p.toLowerCase())),
  );
  if (matchedProtectedLabels.length > 0) {
    reasons.push(`Protected label(s): ${matchedProtectedLabels.join(", ")}`);
  }

  // High priority — PROHIBITED for destructive, human-gated for delayed
  if (input.priority && config.protectedPriorities.includes(input.priority)) {
    reasons.push(`Protected priority: ${input.priority}`);
  }

  // High severity
  if (input.severity && config.protectedSeverities.includes(input.severity)) {
    reasons.push(`Protected severity: ${input.severity}`);
  }

  // Recent human activity
  if (input.hasRecentHumanActivity) {
    reasons.push("Recent human activity (comment/reaction within window)");
  }

  // Open linked PR
  if (input.hasOpenLinkedPR) {
    reasons.push("Open linked PR — active engineering work in progress");
  }

  // Explicitly assigned with active work
  if (input.isExplicitlyAssigned && input.hasActiveEngineeringWork) {
    reasons.push("Explicitly assigned with active engineering work");
  }

  // Keep-open / hold (already covered by labels but explicit for clarity)
  const holdLabels = input.labels.filter((l) =>
    ["keep-open", "hold", "do-not-close"].some((h) => l.toLowerCase() === h),
  );
  if (holdLabels.length > 0 && !reasons.some((r) => r.includes("Protected label"))) {
    reasons.push(`Hold label: ${holdLabels.join(", ")}`);
  }

  const protected_ = reasons.length > 0;

  // Determine override level
  let requiredOverride: NeverTouchEvaluation["requiredOverride"] = undefined;
  if (protected_) {
    // Security and compliance are always prohibited
    if (matchedProtectedLabels.some((l) => ["security", "security-issue", "compliance", "kyc"].includes(l.toLowerCase()))) {
      requiredOverride = "prohibited";
    } else {
      requiredOverride = "human-gated";
    }
  }

  return { protected: protected_, reasons, requiredOverride };
}

/**
 * Check if a label/priority/ownership change is a demotion that
 * violates the "no silent lowering" rule.
 */
export function isHumanSetDemotion(
  field: "priority" | "severity" | "ownership",
  oldValue: string | null,
  newValue: string | null,
  setByHuman: boolean,
): boolean {
  if (!setByHuman) return false; // Only protects human-set values
  if (!oldValue || !newValue) return false;

  if (field === "priority") {
    const order = ["P0", "P1", "P2", "P3", "P4"];
    const oldIdx = order.indexOf(oldValue);
    const newIdx = order.indexOf(newValue);
    return oldIdx >= 0 && newIdx >= 0 && newIdx > oldIdx; // Higher index = lower priority
  }

  if (field === "severity") {
    const order = ["S1", "S2", "S3", "S4"];
    const oldIdx = order.indexOf(oldValue);
    const newIdx = order.indexOf(newValue);
    return oldIdx >= 0 && newIdx >= 0 && newIdx > oldIdx;
  }

  if (field === "ownership") {
    // Removing ownership is a demotion
    return newValue === "" || newValue === "unassigned";
  }

  return false;
}

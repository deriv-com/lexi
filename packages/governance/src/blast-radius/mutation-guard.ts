/**
 * Mutation Guard — the enforcement boundary for all destructive actions.
 *
 * Sits between the orchestrator/agent and the GitHub mutation gateway.
 * Re-fetches current issue state immediately before execution so stale
 * pre-approved actions are caught if the issue changed since approval.
 *
 * Flow:
 *   Requested mutation
 *   → load current issue state (fresh from DB or GitHub)
 *   → evaluate never-touch policy
 *   → action classification
 *   → authorization check
 *   → policy decision
 *   → write gate
 *   → allow or block
 */

import { evaluateNeverTouch, type NeverTouchConfig, type NeverTouchInput } from "./never-touch-policy";
import { classifyAction, type ActionClass } from "./action-classification";

export interface MutationGuardDecision {
  allowed: boolean;
  actionClass: ActionClass;
  matchedRules: string[];
  requiredApproval?: string;
  reason: string;
  policyVersion: string;
}

export interface MutationGuardInput {
  /** The action being attempted */
  action: string;
  /** Actor performing the action (Slack ID or system identifier) */
  actorId: string;
  /** Is this actor a human (vs automation)? */
  actorIsHuman: boolean;
  /** Current issue state — must be FRESH, not cached */
  currentIssueState: {
    labels: string[];
    priority?: string;
    severity?: string;
    hasRecentHumanActivity: boolean;
    hasOpenLinkedPR: boolean;
    isExplicitlyAssigned: boolean;
    hasActiveEngineeringWork: boolean;
    state: "open" | "closed";
  };
  /** Whether global writes are enabled */
  writesEnabled: boolean;
}

export interface MutationGuardConfig {
  neverTouchConfig?: NeverTouchConfig;
  policyVersion: string;
  /** Actions that are always allowed for human actors regardless of never-touch */
  humanOverrideableActions?: string[];
}

const DEFAULT_GUARD_CONFIG: MutationGuardConfig = {
  policyVersion: "v1.0",
  humanOverrideableActions: [],
};

/**
 * Evaluate whether a mutation should proceed.
 *
 * This is the single enforcement point. Every path that mutates GitHub
 * (orchestrator, agent, scheduler, batch) MUST call this before execution.
 *
 * A prohibited result is NEVER overridable, even by humans through the agent.
 */
export function evaluateMutationGuard(
  input: MutationGuardInput,
  config: MutationGuardConfig = DEFAULT_GUARD_CONFIG,
): MutationGuardDecision {
  const matchedRules: string[] = [];

  // 1. Global write gate
  if (!input.writesEnabled) {
    return {
      allowed: false,
      actionClass: classifyAction(input.action).actionClass,
      matchedRules: ["write_gate_disabled"],
      reason: "Global write gate is disabled (GOVERNED_WRITES_ENABLED=false).",
      policyVersion: config.policyVersion,
    };
  }

  // 2. Action classification
  const classification = classifyAction(input.action);

  // 3. Prohibited actions — NEVER allowed, not even by humans
  if (classification.actionClass === "prohibited") {
    return {
      allowed: false,
      actionClass: "prohibited",
      matchedRules: ["action_prohibited"],
      reason: `Action "${input.action}" is prohibited for automation: ${classification.description}`,
      policyVersion: config.policyVersion,
    };
  }

  // 4. Constructive actions skip never-touch (labels, comments, assigns are safe)
  if (classification.actionClass === "constructive") {
    return {
      allowed: true,
      actionClass: "constructive",
      matchedRules: ["action_constructive"],
      reason: "Constructive action — allowed without destructive checks.",
      policyVersion: config.policyVersion,
    };
  }

  // 5. Never-touch evaluation (for delayed_reversible and human_gated)
  const neverTouchInput: NeverTouchInput = {
    labels: input.currentIssueState.labels,
    priority: input.currentIssueState.priority,
    severity: input.currentIssueState.severity,
    hasRecentHumanActivity: input.currentIssueState.hasRecentHumanActivity,
    hasOpenLinkedPR: input.currentIssueState.hasOpenLinkedPR,
    isExplicitlyAssigned: input.currentIssueState.isExplicitlyAssigned,
    hasActiveEngineeringWork: input.currentIssueState.hasActiveEngineeringWork,
    state: input.currentIssueState.state,
  };

  const neverTouchResult = evaluateNeverTouch(neverTouchInput, config.neverTouchConfig);

  if (neverTouchResult.protected) {
    matchedRules.push(...neverTouchResult.reasons);

    // If the protection level is "prohibited", even humans can't override
    if (neverTouchResult.requiredOverride === "prohibited") {
      return {
        allowed: false,
        actionClass: classification.actionClass,
        matchedRules,
        reason: `Issue is protected (prohibited level): ${neverTouchResult.reasons.join("; ")}`,
        policyVersion: config.policyVersion,
      };
    }

    // Human-gated: only humans with explicit approval may proceed
    if (input.actorIsHuman && config.humanOverrideableActions?.includes(input.action)) {
      matchedRules.push("human_override_allowed");
      return {
        allowed: true,
        actionClass: "human_gated",
        matchedRules,
        requiredApproval: "human_explicit",
        reason: `Issue is protected but human override is allowed for "${input.action}".`,
        policyVersion: config.policyVersion,
      };
    }

    // Automation cannot proceed on protected issues
    return {
      allowed: false,
      actionClass: classification.actionClass,
      matchedRules,
      requiredApproval: "human_gated",
      reason: `Issue is protected: ${neverTouchResult.reasons.join("; ")}. Requires human approval.`,
      policyVersion: config.policyVersion,
    };
  }

  // 6. Human-gated actions require confirmation (even if issue isn't protected)
  if (classification.actionClass === "human_gated" && !input.actorIsHuman) {
    return {
      allowed: false,
      actionClass: "human_gated",
      matchedRules: ["requires_human_confirmation"],
      requiredApproval: "human_confirmation",
      reason: `Action "${input.action}" requires human confirmation.`,
      policyVersion: config.policyVersion,
    };
  }

  // 7. Allowed
  return {
    allowed: true,
    actionClass: classification.actionClass,
    matchedRules: matchedRules.length > 0 ? matchedRules : ["no_blocking_rules"],
    reason: `Action "${input.action}" allowed (${classification.actionClass}).`,
    policyVersion: config.policyVersion,
  };
}

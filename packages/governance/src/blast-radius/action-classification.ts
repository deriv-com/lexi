/**
 * Action Classification.
 *
 * Every mutation has an action class that determines execution requirements.
 * This makes governance proportionate rather than uniformly expensive.
 */

export type ActionClass = "constructive" | "delayed_reversible" | "human_gated" | "prohibited";

export interface ActionClassification {
  actionClass: ActionClass;
  action: string;
  requiresConfirmation: boolean;
  gracePeriodMs: number; // 0 for immediate, >0 for delayed
  reversible: boolean;
  description: string;
}

/**
 * Classification table for all EIO mutations.
 */
/** The only pull-request close automation may perform. General `pull_request.close` stays prohibited. */
export const STALE_BUGFIX_PULL_REQUEST_CLOSE = "stale_bugfix.pull_request.close";

const ACTION_CLASSIFICATIONS: Record<string, ActionClassification> = {
  // Constructive — immediate when authorized
  "label.add": { actionClass: "constructive", action: "label.add", requiresConfirmation: false, gracePeriodMs: 0, reversible: true, description: "Add label to issue" },
  "label.remove": { actionClass: "constructive", action: "label.remove", requiresConfirmation: false, gracePeriodMs: 0, reversible: true, description: "Remove label from issue" },
  "comment.add": { actionClass: "constructive", action: "comment.add", requiresConfirmation: false, gracePeriodMs: 0, reversible: false, description: "Add comment to issue" },
  "assign": { actionClass: "constructive", action: "assign", requiresConfirmation: false, gracePeriodMs: 0, reversible: true, description: "Assign issue to owner" },
  "issue.create": { actionClass: "constructive", action: "issue.create", requiresConfirmation: false, gracePeriodMs: 0, reversible: false, description: "Create canonical issue" },
  "issue.update": { actionClass: "constructive", action: "issue.update", requiresConfirmation: false, gracePeriodMs: 0, reversible: true, description: "Update canonical issue" },
  "notification.send": { actionClass: "constructive", action: "notification.send", requiresConfirmation: false, gracePeriodMs: 0, reversible: false, description: "Send Slack notification" },

  // Delayed reversible — grace period with cancellation
  "close.not_observed": { actionClass: "delayed_reversible", action: "close.not_observed", requiresConfirmation: false, gracePeriodMs: 7 * 24 * 60 * 60 * 1000, reversible: true, description: "Close issue as not observed (7-day grace)" },
  "close.duplicate": { actionClass: "delayed_reversible", action: "close.duplicate", requiresConfirmation: false, gracePeriodMs: 3 * 24 * 60 * 60 * 1000, reversible: true, description: "Close issue as duplicate (3-day grace)" },
  "close.fixed": { actionClass: "delayed_reversible", action: "close.fixed", requiresConfirmation: false, gracePeriodMs: 24 * 60 * 60 * 1000, reversible: true, description: "Close issue as fixed (1-day grace)" },

  // Human-gated — explicit approval required
  "bulk_close": { actionClass: "human_gated", action: "bulk_close", requiresConfirmation: true, gracePeriodMs: 0, reversible: true, description: "Bulk close multiple issues" },
  "close.denylist": { actionClass: "human_gated", action: "close.denylist", requiresConfirmation: true, gracePeriodMs: 0, reversible: true, description: "Close issue in denylisted area" },
  "priority.lower": { actionClass: "human_gated", action: "priority.lower", requiresConfirmation: true, gracePeriodMs: 0, reversible: true, description: "Lower issue priority" },
  "severity.lower": { actionClass: "human_gated", action: "severity.lower", requiresConfirmation: true, gracePeriodMs: 0, reversible: true, description: "Lower issue severity" },
  "ownership.remove": { actionClass: "human_gated", action: "ownership.remove", requiresConfirmation: true, gracePeriodMs: 0, reversible: true, description: "Remove issue ownership" },

  // Prohibited — never executed by automation
  "close.direct_ai": { actionClass: "prohibited", action: "close.direct_ai", requiresConfirmation: false, gracePeriodMs: 0, reversible: false, description: "Direct AI-initiated closure (prohibited)" },
  "merge": { actionClass: "prohibited", action: "merge", requiresConfirmation: false, gracePeriodMs: 0, reversible: false, description: "Merge PR (prohibited for automation)" },
  "security.mutate": { actionClass: "prohibited", action: "security.mutate", requiresConfirmation: false, gracePeriodMs: 0, reversible: false, description: "Mutate security-labelled issue (prohibited)" },
  // Explicit, namespaced entries for the two PR-ending actions. `merge` above
  // already covered merging under an unqualified name, but the stale-PR chase
  // and the escalation ladder both reason in `pull_request.*` terms, and an
  // action name that is not in this table falls through to the unknown-action
  // default — which is `human_gated`, i.e. OVERRIDABLE by a confirmation.
  // That is the wrong default for a standing org constraint ("PR
  // merging or PR closing. Deliberate, permanent absence."), so both names are
  // registered explicitly. The shared table is the authority.
  "pull_request.close": { actionClass: "prohibited", action: "pull_request.close", requiresConfirmation: false, gracePeriodMs: 0, reversible: false, description: "Close a pull request (prohibited — permanent org constraint)" },
  "pull_request.merge": { actionClass: "prohibited", action: "pull_request.merge", requiresConfirmation: false, gracePeriodMs: 0, reversible: false, description: "Merge a pull request (prohibited — permanent org constraint)" },
  // The one pull-request close automation may perform: a bug-fix PR the agent
  // opened itself, and its linked issue, after the requester has been warned
  // that it will be closed. `gracePeriodMs` is only the minimum wait after that
  // warning. It is not a pending closure someone can cancel, and nothing here
  // reopens the PR. The general `pull_request.close` entry above is unchanged.
  [STALE_BUGFIX_PULL_REQUEST_CLOSE]: {
    actionClass: "delayed_reversible",
    action: STALE_BUGFIX_PULL_REQUEST_CLOSE,
    requiresConfirmation: false,
    gracePeriodMs: 20 * 60 * 60 * 1000,
    reversible: false,
    description: "Close a warned agent bug-fix pull request and its linked issue. The 20h grace is a delay only; it cannot be cancelled",
  },

  // Rebasing replays commits and force-pushes, so unlike every other ref move
  // in this table its worst case is a commit no ref reaches. Registered
  // explicitly rather than left to the unknown-action default because the
  // default is silent: an unregistered action does not appear in the capability
  // matrix's action-class section at all, which is the one place a reader goes
  // to ask what the system can do to a branch. `reversible: false` is the
  // honest answer and matches the default's — the pre-rebase tip is reported,
  // but a lease-checked force-push is not something the system can put back.
  "branch.rebase": { actionClass: "human_gated", action: "branch.rebase", requiresConfirmation: true, gracePeriodMs: 0, reversible: false, description: "Rebase a branch and force-push it (rewrites history)" },
  // Deleting a branch destroys work that was never merged, so it does not sit
  // with the constructive actions. It is registered explicitly rather than left
  // to the unknown-action default because the default's `reversible: false` is
  // wrong here and would misreport the action in the capability matrix: the
  // delete tool captures the tip sha before removing the ref, and `createRef`
  // at that sha restores the branch while GitHub still holds the commits.
  // Recoverable-with-a-receipt is a different thing from irreversible, and the
  // matrix should say which one this is.
  "branch.delete": { actionClass: "human_gated", action: "branch.delete", requiresConfirmation: true, gracePeriodMs: 0, reversible: true, description: "Delete a branch ref (recoverable from the reported tip sha)" },

  // ---- Spec pipeline --------------------------
  //
  // Authoring a spec is constructive for the same reason `issue.create` is:
  // it adds a reviewable artefact and destroys nothing. A wrong draft costs a
  // read; it does not move a workflow, close anything, or dispatch code.
  //
  // Approving one is not. Approval is what `trigger_code_task(feature)` checks
  // before dispatching a workflow that writes code into a product repo, so it
  // is the single point where a model-authored document becomes authority to
  // change software. `approve_spec` is additionally withheld from the model's
  // tool payload entirely — this classification is the second, independent
  // refusal for anything that reaches the guard by another route.
  "spec.create": { actionClass: "constructive", action: "spec.create", requiresConfirmation: false, gracePeriodMs: 0, reversible: false, description: "Draft a new spec document" },
  "spec.revise": { actionClass: "constructive", action: "spec.revise", requiresConfirmation: false, gracePeriodMs: 0, reversible: false, description: "Revise a spec, producing a new revision" },
  "spec.submit_review": { actionClass: "constructive", action: "spec.submit_review", requiresConfirmation: false, gracePeriodMs: 0, reversible: true, description: "Submit a spec revision for human review" },
  "spec.approve": { actionClass: "human_gated", action: "spec.approve", requiresConfirmation: true, gracePeriodMs: 0, reversible: true, description: "Approve a spec revision (human-only; licenses feature dispatch)" },
  // Superseding retires a spec other work items already reference. Reversible
  // in the sense that the record survives, but the pointer move is a
  // governance decision, not a bookkeeping one.
  "spec.supersede": { actionClass: "human_gated", action: "spec.supersede", requiresConfirmation: true, gracePeriodMs: 0, reversible: true, description: "Supersede a spec with a newer document (human-only)" },
  // Creating the work item is planning. Deliberately NOT extended to
  // work_item.delete / .cancel: those stay unregistered so the conservative
  // unknown-action default catches them.
  "work_item.create": { actionClass: "constructive", action: "work_item.create", requiresConfirmation: false, gracePeriodMs: 0, reversible: false, description: "Create a work item (feature/chore/spec/bug)" },
};

/**
 * The spec-pipeline additions, as an explicit list.
 *
 * Exported so tests can assert over the new surface without re-deriving it
 * by string prefix — a prefix scan would
 * silently pick up `work_item.delete` the moment someone added it.
 */
export const ADLC_ACTIONS = [
  "spec.create",
  "spec.revise",
  "spec.submit_review",
  "spec.approve",
  "spec.supersede",
  "work_item.create",
] as const;

export type AdlcAction = (typeof ADLC_ACTIONS)[number];

/**
 * Classify an action. Returns the classification with execution requirements.
 * Unknown actions are classified as human_gated (conservative default).
 */
export function classifyAction(action: string): ActionClassification {
  const classification = ACTION_CLASSIFICATIONS[action];
  if (classification) return classification;

  // Conservative default: unknown actions require human approval
  return {
    actionClass: "human_gated",
    action,
    requiresConfirmation: true,
    gracePeriodMs: 0,
    reversible: false,
    description: `Unknown action: ${action} (defaulting to human-gated)`,
  };
}

/**
 * Check if an action is allowed to proceed without human intervention.
 */
export function canExecuteAutomatically(action: string): boolean {
  const classification = classifyAction(action);
  return classification.actionClass === "constructive" || classification.actionClass === "delayed_reversible";
}

/**
 * Check if an action is absolutely prohibited for automation.
 */
export function isProhibited(action: string): boolean {
  return classifyAction(action).actionClass === "prohibited";
}

/**
 * Get all actions of a specific class.
 */
export function getActionsByClass(cls: ActionClass): ActionClassification[] {
  return Object.values(ACTION_CLASSIFICATIONS).filter((a) => a.actionClass === cls);
}

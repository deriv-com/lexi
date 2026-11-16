/**
 * CounterfactualService — "what would happen if...?" with zero execution.
 *
 * Evaluates hypothetical actions using the real authorization, policy,
 * MutationGuard, budgets, and write-gate — but NEVER executes.
 *
 * Answers questions like:
 * - "What would happen if I closed issue #856?"
 * - "Can I bulk-process all P2 Cashier issues?"
 * - "If I enabled semantic search, how many issues would have duplicates?"
 * - "What would the auto-close policy say about this issue right now?"
 */

export interface CounterfactualAction {
  action: string;
  target: { issueNumber?: number; repository?: string; query?: Record<string, unknown> };
  actorId: string;
}

export interface CounterfactualOutcome {
  action: string;
  /** Would this be authorized? */
  authorized: boolean;
  authorizationReason: string;
  /** Would policy allow it? */
  policyAllowed: boolean;
  policyReason: string;
  /** Would the write gate pass? */
  writeGateOpen: boolean;
  writeGateReason: string;
  /** Would budget allow it? */
  budgetAvailable: boolean;
  budgetReason: string;
  /** Would MutationGuard allow it? */
  mutationGuardPassed: boolean;
  mutationGuardReason: string;
  /** Net outcome: what would happen? */
  wouldExecute: boolean;
  /** Human-readable explanation. */
  explanation: string;
  /** What side effects would occur (labels added/removed, notifications, etc.)? */
  sideEffects: string[];
}

export interface CounterfactualDeps {
  checkAuthorization(actorId: string, action: string): { allowed: boolean; reason: string };
  checkPolicy(action: string, target: Record<string, unknown>): { allowed: boolean; reason: string };
  checkWriteGate(): { open: boolean; reason: string };
  checkBudget(action: string): { available: boolean; reason: string };
  checkMutationGuard(action: string, issueNumber?: number): { passed: boolean; reason: string };
}

/**
 * Evaluate a hypothetical action without execution.
 */
export function evaluateCounterfactual(
  action: CounterfactualAction,
  deps: CounterfactualDeps,
): CounterfactualOutcome {
  const authz = deps.checkAuthorization(action.actorId, action.action);
  const policy = deps.checkPolicy(action.action, action.target);
  const writeGate = deps.checkWriteGate();
  const budget = deps.checkBudget(action.action);
  const guard = deps.checkMutationGuard(action.action, action.target.issueNumber);

  const wouldExecute = authz.allowed && policy.allowed && writeGate.open && budget.available && guard.passed;

  const blockers: string[] = [];
  if (!authz.allowed) blockers.push(`Authorization: ${authz.reason}`);
  if (!policy.allowed) blockers.push(`Policy: ${policy.reason}`);
  if (!writeGate.open) blockers.push(`Write gate: ${writeGate.reason}`);
  if (!budget.available) blockers.push(`Budget: ${budget.reason}`);
  if (!guard.passed) blockers.push(`MutationGuard: ${guard.reason}`);

  const explanation = wouldExecute
    ? `This action would execute successfully. All gates pass.`
    : `This action would be BLOCKED. Reasons: ${blockers.join("; ")}`;

  const sideEffects = inferSideEffects(action.action, wouldExecute);

  return {
    action: action.action,
    authorized: authz.allowed,
    authorizationReason: authz.reason,
    policyAllowed: policy.allowed,
    policyReason: policy.reason,
    writeGateOpen: writeGate.open,
    writeGateReason: writeGate.reason,
    budgetAvailable: budget.available,
    budgetReason: budget.reason,
    mutationGuardPassed: guard.passed,
    mutationGuardReason: guard.reason,
    wouldExecute,
    explanation,
    sideEffects,
  };
}

function inferSideEffects(action: string, wouldExecute: boolean): string[] {
  if (!wouldExecute) return ["No side effects — action would be blocked."];

  const effects: string[] = [];
  switch (action) {
    case "close_issue":
      effects.push("GitHub issue state → closed");
      effects.push("Labels updated (lexi:not-observed or similar)");
      effects.push("Slack notification to team channel");
      effects.push("Audit log entry created");
      break;
    case "process_issue":
      effects.push("Workflow execution created");
      effects.push("Reproduction submitted for reproduction");
      effects.push("Budget consumed (1 issuesModified)");
      break;
    case "batch_process":
      effects.push("Multiple workflow executions created");
      effects.push("Multiple reproduction reproductions submitted");
      effects.push("Budget consumed per issue");
      break;
    case "add_to_project":
      effects.push("Issue added to GitHub Project board");
      effects.push("Project item created with default status");
      break;
    default:
      effects.push("Action-specific side effects (check governed tool documentation)");
  }
  return effects;
}

/**
 * Format the counterfactual outcome for Slack display.
 */
export function formatCounterfactualForDisplay(outcome: CounterfactualOutcome): string {
  const lines: string[] = [];
  const icon = outcome.wouldExecute ? "✅" : "🚫";

  lines.push(`${icon} *Counterfactual: "${outcome.action}"*`);
  lines.push(``);
  lines.push(`*Would execute:* ${outcome.wouldExecute ? "Yes" : "No"}`);
  lines.push(``);

  lines.push(`*Gate checks:*`);
  lines.push(`• Authorization: ${outcome.authorized ? "✅" : "❌"} ${outcome.authorizationReason}`);
  lines.push(`• Policy: ${outcome.policyAllowed ? "✅" : "❌"} ${outcome.policyReason}`);
  lines.push(`• Write gate: ${outcome.writeGateOpen ? "✅" : "❌"} ${outcome.writeGateReason}`);
  lines.push(`• Budget: ${outcome.budgetAvailable ? "✅" : "❌"} ${outcome.budgetReason}`);
  lines.push(`• MutationGuard: ${outcome.mutationGuardPassed ? "✅" : "❌"} ${outcome.mutationGuardReason}`);

  if (outcome.sideEffects.length > 0) {
    lines.push(``);
    lines.push(`*Side effects:*`);
    for (const effect of outcome.sideEffects) {
      lines.push(`• ${effect}`);
    }
  }

  return lines.join("\n");
}

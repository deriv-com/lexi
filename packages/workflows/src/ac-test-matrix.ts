/**
 * Acceptance-to-test matrix — pure evaluation, no I/O.
 *
 * Does not generate tests. A criterion with no binding is unbound. A binding
 * whose status is never `red` and never `green` is unproven (`missingRed`).
 */

import type {
  AcceptanceCriterion,
  AcceptanceTestBinding,
  AcTestMatrixEvaluation,
} from "@lexi/contracts";

export function evaluateAcTestMatrix(
  criteria: readonly AcceptanceCriterion[],
  bindings: readonly AcceptanceTestBinding[],
): AcTestMatrixEvaluation {
  const byCriterion = new Map<string, AcceptanceTestBinding[]>();
  for (const binding of bindings) {
    const list = byCriterion.get(binding.criterionId) ?? [];
    list.push(binding);
    byCriterion.set(binding.criterionId, list);
  }

  const unbound: AcceptanceCriterion[] = [];
  const proven: AcceptanceCriterion[] = [];
  const missingRed: AcceptanceCriterion[] = [];

  for (const criterion of criteria) {
    const bound = byCriterion.get(criterion.id) ?? [];
    if (bound.length === 0) {
      unbound.push(criterion);
      continue;
    }
    const hasObserved = bound.some((b) => b.status === "red" || b.status === "green");
    if (hasObserved) {
      proven.push(criterion);
    } else {
      missingRed.push(criterion);
    }
  }

  return { unbound, proven, missingRed };
}

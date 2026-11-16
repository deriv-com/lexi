import type {
  AcceptanceCriterion,
  AcceptanceTestBinding,
  AcTestMatrixEvaluation,
} from "@lexi/contracts";

/**
 * Fills the `AcTestMatrixEvaluation` contract — partitions the approved
 * criteria against the test bindings a build run reported.
 *
 * Bindings come from the rebuild repo's own `.lexi/ac-bindings.json`
 * (CI-enforced against the code, so a cited criterion with no test fails the
 * repo's own build before it ever reaches this evaluation). This function
 * only partitions; it trusts nothing and generates nothing.
 */
export function evaluateAcMatrix(
  criteria: AcceptanceCriterion[],
  bindings: AcceptanceTestBinding[],
): AcTestMatrixEvaluation {
  const unbound: AcceptanceCriterion[] = [];
  const proven: AcceptanceCriterion[] = [];
  const missingRed: AcceptanceCriterion[] = [];

  for (const criterion of criteria) {
    const own = bindings.filter((binding) => binding.criterionId === criterion.id);
    if (own.length === 0) {
      unbound.push(criterion);
      continue;
    }
    const hasColour = own.some((binding) => binding.status === "red" || binding.status === "green");
    if (hasColour) {
      proven.push(criterion);
    } else {
      // Bindings declared, no run has produced either colour — unproven, not
      // a pass (the contract's own comment on `missing`).
      missingRed.push(criterion);
    }
  }

  return { unbound, proven, missingRed };
}

/**
 * Per-criterion status for the auto-merge gate's `acMatrix`, from the same
 * bindings. Precedence: any green binding makes the criterion green (the
 * failing test has since passed); otherwise any red keeps it red; declared
 * but colourless is missing; no binding at all is unbound. The gate merges
 * only on all-green, so every other status is a named refusal, not a nuance.
 */
export function deriveAcStatuses(
  criterionIds: string[],
  bindings: AcceptanceTestBinding[],
): Array<{ criterionId: string; status: "red" | "green" | "missing" | "unbound" }> {
  return criterionIds.map((criterionId) => {
    const own = bindings.filter((binding) => binding.criterionId === criterionId);
    if (own.length === 0) return { criterionId, status: "unbound" as const };
    if (own.some((binding) => binding.status === "green")) {
      return { criterionId, status: "green" as const };
    }
    if (own.some((binding) => binding.status === "red")) {
      return { criterionId, status: "red" as const };
    }
    return { criterionId, status: "missing" as const };
  });
}

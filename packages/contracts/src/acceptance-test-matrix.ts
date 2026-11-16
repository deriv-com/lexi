/**
 * Acceptance-to-test matrix.
 *
 * The test-plan gate turns approved acceptance criteria into a test plan and
 * requires failing-test evidence before implementation. This is the binding a later
 * runner fills in; nothing here generates a test.
 */

import type { AcceptanceCriterion } from "./spec";

export type AcceptanceTestKind = "unit" | "widget" | "integration" | "e2e" | "maestro";

/**
 * RED / GREEN are observed results. `missing` means a binding was declared
 * but no run has produced either colour — unproven, not a pass.
 */
export type AcceptanceTestStatus = "red" | "green" | "missing";

export interface AcceptanceTestBinding {
  criterionId: string;
  testRef: string;
  kind: AcceptanceTestKind;
  status: AcceptanceTestStatus;
}

/**
 * Partition of the approved criteria against supplied bindings.
 *
 * - `unbound` — criterion with no binding at all.
 * - `proven` — at least one binding is `red` or `green`.
 * - `missingRed` — bindings exist, but none is `red` and none is `green`
 *   (the gate's unproven case: no failing-test evidence and no pass evidence).
 */
export interface AcTestMatrixEvaluation {
  unbound: AcceptanceCriterion[];
  proven: AcceptanceCriterion[];
  missingRed: AcceptanceCriterion[];
}

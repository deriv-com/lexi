/**
 * Security review criteria — pure evaluation, no scanner.
 *
 * Missing evidence is a non-pass. Supplying a string for a row records that
 * evidence was attached; it is not a claim that the control holds.
 */

import {
  SECURITY_REVIEW_CRITERIA,
  type SecurityCriteriaEvaluation,
  type SecurityCriteriaRefusal,
  type SecurityReviewCriterion,
} from "./security-criteria.types";

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

export function evaluateSecurityCriteria(
  evidenceById: Readonly<Record<string, string | undefined>>,
): SecurityCriteriaEvaluation {
  const refusals: SecurityCriteriaRefusal[] = [];
  const coveredIds: string[] = [];
  const missing: SecurityReviewCriterion[] = [];

  for (const criterion of SECURITY_REVIEW_CRITERIA) {
    const evidence = evidenceById[criterion.id];
    if (blank(evidence)) {
      missing.push(criterion);
      refusals.push({
        code: "MISSING_EVIDENCE",
        criterionId: criterion.id,
        detail: `${criterion.id} (${criterion.category}) has no evidence. The review does not invent a pass.`,
      });
      continue;
    }
    coveredIds.push(criterion.id);
  }

  return {
    allowed: refusals.length === 0,
    refusals,
    coveredIds,
    missing,
  };
}

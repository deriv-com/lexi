/**
 * The hardening completion gate.
 *
 * "Hardenings find nothing" is the programme's acceptance bar, and this gate
 * is where it becomes checkable: a programme in HARDENING may move to
 * COMPLETE only when the findings label's open-issue count is zero AND a human
 * has concluded the hardening pass. Both legs are required — zero open issues without
 * a concluded hardening pass just means nobody has run the hardening pass yet, and a concluded hardening pass
 * with open findings means the findings are still being fixed.
 */

export interface HardeningGateInput {
  /**
   * Open issues in the bug corpus carrying the programme's findings label
   * (`hardening_<programmeKey>` under `hardening.labelPrefix`). Titles only —
   * enough for the refusal to name what is outstanding.
   */
  openFindings: Array<{ issueNumber: number; title: string }>;
  /**
   * The human conclusion record (`programme.hardening.conclude`, a
   * team_lead-gated action). Null while no human has concluded.
   */
  concludedBy: string | null;
  policy: { requireZeroOpenFindings: boolean };
}

export interface HardeningGateVerdict {
  passed: boolean;
  /** Every failed leg, named — empty only when `passed`. */
  reasons: string[];
}

export function evaluateHardeningGate(input: HardeningGateInput): HardeningGateVerdict {
  const reasons: string[] = [];

  if (input.concludedBy === null) {
    reasons.push("no human has concluded the hardening");
  }

  if (input.policy.requireZeroOpenFindings && input.openFindings.length > 0) {
    const named = input.openFindings
      .slice(0, 5)
      .map((finding) => `#${finding.issueNumber} ${finding.title}`)
      .join("; ");
    const suffix = input.openFindings.length > 5 ? ` (and ${input.openFindings.length - 5} more)` : "";
    reasons.push(`${input.openFindings.length} open hardening finding(s): ${named}${suffix}`);
  }

  return { passed: reasons.length === 0, reasons };
}

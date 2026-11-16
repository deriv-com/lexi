import type { BugSubmission } from "./bug-submission.schema";

/**
 * Structured canonical issue body from normalized intake submission.
 */
export function normalizeIssueBody(submission: BugSubmission): string {
  const steps = submission.stepsToReproduce
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");

  const envLines = Object.entries(submission.environment)
    .filter(([, v]) => v)
    .map(([k, v]) => `- **${k}**: ${v}`)
    .join("\n");

  const accountLines = submission.accountContext
    ? Object.entries(submission.accountContext)
        .filter(([, v]) => v)
        .map(([k, v]) => `- **${k}**: ${v}`)
        .join("\n")
    : "";

  const evidenceLines = submission.evidence
    ? [
        submission.evidence.consoleLog ? "- Console log attached in submission metadata" : "",
        submission.evidence.video ? `- Video: ${submission.evidence.video}` : "",
        submission.evidence.traceId ? `- Trace: ${submission.evidence.traceId}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  return [
    "## Lexi Intake",
    "",
    "_Submitted via Lexi intake gatekeeper._",
    "",
    "## Steps to reproduce",
    steps,
    "",
    "## Expected behaviour",
    submission.expectedBehaviour,
    "",
    "## Actual behaviour",
    submission.actualBehaviour,
    "",
    "## Environment",
    envLines || "_Not specified_",
    accountLines ? "\n## Account context\n" + accountLines : "",
    evidenceLines ? "\n## Evidence\n" + evidenceLines : "",
    "",
    "---",
    `Source: ${submission.source.type}`,
  ].join("\n");
}

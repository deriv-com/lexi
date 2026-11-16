import type { EngineeringInvestigation } from "./engineering-investigation.types";
import type { FixAssessment, FixStatus } from "./fix-assessment.types";

/**
 * Deterministic fix assessment. Synthesizes engineering investigation
 * results into a structured fix likelihood.
 *
 * A merged PR alone is NEVER FIX_CONFIRMED.
 * The strongest chain is:
 *   Relevant PR merged → fix in release → release deployed →
 *   code path matches → test/production verification
 */
export function assessFixLikelihood(investigation: EngineeringInvestigation): FixAssessment {
  const now = new Date();
  const linkedIssues = investigation.linkedIssues.map(
    (i) => `${i.repo}#${i.number}`,
  );
  const linkedPullRequests = investigation.linkedPullRequests.map(
    (pr) => `${pr.repo}#${pr.number}`,
  );
  const changedFiles = investigation.linkedPullRequests.flatMap((pr) => pr.changedFiles);

  const mergedPRs = investigation.linkedPullRequests.filter((pr) => pr.state === "merged");
  const openPRs = investigation.linkedPullRequests.filter((pr) => pr.state === "open");
  const closedImplementations = investigation.linkedIssues.filter(
    (i) => i.state === "closed" && i.relationship === "implementation",
  );

  const { releaseEvidence, codeEvidence } = investigation;
  const missingEvidence: string[] = [];
  const releaseEvidenceStrings: string[] = [];

  // --- Determine status ---

  let status: FixStatus = "NO_FIX_EVIDENCE";
  let confidence = 0.0;
  let reproductionRequired = true;

  // Check for FIX_CONFIRMED (requires full chain)
  if (
    mergedPRs.length > 0 &&
    releaseEvidence.fixReleased === true &&
    releaseEvidence.deployedToProduction === true &&
    codeEvidence.fixCommitOnDefault &&
    codeEvidence.relatedTestsAdded
  ) {
    status = "FIX_CONFIRMED";
    confidence = 0.95;
    reproductionRequired = false; // Still recommend retest but don't require it
    releaseEvidenceStrings.push(
      `Fix deployed in ${releaseEvidence.releaseVersion ?? "unknown version"}`,
      "Tests added covering the fix",
    );
  }
  // LIKELY_FIXED — strong evidence but missing verification
  else if (
    mergedPRs.length > 0 &&
    releaseEvidence.fixReleased === true &&
    releaseEvidence.deployedToProduction === true
  ) {
    status = "LIKELY_FIXED";
    confidence = 0.75;
    reproductionRequired = true; // Verification needed
    releaseEvidenceStrings.push(
      `Fix released in ${releaseEvidence.releaseVersion ?? "unknown version"}`,
    );
    if (!codeEvidence.relatedTestsAdded) {
      missingEvidence.push("No related tests added — fix may be incomplete");
    }
  }
  // RELEASED_NOT_VERIFIED — released but can't confirm deployment
  else if (
    mergedPRs.length > 0 &&
    releaseEvidence.fixReleased === true &&
    releaseEvidence.deployedToProduction !== true
  ) {
    status = "RELEASED_NOT_VERIFIED";
    confidence = 0.6;
    reproductionRequired = true;
    releaseEvidenceStrings.push("Fix included in release but deployment status unknown");
    missingEvidence.push("Production deployment not confirmed");
  }
  // PR_MERGED_NOT_RELEASED — fix merged but not in a release
  else if (mergedPRs.length > 0 && !releaseEvidence.fixReleased) {
    status = "PR_MERGED_NOT_RELEASED";
    confidence = 0.5;
    reproductionRequired = false; // Wait for release first
    missingEvidence.push("Fix merged but no release contains it yet");
  }
  // FIX_IN_PROGRESS — active PR or active work
  else if (
    openPRs.length > 0 ||
    (investigation.projectStatus?.column &&
      ["in progress", "in review", "development"].includes(
        investigation.projectStatus.column.toLowerCase(),
      ))
  ) {
    status = "FIX_IN_PROGRESS";
    confidence = 0.4;
    reproductionRequired = false; // Monitor instead
    if (openPRs.length > 0) {
      missingEvidence.push(`${openPRs.length} open PR(s) — awaiting merge`);
    }
  }
  // NO_FIX_EVIDENCE — nothing found
  else {
    status = "NO_FIX_EVIDENCE";
    confidence = 0.2;
    // Reproduction depends on evidence quality (handled by necessity policy)
    reproductionRequired = true;
    missingEvidence.push("No linked PRs, no project activity, no release evidence");
  }

  // Boost confidence if code evidence aligns
  if (codeEvidence.fixCommitOnDefault && status !== "NO_FIX_EVIDENCE") {
    confidence = Math.min(1.0, confidence + 0.1);
  }
  if (codeEvidence.suspectedPatternExists === false && status !== "NO_FIX_EVIDENCE") {
    confidence = Math.min(1.0, confidence + 0.05);
    releaseEvidenceStrings.push("Suspected faulty pattern no longer exists in default branch");
  }

  // Reduce confidence if pattern still exists despite a "fix"
  if (codeEvidence.suspectedPatternExists === true && mergedPRs.length > 0) {
    confidence = Math.max(0.1, confidence - 0.15);
    missingEvidence.push("Suspected faulty pattern still exists despite merged PR");
  }

  const reasoning = buildReasoning(status, mergedPRs.length, openPRs.length, releaseEvidence, codeEvidence);

  return {
    status,
    confidence,
    linkedIssues,
    linkedPullRequests,
    changedFiles,
    releaseEvidence: releaseEvidenceStrings,
    missingEvidence,
    reproductionRequired,
    reasoning,
    assessedAt: now,
  };
}

function buildReasoning(
  status: FixStatus,
  mergedCount: number,
  openCount: number,
  release: { fixReleased: boolean | null; deployedToProduction: boolean | null; releaseVersion?: string },
  code: { fixCommitOnDefault: boolean; relatedTestsAdded: boolean; suspectedPatternExists: boolean | null },
): string {
  const parts: string[] = [];

  switch (status) {
    case "FIX_CONFIRMED":
      parts.push(`Fix confirmed: ${mergedCount} PR(s) merged, released (${release.releaseVersion}), deployed, tests added.`);
      break;
    case "LIKELY_FIXED":
      parts.push(`Likely fixed: ${mergedCount} PR(s) merged and deployed but verification incomplete.`);
      break;
    case "RELEASED_NOT_VERIFIED":
      parts.push(`Fix released but deployment to production not confirmed.`);
      break;
    case "PR_MERGED_NOT_RELEASED":
      parts.push(`${mergedCount} PR(s) merged on default branch but no release includes the fix yet.`);
      break;
    case "FIX_IN_PROGRESS":
      parts.push(`Fix in progress: ${openCount} open PR(s) or active project board item.`);
      break;
    case "NO_FIX_EVIDENCE":
      parts.push("No evidence of an existing or in-progress fix found.");
      break;
  }

  if (code.fixCommitOnDefault) parts.push("Fix commit exists on default branch.");
  if (code.relatedTestsAdded) parts.push("Related tests were added.");
  if (code.suspectedPatternExists === true) parts.push("Warning: suspected faulty pattern still present.");
  if (code.suspectedPatternExists === false) parts.push("Suspected faulty pattern is no longer present.");

  return parts.join(" ");
}

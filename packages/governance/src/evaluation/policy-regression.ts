/**
 * Policy Regression Comparison — replay labelled cases across policy versions.
 *
 * Diffs outcomes between old and new policy. Blocks unsafe rollouts when
 * a policy change causes previously-passing cases to fail, or introduces
 * new false closures/rejections.
 */

import type { GoldenCase, CaseResult, DatasetScore, CaseExecutor } from "./golden-dataset";
import { runGoldenDataset, scoreDataset } from "./golden-dataset";

export interface PolicyVersion {
  id: string;
  name: string;
  appliedAt: string;
}

export interface RegressionDiff {
  goldenId: string;
  previousOutcome: "agreed" | "disagreed";
  currentOutcome: "agreed" | "disagreed";
  /** Cases that WORSENED (agreed → disagreed). */
  regressed: boolean;
  /** Cases that IMPROVED (disagreed → agreed). */
  improved: boolean;
  previousCategory?: string;
  currentCategory?: string;
}

export interface RegressionReport {
  previousVersion: PolicyVersion;
  currentVersion: PolicyVersion;
  previousScore: DatasetScore;
  currentScore: DatasetScore;
  diffs: RegressionDiff[];
  regressions: RegressionDiff[];
  improvements: RegressionDiff[];
  /** Whether the new policy is safe to deploy. */
  safeToRollout: boolean;
  blockReasons: string[];
}

/**
 * Compare two policy runs against the same golden dataset.
 */
export function compareRuns(
  previousResults: CaseResult[],
  currentResults: CaseResult[],
  previousVersion: PolicyVersion,
  currentVersion: PolicyVersion,
  datasetVersion: string,
): RegressionReport {
  const previousScore = scoreDataset(previousResults, datasetVersion);
  const currentScore = scoreDataset(currentResults, datasetVersion);

  const diffs: RegressionDiff[] = [];
  const previousMap = new Map(previousResults.map((r) => [r.goldenId, r]));

  for (const current of currentResults) {
    const previous = previousMap.get(current.goldenId);
    if (!previous) continue;

    const diff: RegressionDiff = {
      goldenId: current.goldenId,
      previousOutcome: previous.agreed ? "agreed" : "disagreed",
      currentOutcome: current.agreed ? "agreed" : "disagreed",
      regressed: previous.agreed && !current.agreed,
      improved: !previous.agreed && current.agreed,
      previousCategory: previous.disagreementCategory,
      currentCategory: current.disagreementCategory,
    };
    diffs.push(diff);
  }

  const regressions = diffs.filter((d) => d.regressed);
  const improvements = diffs.filter((d) => d.improved);

  const blockReasons: string[] = [];

  // Block if ANY regression introduces a false closure
  const newFalseClosures = regressions.filter((r) => r.currentCategory === "false_closure");
  if (newFalseClosures.length > 0) {
    blockReasons.push(`${newFalseClosures.length} new false closure(s) introduced by policy change.`);
  }

  // Block if overall agreement rate dropped
  if (currentScore.agreementRate < previousScore.agreementRate - 0.02) {
    blockReasons.push(`Agreement rate dropped from ${(previousScore.agreementRate * 100).toFixed(1)}% to ${(currentScore.agreementRate * 100).toFixed(1)}%.`);
  }

  // Block if regressions outnumber improvements significantly
  if (regressions.length > improvements.length + 2) {
    blockReasons.push(`${regressions.length} regressions vs ${improvements.length} improvements — net negative.`);
  }

  return {
    previousVersion,
    currentVersion,
    previousScore,
    currentScore,
    diffs,
    regressions,
    improvements,
    safeToRollout: blockReasons.length === 0,
    blockReasons,
  };
}

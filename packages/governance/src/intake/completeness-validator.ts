import type { BugSubmission } from "./bug-submission.schema";

export interface CompletenessResult {
  complete: boolean;
  missingFields: string[];
}

const ACCOUNT_DEPENDENT_KEYWORDS = [
  "demo",
  "real account",
  "kyc",
  "funded",
  "deposit",
  "withdraw",
  "otp",
  "logged in",
  "after login",
  "post-signup",
  "post signup",
];

function textDependsOnAccountContext(submission: BugSubmission): boolean {
  const blob = [
    submission.title,
    submission.expectedBehaviour,
    submission.actualBehaviour,
    ...submission.stepsToReproduce,
  ]
    .join(" ")
    .toLowerCase();
  return ACCOUNT_DEPENDENT_KEYWORDS.some((kw) => blob.includes(kw));
}

/**
 * Stage 1 — deterministic completeness gate. Evidence is recommended but not required.
 */
export function validateCompleteness(submission: BugSubmission): CompletenessResult {
  const missingFields: string[] = [];

  if (!submission.title?.trim()) {
    missingFields.push("title");
  }
  if (!submission.stepsToReproduce?.length) {
    missingFields.push("stepsToReproduce");
  }
  if (!submission.expectedBehaviour?.trim()) {
    missingFields.push("expectedBehaviour");
  }
  if (!submission.actualBehaviour?.trim()) {
    missingFields.push("actualBehaviour");
  }

  const env = submission.environment ?? {};
  const hasEnv =
    env.browser ||
    env.os ||
    env.appVersion ||
    env.url ||
    env.device ||
    env.build ||
    env.commit;
  if (!hasEnv) {
    missingFields.push("environment");
  }

  if (textDependsOnAccountContext(submission) && !submission.accountContext) {
    missingFields.push("accountContext");
  }

  return { complete: missingFields.length === 0, missingFields };
}

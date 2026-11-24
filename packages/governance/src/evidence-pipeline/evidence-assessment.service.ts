import type { IssueAnalysis } from "./issue-analysis.types";
import {
  type IssueSourceType,
  type ObservationAssessment,
  SOURCE_TRUST_DEFAULTS,
} from "./evidence-assessment.types";

export interface EvidenceAssessmentInput {
  authorLogin: string | null;
  labels: string[];
  body: string | null;
  analysis: IssueAnalysis;
  /**
   * Author logins that identify a member of the organisation's own engineering
   * staff, classified as `developer` reports. Configuration, not code: every
   * organisation names its accounts differently (a `-acme` suffix, an
   * `acme-` prefix, a fixed list). Unset means no login is treated as staff;
   * labels still classify the source.
   */
  developerLoginPatterns?: readonly RegExp[];
}

/**
 * Known bot/automation author patterns — issues from these sources
 * are treated as AI-generated or automated until proven otherwise.
 */
const BOT_PATTERNS = [
  /bot$/i,
  /\[bot\]/i,
  /^dependabot/i,
  /^renovate/i,
  /^github-actions/i,
  /^snyk-/i,
  /^sentry-/i,
  /^qa-bot/i,
  /^auto-/i,
];

const DEVELOPER_LABELS = ["developer-report", "dev-report", "internal"];
const QA_LABELS = ["qa-verified", "qa-tested", "with-steps", "with-video"];
const AUTOMATED_LABELS = ["automated", "ci-detected", "test-failure", "flaky-test"];
const AI_LABELS = ["ai-generated", "ai-reported", "auto-triage"];

/**
 * Deterministic evidence assessment. Classifies the issue source and
 * evaluates evidence strength without any LLM call.
 */
export function assessEvidence(input: EvidenceAssessmentInput): ObservationAssessment {
  const sourceType = classifySource(input.authorLogin, input.labels, input.developerLoginPatterns ?? []);
  const baseTrust = SOURCE_TRUST_DEFAULTS[sourceType];

  // Adjust trust based on evidence artifacts in the body
  const evidenceStrength = assessEvidenceStrength(input.body, input.labels, input.analysis);

  // Adjust reporter trust based on report completeness
  let reporterTrust = baseTrust;
  if (input.analysis.reportCompleteness === "complete") {
    reporterTrust = Math.min(1.0, reporterTrust + 0.1);
  } else if (input.analysis.reportCompleteness === "minimal") {
    reporterTrust = Math.max(0.1, reporterTrust - 0.2);
  }

  // Determine if observed
  let observed: boolean | null = null;
  if (sourceType === "developer" || sourceType === "human_qa") {
    observed = evidenceStrength >= 0.5;
  } else if (sourceType === "automated_test") {
    observed = true; // Automation observed it, even if signal may be noisy
  } else if (sourceType === "ai_generated") {
    observed = null; // Unknown until verified
  }

  // Determine if reproduction is required
  const reasons: string[] = [];
  let requiresReproduction = false;

  if (input.analysis.likelyFalsePositive) {
    requiresReproduction = true;
    reasons.push("Issue may be a false positive — reproduction needed to verify.");
  }

  if (sourceType === "ai_generated" || sourceType === "unknown") {
    requiresReproduction = true;
    reasons.push(`Source is ${sourceType} — reproduction needed to validate.`);
  }

  if (evidenceStrength < 0.4) {
    requiresReproduction = true;
    reasons.push("Evidence strength is low — reproduction adds decision value.");
  }

  if (!requiresReproduction && reporterTrust >= 0.7 && evidenceStrength >= 0.6) {
    reasons.push("Report has sufficient evidence and trust — reproduction may be skipped if other signals confirm.");
  }

  if (!requiresReproduction && input.analysis.reproductionValue === "low") {
    reasons.push("Reproduction would add limited value for this issue type.");
  }

  if (input.analysis.reproductionValue === "high" && !requiresReproduction) {
    requiresReproduction = true;
    reasons.push("High reproduction value identified by analysis — reproduction recommended.");
  }

  return {
    observed,
    sourceType,
    evidenceStrength,
    reporterTrust,
    requiresReproduction,
    reasons,
  };
}

function classifySource(
  authorLogin: string | null,
  labels: string[],
  developerLoginPatterns: readonly RegExp[],
): IssueSourceType {
  // Check labels first (most explicit signal)
  if (labels.some((l) => AI_LABELS.includes(l.toLowerCase()))) return "ai_generated";
  if (labels.some((l) => AUTOMATED_LABELS.includes(l.toLowerCase()))) return "automated_test";
  if (labels.some((l) => QA_LABELS.includes(l.toLowerCase()))) return "human_qa";
  if (labels.some((l) => DEVELOPER_LABELS.includes(l.toLowerCase()))) return "developer";

  // Check author patterns
  if (authorLogin) {
    if (BOT_PATTERNS.some((p) => p.test(authorLogin))) return "ai_generated";
    // The organisation's own staff, by its configured login convention.
    if (developerLoginPatterns.some((p) => p.test(authorLogin))) return "developer";
  }

  // Default: unknown source
  return "unknown";
}

function hasOrderedKeywordsOnLowerLine(
  lowerText: string,
  pairs: ReadonlyArray<readonly [string, string]>,
): boolean {
  for (const line of lowerText.split(/\r?\n/)) {
    for (const [first, second] of pairs) {
      const idx = line.indexOf(first);
      if (idx !== -1 && line.indexOf(second, idx + first.length) !== -1) {
        return true;
      }
    }
  }
  return false;
}

function assessEvidenceStrength(
  body: string | null,
  labels: string[],
  analysis: IssueAnalysis,
): number {
  if (!body) return 0.1;

  let score = 0.3; // Base score for having a body

  // Evidence artifacts boost
  const bodyLower = body.toLowerCase();
  if (/screenshot|image|video|recording|screen capture/i.test(body)) score += 0.15;
  if (/steps to reproduce|how to reproduce|reproduction steps/i.test(body)) score += 0.15;
  if (
    bodyLower.includes("instead") ||
    hasOrderedKeywordsOnLowerLine(bodyLower, [
      ["expected", "actual"],
      ["actual", "expected"],
      ["should", "but"],
    ])
  ) {
    score += 0.1;
  }
  if (/error|exception|stack trace|traceback|console/i.test(body)) score += 0.1;
  if (/version|browser|os|device|environment/i.test(body)) score += 0.05;

  // Body length contributes (detailed reports are more credible)
  if (body.length > 500) score += 0.05;
  if (body.length > 1500) score += 0.05;

  // Analysis completeness contributes
  if (analysis.reportCompleteness === "complete") score += 0.1;
  if (analysis.errorStrings.length > 0) score += 0.05;

  return Math.min(1.0, score);
}

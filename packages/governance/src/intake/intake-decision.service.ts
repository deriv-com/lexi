/**
 * Intake Decision Service — the unified decision workflow for new reports.
 *
 * A new report is NOT an instruction to create a GitHub issue.
 * It is a request for Lexi to determine the correct engineering disposition.
 *
 * Flow:
 *   1. Completeness check (coach if missing fields)
 *   2. Source/evidence trust assessment
 *   3. Corpus health gate (freshness affects confidence)
 *   4. Full-corpus duplicate retrieval
 *   5. Engineering investigation (PRs, closed issues, fixes)
 *   6. Determine disposition
 *   7. Create/link/route based on outcome
 *
 * All intake surfaces (Slack, API, GitHub watcher) converge on this service.
 */

import type {
  IntakeDecisionResult,
  IntakeDisposition,
  IntakeDraftFields,
} from "./intake-decision.types";
import { validateCompleteness } from "./completeness-validator";

export interface IntakeDecisionDependencies {
  /** Count issues matching a query across the full corpus */
  countIssues: (filters: { state?: string; query?: string }) => Promise<number>;
  /** Search for potential duplicates in the full corpus */
  searchDuplicates: (title: string, body: string) => Promise<Array<{
    number: number;
    title: string;
    url: string;
    state: string;
    similarity: number;
  }>>;
  /** Check corpus freshness */
  getCorpusHealth: () => Promise<{ complete: boolean; staleRepositories: string[] }>;
  /** Check if an issue was previously fixed (a linked, merged PR) */
  checkFixEvidence: (issueNumber: number) => Promise<{
    fixed: boolean;
    prNumber?: number;
    prRepo?: string;
  } | null>;
}

export interface IntakeDecisionConfig {
  /** Similarity threshold for definite duplicate (0.0-1.0) */
  duplicateThreshold: number;
  /** Similarity threshold for possible duplicate requiring human adjudication */
  possibleDuplicateThreshold: number;
  /** Maximum coaching rounds before routing to human review */
  maxCoachingRounds: number;
  /** Whether to accept low-confidence reports (true) or route to human (false) */
  acceptLowConfidence: boolean;
  /** Policy version string */
  policyVersion: string;
}

const DEFAULT_CONFIG: IntakeDecisionConfig = {
  duplicateThreshold: 0.9,
  possibleDuplicateThreshold: 0.7,
  maxCoachingRounds: 3,
  acceptLowConfidence: true,
  policyVersion: "v1.0",
};

/**
 * Required fields for a complete bug report.
 */
const REQUIRED_FIELDS: Array<{ field: keyof IntakeDraftFields; question: string }> = [
  { field: "title", question: "What is the bug? (one-line summary)" },
  { field: "stepsToReproduce", question: "What are the steps to reproduce?" },
  { field: "expectedBehaviour", question: "What should have happened?" },
  { field: "actualBehaviour", question: "What actually happened?" },
];

const CONDITIONAL_FIELDS: Array<{ field: keyof IntakeDraftFields; question: string; condition: string }> = [
  { field: "platform", question: "Which platform? (web/mobile/API)", condition: "always helpful" },
  { field: "appVersion", question: "What app/browser version?", condition: "for reproduction" },
  { field: "environment", question: "Any environment details? (browser, OS, device)", condition: "for reproduction" },
];

/**
 * Evaluate whether collected fields are complete enough to proceed.
 */
export function evaluateCompleteness(fields: IntakeDraftFields): {
  complete: boolean;
  missingRequired: string[];
  missingOptional: string[];
  coachingQuestions: string[];
} {
  const missingRequired: string[] = [];
  const coachingQuestions: string[] = [];

  for (const { field, question } of REQUIRED_FIELDS) {
    const value = fields[field];
    if (!value || (Array.isArray(value) && value.length === 0) || (typeof value === "string" && value.trim().length === 0)) {
      missingRequired.push(field);
      coachingQuestions.push(question);
    }
  }

  const missingOptional: string[] = [];
  for (const { field, question } of CONDITIONAL_FIELDS) {
    if (!fields[field]) {
      missingOptional.push(field);
    }
  }

  return {
    complete: missingRequired.length === 0,
    missingRequired,
    missingOptional,
    coachingQuestions,
  };
}

/**
 * Determine the correct engineering disposition for a complete report.
 */
export async function evaluateIntakeDecision(
  fields: IntakeDraftFields,
  deps: IntakeDecisionDependencies,
  config: IntakeDecisionConfig = DEFAULT_CONFIG,
): Promise<IntakeDecisionResult> {
  const title = fields.title ?? "";
  const body = [
    fields.stepsToReproduce?.join("\n") ?? "",
    fields.expectedBehaviour ?? "",
    fields.actualBehaviour ?? "",
  ].join("\n");

  // 1. Check corpus health
  const corpusHealth = await deps.getCorpusHealth();

  // 2. Security bypass — always accept immediately
  const securityLabels = ["security", "security-issue", "compliance"];
  if (fields.labels?.some((l) => securityLabels.includes(l.toLowerCase()))) {
    return {
      disposition: "SECURITY_BYPASS",
      confidence: 1.0,
      reasoning: "Security-labelled report accepted immediately without duplicate or validity checks.",
      recourse: "This report was fast-tracked due to security classification.",
      corpusFreshness: { complete: corpusHealth.complete, staleRepositories: corpusHealth.staleRepositories },
      policyVersion: config.policyVersion,
    };
  }

  // 3. Search for duplicates in full corpus
  const duplicates = await deps.searchDuplicates(title, body);

  // 4. Evaluate duplicate matches
  const bestMatch = duplicates[0];

  if (bestMatch && bestMatch.similarity >= config.duplicateThreshold) {
    // High-confidence duplicate
    if (bestMatch.state === "closed") {
      // Closed duplicate — check if it's a regression
      const fixEvidence = await deps.checkFixEvidence(bestMatch.number);
      // A merged fix is enough. Release tracking was removed with release
      // management, so whether that fix ever shipped is no longer
      // known here — and a report matching an issue whose fix merged is
      // treated as a regression of it rather than parked for a retest.
      if (fixEvidence?.fixed) {
        return {
          disposition: "REGRESSION",
          confidence: bestMatch.similarity,
          reasoning: `This appears to be a regression of #${bestMatch.number}, which was previously fixed in PR #${fixEvidence.prNumber}. Creating a new regression issue.`,
          regressionOf: { number: bestMatch.number, fixPR: fixEvidence.prNumber },
          recourse: "If this is not a regression but a new distinct issue, reply and I'll create it separately.",
          corpusFreshness: { complete: corpusHealth.complete, staleRepositories: corpusHealth.staleRepositories },
          policyVersion: config.policyVersion,
        };
      }
    }

    return {
      disposition: "MATCH_EXISTING",
      confidence: bestMatch.similarity,
      reasoning: `This matches existing issue #${bestMatch.number} ("${bestMatch.title}") at ${(bestMatch.similarity * 100).toFixed(0)}% confidence. I've linked your evidence to the existing report instead of creating a duplicate.`,
      matchedIssue: { number: bestMatch.number, title: bestMatch.title, url: bestMatch.url, similarity: bestMatch.similarity, state: bestMatch.state as "open" | "closed" },
      recourse: "If you believe this is a different issue, reply 'not a duplicate' and I'll create it separately.",
      corpusFreshness: { complete: corpusHealth.complete, staleRepositories: corpusHealth.staleRepositories },
      policyVersion: config.policyVersion,
    };
  }

  if (bestMatch && bestMatch.similarity >= config.possibleDuplicateThreshold) {
    // Medium confidence — ask the reporter
    return {
      disposition: "POSSIBLE_DUPLICATE",
      confidence: bestMatch.similarity,
      reasoning: `This may match existing issue #${bestMatch.number} ("${bestMatch.title}") at ${(bestMatch.similarity * 100).toFixed(0)}% confidence. I need your input before deciding.`,
      matchedIssue: { number: bestMatch.number, title: bestMatch.title, url: bestMatch.url, similarity: bestMatch.similarity, state: bestMatch.state as "open" | "closed" },
      recourse: "Reply 'yes, it's the same' to link your evidence, or 'no, different issue' to file a new report.",
      corpusFreshness: { complete: corpusHealth.complete, staleRepositories: corpusHealth.staleRepositories },
      policyVersion: config.policyVersion,
    };
  }

  // 5. No duplicate — check if corpus was fresh
  let freshnessCaveat: string | undefined;
  if (!corpusHealth.complete) {
    freshnessCaveat = `Note: ${corpusHealth.staleRepositories.join(", ")} ${corpusHealth.staleRepositories.length === 1 ? "is" : "are"} stale. A matching issue might exist but wasn't found.`;
  }

  // 6. Accept as new
  const disposition: IntakeDisposition = corpusHealth.complete ? "ACCEPT_NEW" : "LOW_CONFIDENCE_ACCEPT";
  const confidence = corpusHealth.complete ? 0.85 : 0.6;

  return {
    disposition,
    confidence,
    reasoning: corpusHealth.complete
      ? "No existing issue matches this report. Creating a new canonical issue."
      : `No existing issue found, but corpus is incomplete (${corpusHealth.staleRepositories.join(", ")} stale). Creating with lower confidence.`,
    recourse: "If this was filed incorrectly, reply 'close this' or contact a team lead.",
    corpusFreshness: {
      complete: corpusHealth.complete,
      staleRepositories: corpusHealth.staleRepositories,
      note: freshnessCaveat,
    },
    policyVersion: config.policyVersion,
  };
}

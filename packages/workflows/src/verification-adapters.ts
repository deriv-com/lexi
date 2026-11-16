/**
 * Verification Adapters — map adapter-specific results into the canonical
 * VerificationResult contract.
 *
 * Each adapter produces one VerificationResult. Policy and downstream
 * consumers never see the adapter-specific types.
 *
 * Safety invariant: UNSUPPORTED / infra-failure / no-result can NEVER
 * become negative evidence. This is enforced here at the mapping boundary.
 */

import type { LifecycleCoverage } from "./lifecycle-coverage";
import { mergeLifecycleCoverage } from "./lifecycle-coverage";
import {
  type VerificationResult,
  type VerificationBlocker,
  type EvidenceReference,
  VERIFICATION_CONTRACT_VERSION,
  unsupportedResult,
  inconclusiveResult,
  notObservedResult,
  observedResult,
} from "./verification-contract";

// ---------------------------------------------------------------------------
// Automated Reproduction Adapter Mapping
// ---------------------------------------------------------------------------

export interface ReproductionVerificationDetails {
  reproduced?: boolean | null;
  outcomeKind?: string;
  failureCode?: string;
  blockedBy?: string;
  incompleteEvidence?: boolean;
  scenarioFit?: number;
  evaluations?: Array<{
    scenarioId: string;
    runId?: string;
    scenarioFit?: number;
    bugObserved?: boolean;
    retryRecommended?: boolean;
    reasoning?: string;
    signalsObserved?: string[];
    missingSignals?: string[];
  }>;
  evidence?: Array<{ type: string; url: string; description?: string }>;
  lifecycleCoverage?: LifecycleCoverage;
  plannerStopCondition?: string;
}

/**
 * Map an automated ReproductionResult into the canonical VerificationResult.
 *
 * This is the primary adapter mapping. The existing reproduction infrastructure
 * produces ReproductionResult with `details: Record<string, unknown>` — this
 * function extracts the structured fields and maps to the contract.
 */
export function mapReproductionResultToVerification(
  issue: { title: string; body: string | null | undefined },
  details: ReproductionVerificationDetails | null,
  reproduced: boolean | null,
  externalId?: string,
  logsUrl?: string | null,
): VerificationResult {
  if (!details) {
    // No details at all — infrastructure failure or never ran
    return unsupportedResult("automated", "No reproduction details available — the reproduction provider may not have run.");
  }

  const lifecycle: import("./lifecycle-coverage").LifecycleCoverage = details.lifecycleCoverage
    ? { ...details.lifecycleCoverage, missingStates: details.lifecycleCoverage.missingStates ?? [] }
    : mergeLifecycleCoverage(issue, details as any);
  const artifacts = extractArtifacts(details, logsUrl);
  const scenarioFit = details.scenarioFit;
  const lastEval = details.evaluations?.[details.evaluations.length - 1];
  const retryRecommended = lastEval?.retryRecommended ?? false;

  // Safety: infrastructure failure is NEVER negative evidence
  if (details.outcomeKind === "infra_failure" || details.failureCode === "executor_error" || details.failureCode === "login_health_failed") {
    return {
      verdict: "INCONCLUSIVE",
      evidenceComplete: false,
      lifecycleCoverage: lifecycle,
      artifacts,
      executor: "automated",
      observedAt: new Date().toISOString(),
      contractVersion: VERIFICATION_CONTRACT_VERSION,
      blockedBy: "INFRA_FAILURE",
      limitations: ["Reproduction infrastructure failure — not valid evidence of any kind."],
      confidence: 0,
      summary: "Reproduction blocked by infrastructure failure.",
      reasoning: "The reproduction provider could not complete due to infrastructure/environment failure.",
      retryRecommended: true,
      externalId,
    };
  }

  // Safety: unsupported scenario is NEVER negative evidence
  if (details.outcomeKind === "unsupported") {
    return unsupportedResult("automated", "No automated reproduction scenarios available for this issue class.");
  }

  // Map blocked-by states
  const blocker = mapBlockedBy(details.blockedBy, details.failureCode, details.outcomeKind);
  if (blocker && !lifecycle.coverageComplete) {
    return inconclusiveResult("automated", blocker, lifecycle, `Reproduction blocked by ${blocker}.`, artifacts);
  }

  // Determine verdict from reproduced flag + lifecycle coverage
  if (reproduced === true) {
    return observedResult(
      "automated",
      lifecycle,
      `Bug observed during automated reproduction.`,
      Math.min(0.95, (scenarioFit ?? 0.8) + 0.1),
      artifacts,
      scenarioFit,
    );
  }

  if (reproduced === false && lifecycle.coverageComplete && !details.incompleteEvidence) {
    // When scenarioFit is absent but coverage is complete, confidence comes from
    // the fact that the full lifecycle was covered — don't penalize.
    const confidence = scenarioFit !== undefined
      ? Math.min(0.9, scenarioFit)
      : 0.9; // Complete coverage without scenarioFit = high confidence
    return notObservedResult(
      "automated",
      lifecycle,
      "Bug not observed with complete lifecycle coverage.",
      confidence,
      artifacts,
      scenarioFit,
    );
  }

  // Inconclusive: lifecycle incomplete or null reproduced
  if (reproduced === null || details.incompleteEvidence || !lifecycle.coverageComplete) {
    const reason = reproduced === null
      ? "Reproduction outcome inconclusive (null)."
      : "Lifecycle coverage incomplete — required states not reached.";
    return {
      verdict: "INCONCLUSIVE",
      evidenceComplete: false,
      lifecycleCoverage: lifecycle,
      artifacts,
      executor: "automated",
      observedAt: new Date().toISOString(),
      contractVersion: VERIFICATION_CONTRACT_VERSION,
      blockedBy: blocker ?? undefined,
      limitations: [reason],
      confidence: 0.3,
      summary: reason,
      reasoning: reason,
      scenarioFit,
      retryRecommended,
      externalId,
    };
  }

  // Fallback: if we got here with reproduced === false but incomplete lifecycle,
  // it's still INCONCLUSIVE (safety)
  return {
    verdict: "INCONCLUSIVE",
    evidenceComplete: false,
    lifecycleCoverage: lifecycle,
    artifacts,
    executor: "automated",
    observedAt: new Date().toISOString(),
    contractVersion: VERIFICATION_CONTRACT_VERSION,
    limitations: ["Could not determine verdict with confidence."],
    confidence: 0.2,
    summary: "Verification inconclusive.",
    reasoning: "Reproduction completed but verdict cannot be determined with confidence.",
    retryRecommended: true,
    externalId,
  };
}

// ---------------------------------------------------------------------------
// Assisted (human-operated) Adapter Mapping
// ---------------------------------------------------------------------------

export interface AssistedVerificationResult {
  externalId: string;
  status: "completed" | "failed" | "timeout";
  bugObserved: boolean | null;
  stepsCompleted: string[];
  blockedAt?: string;
  evidence?: Array<{ type: string; url: string; description?: string }>;
  operatorNotes?: string;
}

/**
 * Map a human-assisted verification result into the canonical contract.
 */
export function mapAssistedResultToVerification(
  issue: { title: string; body: string | null | undefined },
  result: AssistedVerificationResult | null,
): VerificationResult {
  if (!result) {
    return unsupportedResult("assisted", "No assisted verification result available.");
  }

  // Infer lifecycle coverage from completed steps
  const requiredStates = inferRequiredLifecycleFromIssue(issue);
  const reachedStates = result.stepsCompleted;
  const missingStates = requiredStates.filter((s) => !reachedStates.includes(s));
  const coverageComplete = requiredStates.length === 0 || missingStates.length === 0;

  const lifecycle: LifecycleCoverage = {
    requiredStates,
    reachedStates,
    coverageComplete,
    missingStates,
  };

  const artifacts: EvidenceReference[] = (result.evidence ?? []).map((e) => ({
    type: e.type as EvidenceReference["type"],
    url: e.url,
    description: e.description,
  }));

  if (result.status === "failed" || result.status === "timeout") {
    return inconclusiveResult(
      "assisted",
      "EXTERNAL_SERVICE",
      lifecycle,
      `Assisted verification ${result.status}${result.blockedAt ? ` at ${result.blockedAt}` : ""}.`,
      artifacts,
    );
  }

  if (result.bugObserved === true) {
    return observedResult("assisted", lifecycle, `Bug observed by an operator.${result.operatorNotes ? ` Notes: ${result.operatorNotes}` : ""}`, 0.95, artifacts);
  }

  if (result.bugObserved === false && coverageComplete) {
    return notObservedResult("assisted", lifecycle, `Bug not observed by an operator with complete coverage.`, 0.9, artifacts);
  }

  return {
    verdict: "INCONCLUSIVE",
    evidenceComplete: false,
    lifecycleCoverage: lifecycle,
    artifacts,
    executor: "assisted",
    observedAt: new Date().toISOString(),
    contractVersion: VERIFICATION_CONTRACT_VERSION,
    limitations: [result.operatorNotes ?? "The operator could not reach a definitive conclusion."],
    confidence: 0.4,
    summary: "Assisted verification inconclusive.",
    reasoning: result.operatorNotes ?? "Operator could not confirm or deny the bug.",
    retryRecommended: false,
    externalId: result.externalId,
  };
}

// ---------------------------------------------------------------------------
// Manual Investigation Adapter
// ---------------------------------------------------------------------------

export interface ManualInvestigationInput {
  investigator: string;
  bugObserved: boolean | null;
  stepsPerformed: string[];
  statesReached: string[];
  notes: string;
  evidence?: Array<{ type: string; url: string; description?: string }>;
  confidence: number;
}

/**
 * Map a manual investigation into the canonical contract.
 * Manual investigations can produce all four verdicts.
 */
export function mapManualInvestigationToVerification(
  issue: { title: string; body: string | null | undefined },
  input: ManualInvestigationInput,
): VerificationResult {
  const requiredStates = inferRequiredLifecycleFromIssue(issue);
  const reachedStates = input.statesReached;
  const missingStates = requiredStates.filter((s) => !reachedStates.includes(s));
  const coverageComplete = requiredStates.length === 0 || missingStates.length === 0;

  const lifecycle: LifecycleCoverage = {
    requiredStates,
    reachedStates,
    coverageComplete,
    missingStates,
  };

  const artifacts: EvidenceReference[] = (input.evidence ?? []).map((e) => ({
    type: e.type as EvidenceReference["type"],
    url: e.url,
    description: e.description,
  }));

  if (input.bugObserved === true) {
    return observedResult("manual", lifecycle, `Bug observed during manual investigation by ${input.investigator}.`, input.confidence, artifacts);
  }

  if (input.bugObserved === false && coverageComplete) {
    return notObservedResult("manual", lifecycle, `Bug not observed during manual investigation by ${input.investigator}.`, input.confidence, artifacts);
  }

  if (input.bugObserved === null) {
    return {
      verdict: "INCONCLUSIVE",
      evidenceComplete: false,
      lifecycleCoverage: lifecycle,
      artifacts,
      executor: "manual",
      observedAt: new Date().toISOString(),
      contractVersion: VERIFICATION_CONTRACT_VERSION,
      limitations: [input.notes || "Manual investigation inconclusive."],
      confidence: input.confidence,
      summary: `Manual investigation by ${input.investigator} was inconclusive.`,
      reasoning: input.notes,
      retryRecommended: false,
    };
  }

  // bugObserved === false but coverage incomplete
  return {
    verdict: "INCONCLUSIVE",
    evidenceComplete: false,
    lifecycleCoverage: lifecycle,
    artifacts,
    executor: "manual",
    observedAt: new Date().toISOString(),
    contractVersion: VERIFICATION_CONTRACT_VERSION,
    limitations: [`Coverage incomplete: missing ${missingStates.join(", ")}`],
    confidence: Math.min(input.confidence, 0.5),
    summary: `Manual investigation did not observe the bug but coverage was incomplete.`,
    reasoning: `Investigator ${input.investigator} did not reach all required lifecycle states.`,
    retryRecommended: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapBlockedBy(
  blocked?: string,
  failureCode?: string,
  outcomeKind?: string,
): VerificationBlocker | null {
  if (blocked === "otp" || failureCode === "blocked_otp" || failureCode === "blocked_human_verification" || outcomeKind === "blocked_human_verification") {
    return "OTP";
  }
  if (blocked === "kyc" || failureCode === "blocked_kyc") {
    return "KYC";
  }
  if (blocked === "payment" || failureCode === "blocked_payment") {
    return "PAYMENT";
  }
  if (blocked === "credentials" || failureCode === "missing_credentials") {
    return "CREDENTIALS";
  }
  if (blocked === "external_service" || outcomeKind === "blocked_external") {
    return "EXTERNAL_SERVICE";
  }
  if (outcomeKind === "infra_failure" || failureCode === "executor_error") {
    return "INFRA_FAILURE";
  }
  return null;
}

function extractArtifacts(details: ReproductionVerificationDetails, logsUrl?: string | null): EvidenceReference[] {
  const artifacts: EvidenceReference[] = [];

  if (details.evidence) {
    for (const item of details.evidence) {
      if (item.url) {
        artifacts.push({
          type: (item.type ?? "other") as EvidenceReference["type"],
          url: item.url,
          description: item.description,
        });
      }
    }
  }

  if (logsUrl) {
    artifacts.push({ type: "log", url: logsUrl, description: "Reproduction logs" });
  }

  return artifacts;
}

function inferRequiredLifecycleFromIssue(issue: { title: string; body: string | null | undefined }): string[] {
  const text = `${issue.title} ${issue.body ?? ""}`.toLowerCase();
  const states: string[] = [];

  if (/after\s+sign(?:ing)?\s+up|post[- ]signup|once\s+signed\s+up/.test(text)) {
    states.push("post_signup_authenticated");
  }
  if (/after\s+log(?:ging)?\s+in|post[- ]login|once\s+logged\s+in/.test(text)) {
    states.push("post_login_authenticated");
  }
  if (/\bdashboard\b|home\s+screen/.test(text)) {
    states.push("dashboard_loaded");
  }
  if (/after\s+placing\s+a\s+trade|trade\s+submitted/.test(text)) {
    states.push("trade_submitted");
  }

  return [...new Set(states)];
}

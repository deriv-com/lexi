import type { AutoCloseEvaluation } from "./auto-close-policy";
import type { LifecycleCoverage } from "./lifecycle-coverage";
import type { VerificationEvaluation } from "./verification-report";

export type ReplayStep = "full" | "planner" | "reproduction" | "decision" | "policy";
/** Time-travel stage for distributed-trace style replay (for example `replay 101 --at planner`). */
export const REPLAY_AT_VALUES = ["planner", "reproduction", "decision", "policy", "workflow", "evidence"] as const;
export type ReplayAt = (typeof REPLAY_AT_VALUES)[number];

export function isReplayAt(value: string): value is ReplayAt {
  return (REPLAY_AT_VALUES as readonly string[]).includes(value);
}

/** The wording used when a replay stage cannot be reconstructed from persisted data. */
export const REPLAY_STAGE_NOT_YET_AVAILABLE = "not yet available";

export interface ReplayEvidenceRecordView {
  id?: string;
  phase: string;
  attemptId: string;
  reportedAt?: string;
  checkCount?: number;
  failingTestCount?: number;
}

/**
 * Runner-evidence slice for `at=evidence`.
 *
 * Optional. `IssueReplayService` leaves this unset unless a
 * `loadEvidenceForIssue` loader is wired and succeeds. Absence, an empty
 * list, or a thrown loader stay "not yet available". Do not invent records.
 */
export interface ReplayEvidenceView {
  available: boolean;
  records: ReplayEvidenceRecordView[];
  /** Text shown when the stage is not yet available (no ingest, no rows, flag off). */
  unavailableReason?: string;
}

export interface ReplayCandidateScenario {
  rank: number;
  scenarioId: string;
  bugClasses?: string[];
  priority?: number;
}

export interface ReplayPlannerView {
  inferredBugClasses: string[];
  primaryBugClass: string;
  routingConfidence?: number;
  primaryScenarioId?: string;
  fallbackScenarioIds: string[];
  candidateScenarios: ReplayCandidateScenario[];
  reasoning?: string;
  maxAttempts?: number;
  stopCondition?: string;
}

export interface ReplayReproductionView {
  providerName?: string;
  externalId?: string;
  status?: string;
  scenarioFit?: number;
  incompleteEvidence?: boolean;
  outcomeKind?: string;
  plannerStopCondition?: string;
  attempts: VerificationEvaluation[];
  resultSummary?: string;
  runIds?: string[];
  lifecycleCoverage?: LifecycleCoverage;
}

export interface ReplayDecisionView {
  classification: string;
  confidence: number;
  summary: string;
  reasoning: string;
  recommendedAction: string;
  team: string;
  owner?: string | null;
}

export interface ReplayReport {
  issueId: string;
  githubNumber: number;
  repoOwner: string;
  repoName: string;
  title: string;
  labels: string[];
  url: string;
  githubState: string;
  workflowStatus: string;
  assignedTeam?: string | null;
  assignedOwner?: string | null;
  planner: ReplayPlannerView;
  reproduction: ReplayReproductionView;
  decision?: ReplayDecisionView;
  policy: AutoCloseEvaluation;
  /**
   * Optional runner-evidence stage. Unset on purpose when no store is wired
   * (fail closed). `formatTimeTravelReplay(..., "evidence")` must then
   * print "not yet available" — never an empty string or a full replay.
   */
  evidence?: ReplayEvidenceView;
  generatedAt: string;
}

function pct(value: number | undefined): string {
  if (typeof value !== "number") return "—";
  return `${Math.round(value * 100)}%`;
}

function line(label: string, value: string): string[] {
  return [label, value, ""];
}

/**
 * Flight-recorder text output for CLI and demos.
 */
export function formatReplayReport(report: ReplayReport, step: ReplayStep = "full"): string {
  if (step === "planner") {
    return formatPlannerStep(report);
  }
  if (step === "reproduction") {
    return formatReproductionStep(report);
  }
  if (step === "decision") {
    return formatDecisionStep(report);
  }
  if (step === "policy") {
    return formatPolicyStep(report);
  }
  return formatFullReplay(report);
}

function formatPlannerStep(report: ReplayReport): string {
  const p = report.planner;
  const lines: string[] = [
    `Issue #${report.githubNumber}`,
    "",
    ...line("Bug classes", p.inferredBugClasses.join(", ") || "unknown"),
    ...line("Primary bug class", p.primaryBugClass),
  ];
  if (typeof p.routingConfidence === "number") {
    lines.push(...line("Routing confidence", pct(p.routingConfidence)));
  }
  if (p.primaryScenarioId) {
    lines.push(...line("Primary scenario", p.primaryScenarioId));
  }
  if (p.fallbackScenarioIds.length > 0) {
    lines.push(...line("Fallback scenarios", p.fallbackScenarioIds.join(", ")));
  }
  if (p.reasoning) {
    lines.push(...line("Planner reasoning", p.reasoning));
  }
  lines.push("Candidate scenarios", "");
  if (p.candidateScenarios.length === 0) {
    lines.push("(none matched from config)");
  } else {
    for (const candidate of p.candidateScenarios) {
      const tags = candidate.bugClasses?.length ? ` [${candidate.bugClasses.join(", ")}]` : "";
      lines.push(`${candidate.rank}. ${candidate.scenarioId}${tags}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function formatReproductionStep(report: ReplayReport): string {
  const r = report.reproduction;
  const lines: string[] = [
    `Issue #${report.githubNumber}`,
    "",
    ...line("Provider", r.providerName ?? "—"),
    ...line("Plan / run id", r.externalId ?? "—"),
    ...line("Status", r.status ?? "—"),
    ...line("Scenario fit", pct(r.scenarioFit)),
    ...line("Outcome", r.outcomeKind ?? "—"),
    ...line("Incomplete evidence", r.incompleteEvidence ? "yes" : "no"),
  ];
  if (r.resultSummary) {
    lines.push(...line("Summary", r.resultSummary));
  }
  if (r.lifecycleCoverage && r.lifecycleCoverage.requiredStates.length > 0) {
    lines.push(...line("Lifecycle required", r.lifecycleCoverage.requiredStates.join(", ")));
    lines.push(...line("Lifecycle reached", r.lifecycleCoverage.reachedStates.join(", ") || "none"));
    lines.push(...line("Lifecycle complete", r.lifecycleCoverage.coverageComplete ? "yes" : "no"));
    if (r.lifecycleCoverage.missingStates.length > 0) {
      lines.push(...line("Lifecycle missing", r.lifecycleCoverage.missingStates.join(", ")));
    }
  }
  if (r.attempts.length > 0) {
    lines.push("Attempts", "");
    for (const attempt of r.attempts) {
      lines.push(
        `- ${attempt.scenarioId} | fit ${pct(attempt.scenarioFit)} | bug ${attempt.bugObserved ? "yes" : "no"}`,
      );
      if (attempt.reasoning) {
        lines.push(`  ${attempt.reasoning}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatDecisionStep(report: ReplayReport): string {
  if (!report.decision) {
    return `Issue #${report.githubNumber}\n\nNo decision recorded yet.\n`;
  }
  const d = report.decision;
  return [
    `Issue #${report.githubNumber}`,
    "",
    ...line("Classification", d.classification),
    ...line("Confidence", pct(d.confidence)),
    ...line("Team", `${d.team}${d.owner ? ` (@${d.owner})` : ""}`),
    ...line("Summary", d.summary),
    ...line("Reasoning", d.reasoning),
    ...line("Recommended action", d.recommendedAction),
    "",
  ].join("\n");
}

function formatPolicyStep(report: ReplayReport): string {
  const outcome = report.policy.allowed ? "Auto-close allowed" : "Auto-close blocked";
  return [
    `Issue #${report.githubNumber}`,
    "",
    ...line("Policy", outcome),
    ...line("Reason", report.policy.reason),
    ...line("GitHub state", report.githubState),
    ...line("Workflow status", report.workflowStatus),
    "",
  ].join("\n");
}

/**
 * Time-travel replay — inputs and outputs at a single pipeline stage (distributed trace).
 */
export function formatTimeTravelReplay(report: ReplayReport, at: ReplayAt): string {
  switch (at) {
    case "planner":
      return formatPlannerTimeTravel(report);
    case "reproduction":
      return formatReproductionTimeTravel(report);
    case "decision":
      return formatDecisionTimeTravel(report);
    case "policy":
      return formatPolicyTimeTravel(report);
    case "workflow":
      return formatWorkflowTimeTravel(report);
    case "evidence":
      return formatEvidenceTimeTravel(report);
    default: {
      // Fail closed for a runtime string that is not a known ReplayAt.
      // Must not fall through to formatFullReplay — an unnamed stage would
      // otherwise silently omit itself or dump the full trace.
      return formatUnavailableReplayStage(report, String(at));
    }
  }
}

function formatUnavailableReplayStage(report: ReplayReport, at: string, reason?: string): string {
  const lines = [
    `── Time Travel: ${at} ──`,
    `Issue #${report.githubNumber}`,
    "",
    reason ?? `Stage "${at}" is not yet available.`,
    "",
  ];
  return lines.join("\n");
}

function formatEvidenceTimeTravel(report: ReplayReport): string {
  const evidence = report.evidence;
  const hasRecords = (evidence?.records.length ?? 0) > 0;
  if (!evidence || evidence.available === false || !hasRecords) {
    const reason =
      evidence?.unavailableReason ?? "Evidence stage is not yet available.";
    const message = reason.toLowerCase().includes(REPLAY_STAGE_NOT_YET_AVAILABLE)
      ? reason
      : `${reason} (not yet available)`;
    return formatUnavailableReplayStage(report, "evidence", message);
  }

  const lines = [
    `── Time Travel: evidence ──`,
    `Issue #${report.githubNumber}`,
    "",
    "INPUT",
    `  records: ${evidence.records.length}`,
    "",
    "OUTPUT",
  ];
  for (const record of evidence.records) {
    const parts = [`phase=${record.phase}`, `attemptId=${record.attemptId}`];
    if (typeof record.checkCount === "number") {
      parts.push(`checks=${record.checkCount}`);
    }
    if (typeof record.failingTestCount === "number") {
      parts.push(`failing=${record.failingTestCount}`);
    }
    if (record.id) {
      parts.push(`id=${record.id}`);
    }
    if (record.reportedAt) {
      parts.push(`reportedAt=${record.reportedAt}`);
    }
    lines.push(`  - ${parts.join(" ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatPlannerTimeTravel(report: ReplayReport): string {
  const p = report.planner;
  const lines = [
    `── Time Travel: planner ──`,
    `Issue #${report.githubNumber}`,
    "",
    "INPUT",
    `  title: ${report.title}`,
    `  labels: ${report.labels.join(", ") || "(none)"}`,
    `  inferred bug classes: ${p.inferredBugClasses.join(", ") || "unknown"}`,
    "",
    "OUTPUT",
    `  primary bug class: ${p.primaryBugClass}`,
  ];
  if (typeof p.routingConfidence === "number") {
    lines.push(`  routing confidence: ${pct(p.routingConfidence)}`);
  }
  lines.push(`  primary scenario: ${p.primaryScenarioId ?? "—"}`);
  if (p.fallbackScenarioIds.length > 0) {
    lines.push(`  fallback scenarios: ${p.fallbackScenarioIds.join(", ")}`);
  }
  if (p.maxAttempts !== undefined) {
    lines.push(`  max attempts: ${p.maxAttempts}`);
  }
  if (p.stopCondition) {
    lines.push(`  stop condition: ${p.stopCondition}`);
  }
  if (p.reasoning) {
    lines.push(`  reasoning: ${p.reasoning}`);
  }
  if (p.candidateScenarios.length > 0) {
    lines.push("", "  ranked candidates:");
    for (const c of p.candidateScenarios) {
      lines.push(`    ${c.rank}. ${c.scenarioId}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function formatReproductionTimeTravel(report: ReplayReport): string {
  const r = report.reproduction;
  const lines = [
    `── Time Travel: reproduction ──`,
    `Issue #${report.githubNumber}`,
    "",
    "INPUT",
    `  primary scenario: ${report.planner.primaryScenarioId ?? "—"}`,
    `  fallback scenarios: ${report.planner.fallbackScenarioIds.join(", ") || "(none)"}`,
    "",
    "OUTPUT",
    `  provider: ${r.providerName ?? "—"}`,
    `  plan / external id: ${r.externalId ?? "—"}`,
    `  status: ${r.status ?? "—"}`,
    `  scenario fit: ${pct(r.scenarioFit)}`,
    `  outcome: ${r.outcomeKind ?? "—"}`,
    `  incomplete evidence: ${r.incompleteEvidence ? "yes" : "no"}`,
  ];
  if (r.lifecycleCoverage && r.lifecycleCoverage.requiredStates.length > 0) {
    lines.push("", "  Required lifecycle");
    for (const state of r.lifecycleCoverage.requiredStates) {
      lines.push(`  - ${state}`);
    }
    lines.push("", "  Reached");
    const reached = r.lifecycleCoverage.reachedStates;
    if (reached.length === 0) {
      lines.push("  - (none)");
    } else {
      for (const state of reached) {
        lines.push(`  - ${state}`);
      }
    }
    const missing =
      r.lifecycleCoverage.missingStates ??
      r.lifecycleCoverage.requiredStates.filter((s) => !reached.includes(s));
    if (missing.length > 0) {
      lines.push("", "  Missing");
      for (const state of missing) {
        lines.push(`  - ${state}`);
      }
    }
    lines.push(
      "",
      "  Coverage",
      `  ${r.lifecycleCoverage.coverageComplete ? "COMPLETE" : "INCOMPLETE"}`,
    );
    if (!r.lifecycleCoverage.coverageComplete) {
      const blockedLabel =
        r.outcomeKind === "blocked_human_verification"
          ? "human verification / target state not confirmed"
          : "required lifecycle state not reached";
      lines.push("", "  Blocked by", `  ${blockedLabel}`);
    }
  }
  if (r.resultSummary) {
    lines.push(`  summary: ${r.resultSummary}`);
  }
  if (r.runIds?.length) {
    lines.push(`  run ids: ${r.runIds.join(", ")}`);
  }
  if (r.attempts.length > 0) {
    lines.push("", "  attempt chain:");
    for (const attempt of r.attempts) {
      lines.push(
        `    - ${attempt.scenarioId} | fit ${pct(attempt.scenarioFit)} | bug ${attempt.bugObserved ? "yes" : "no"}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function formatDecisionTimeTravel(report: ReplayReport): string {
  const r = report.reproduction;
  const lines = [
    `── Time Travel: decision ──`,
    `Issue #${report.githubNumber}`,
    "",
    "INPUT",
    `  reproduction summary: ${r.resultSummary ?? "—"}`,
    `  scenario fit: ${pct(r.scenarioFit)}`,
    `  outcome kind: ${r.outcomeKind ?? "—"}`,
    `  incomplete evidence: ${r.incompleteEvidence ? "yes" : "no"}`,
  ];
  if (r.attempts.length > 0) {
    lines.push(`  signals from ${r.attempts.length} attempt(s)`);
  }
  lines.push("", "OUTPUT");
  if (!report.decision) {
    lines.push("  (no decision recorded)");
  } else {
    const d = report.decision;
    lines.push(
      `  classification: ${d.classification}`,
      `  confidence: ${pct(d.confidence)}`,
      `  team: ${d.team}${d.owner ? ` (@${d.owner})` : ""}`,
      `  summary: ${d.summary}`,
      `  reasoning: ${d.reasoning}`,
      `  recommended action: ${d.recommendedAction}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatPolicyTimeTravel(report: ReplayReport): string {
  const d = report.decision;
  const r = report.reproduction;
  return [
    `── Time Travel: policy ──`,
    `Issue #${report.githubNumber}`,
    "",
    "INPUT",
    `  classification: ${d?.classification ?? "—"}`,
    `  decision confidence: ${pct(d?.confidence)}`,
    `  scenario fit: ${pct(r.scenarioFit)}`,
    `  incomplete evidence: ${r.incompleteEvidence ? "yes" : "no"}`,
    `  outcome kind: ${r.outcomeKind ?? "—"}`,
    r.lifecycleCoverage && r.lifecycleCoverage.requiredStates.length > 0
      ? `  lifecycle required: ${r.lifecycleCoverage.requiredStates.join(", ")}`
      : "  lifecycle required: —",
    r.lifecycleCoverage
      ? `  lifecycle reached: ${r.lifecycleCoverage.reachedStates.join(", ") || "none"}`
      : "  lifecycle reached: —",
    r.lifecycleCoverage
      ? `  lifecycle complete: ${r.lifecycleCoverage.coverageComplete ? "yes" : "no"}`
      : "  lifecycle complete: —",
    "",
    "OUTPUT",
    `  auto-close allowed: ${report.policy.allowed ? "yes" : "no"}`,
    `  reason: ${report.policy.reason}`,
    "",
  ].join("\n");
}

function formatWorkflowTimeTravel(report: ReplayReport): string {
  return [
    `── Time Travel: workflow ──`,
    `Issue #${report.githubNumber}`,
    "",
    "INPUT",
    `  policy outcome: ${report.policy.allowed ? "close allowed" : "close blocked"}`,
    `  recommended action: ${report.decision?.recommendedAction ?? "—"}`,
    "",
    "OUTPUT",
    `  github state: ${report.githubState}`,
    `  workflow status: ${report.workflowStatus}`,
    `  assigned team: ${report.assignedTeam ?? "(none)"}`,
    `  assigned owner: ${report.assignedOwner ?? "(none)"}`,
    "",
  ].join("\n");
}

function formatFullReplay(report: ReplayReport): string {
  const lines: string[] = [`Issue #${report.githubNumber}`, "", report.title, report.url, ""];
  const primary = report.planner.primaryScenarioId ?? "—";
  lines.push("Planner", "↓", primary, "");

  if (typeof report.reproduction.scenarioFit === "number") {
    lines.push("Scenario fit", "↓", pct(report.reproduction.scenarioFit), "");
  }

  if (report.decision) {
    lines.push("Decision", "↓", report.decision.classification, "");
  } else {
    lines.push("Decision", "↓", "(pending)", "");
  }

  const policyLabel = report.policy.allowed ? "Auto-close allowed" : "Auto-close blocked";
  lines.push("Policy", "↓", policyLabel, "");
  lines.push("Reason", "↓", report.policy.reason, "");

  if (
    report.reproduction.lifecycleCoverage &&
    report.reproduction.lifecycleCoverage.requiredStates.length > 0 &&
    !report.reproduction.lifecycleCoverage.coverageComplete
  ) {
    lines.push(
      "Lifecycle coverage",
      "↓",
      `MISSING: ${report.reproduction.lifecycleCoverage.missingStates.join(", ")}`,
      "",
    );
  }

  if (report.reproduction.attempts.length > 1) {
    lines.push("Attempt chain", "");
    for (const attempt of report.reproduction.attempts) {
      lines.push(`  ${attempt.scenarioId} → fit ${pct(attempt.scenarioFit)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

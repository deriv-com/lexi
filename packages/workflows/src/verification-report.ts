import type { Decision } from "@lexi/ai";
import type { AutoCloseEvaluation } from "./auto-close-policy";
import { enrichResultDetailsWithLifecycle, type LifecycleCoverage } from "./lifecycle-coverage";
import type { DecisionRecord, EvidenceRecord, IssueRecord, ReproductionAttemptRecord } from "./types";

export interface VerificationArtifact {
  type: string;
  url: string;
  description?: string;
}

export interface VerificationEvaluation {
  scenarioId: string;
  runId?: string;
  scenarioFit?: number;
  bugObserved?: boolean;
  retryRecommended?: boolean;
  reasoning?: string;
  signalsObserved?: string[];
  missingSignals?: string[];
}

export interface VerificationReport {
  issueId: string;
  githubNumber: number;
  repoOwner: string;
  repoName: string;
  issueUrl: string;
  generatedAt: string;
  classification: string;
  confidence: number;
  team: string;
  owner: string | null;
  summary: string;
  reasoning: string;
  recommendedAction: string;
  executionPlan?: Record<string, unknown>;
  observedSignals: string[];
  evaluations: VerificationEvaluation[];
  scenarioFit?: number;
  incompleteEvidence?: boolean;
  lifecycleCoverage?: LifecycleCoverage;
  plannerStopCondition?: string;
  runIds?: string[];
  artifacts: VerificationArtifact[];
  policyOutcome: AutoCloseEvaluation;
  reproductionSummary?: string;
  logsUrl?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function extractArtifacts(
  details: Record<string, unknown> | null,
  persistedEvidence: EvidenceRecord[],
  logsUrl?: string | null,
): VerificationArtifact[] {
  const artifacts: VerificationArtifact[] = [];

  if (details && Array.isArray(details.evidence)) {
    for (const item of details.evidence) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const e = item as Record<string, unknown>;
      const url = typeof e.url === "string" ? e.url : "";
      if (!url) {
        continue;
      }
      artifacts.push({
        type: String(e.type ?? "artifact"),
        url,
        description: typeof e.description === "string" ? e.description : undefined,
      });
    }
  }

  for (const item of persistedEvidence) {
    if (item.url && !artifacts.some((a) => a.url === item.url)) {
      artifacts.push({
        type: item.type,
        url: item.url,
        description: item.description ?? undefined,
      });
    }
  }

  if (logsUrl && !artifacts.some((a) => a.url === logsUrl)) {
    artifacts.push({ type: "log", url: logsUrl, description: "logs" });
  }

  return artifacts;
}

function extractEvaluations(details: Record<string, unknown> | null): VerificationEvaluation[] {
  if (!details) {
    return [];
  }

  if (Array.isArray(details.attempts)) {
    return details.attempts
      .filter((row) => row && typeof row === "object")
      .map((row) => {
        const attempt = row as Record<string, unknown>;
        return {
          scenarioId: String(attempt.scenarioId ?? ""),
          runId: typeof attempt.runId === "string" ? attempt.runId : undefined,
          scenarioFit: typeof attempt.scenarioFit === "number" ? attempt.scenarioFit : undefined,
          bugObserved: attempt.reproduced === true,
          retryRecommended: false,
          reasoning: typeof attempt.summary === "string" ? attempt.summary : undefined,
          signalsObserved: [
            ...(typeof attempt.outcomeKind === "string" ? [`outcome:${attempt.outcomeKind}`] : []),
            ...(typeof attempt.failureCode === "string" ? [`failure:${attempt.failureCode}`] : []),
          ],
          missingSignals: Array.isArray(attempt.blockedCapabilities)
            ? (attempt.blockedCapabilities as string[])
            : undefined,
        };
      });
  }

  if (!Array.isArray(details.evaluations)) {
    return [];
  }
  return details.evaluations
    .filter((row) => row && typeof row === "object")
    .map((row) => {
      const e = row as Record<string, unknown>;
      return {
        scenarioId: String(e.scenarioId ?? ""),
        runId: typeof e.runId === "string" ? e.runId : undefined,
        scenarioFit: typeof e.scenarioFit === "number" ? e.scenarioFit : undefined,
        bugObserved: e.bugObserved === true,
        retryRecommended: e.retryRecommended === true,
        reasoning: typeof e.reasoning === "string" ? e.reasoning : undefined,
        signalsObserved: Array.isArray(e.signalsObserved) ? (e.signalsObserved as string[]) : undefined,
        missingSignals: Array.isArray(e.missingSignals) ? (e.missingSignals as string[]) : undefined,
      };
    });
}

function collectObservedSignals(details: Record<string, unknown> | null, evaluations: VerificationEvaluation[]): string[] {
  const signals = new Set<string>();
  for (const evaluation of evaluations) {
    for (const signal of evaluation.signalsObserved ?? []) {
      signals.add(signal);
    }
  }
  if (details && typeof details.outcomeKind === "string") {
    signals.add(`outcome:${details.outcomeKind}`);
  }
  if (details && typeof details.failureCode === "string") {
    signals.add(`failure:${details.failureCode}`);
  }
  return [...signals];
}

export function buildVerificationReport(
  issue: IssueRecord,
  decision: Decision | DecisionRecord,
  team: string,
  owner: string | null | undefined,
  policyOutcome: AutoCloseEvaluation,
  reproductionAttempt?: ReproductionAttemptRecord | null,
  persistedEvidence: EvidenceRecord[] = [],
): VerificationReport {
  const enriched = enrichResultDetailsWithLifecycle(issue, asRecord(reproductionAttempt?.resultDetails));
  const details = enriched;
  const evaluations = extractEvaluations(details);
  const executionPlan =
    details?.executionPlan && typeof details.executionPlan === "object"
      ? (details.executionPlan as Record<string, unknown>)
      : undefined;

  return {
    issueId: issue.id,
    githubNumber: issue.githubNumber,
    repoOwner: issue.repoOwner,
    repoName: issue.repoName,
    issueUrl: issue.url,
    generatedAt: new Date().toISOString(),
    classification: decision.classification,
    confidence: decision.confidence,
    team,
    owner: owner ?? null,
    summary: decision.summary,
    reasoning: decision.reasoning,
    recommendedAction: decision.nextAction,
    executionPlan,
    observedSignals: collectObservedSignals(details, evaluations),
    evaluations,
    scenarioFit: typeof details?.scenarioFit === "number" ? details.scenarioFit : undefined,
    incompleteEvidence: details?.incompleteEvidence === true,
    lifecycleCoverage:
      details && typeof details.lifecycleCoverage === "object"
        ? (details.lifecycleCoverage as LifecycleCoverage)
        : undefined,
    plannerStopCondition:
      typeof details?.plannerStopCondition === "string" ? details.plannerStopCondition : undefined,
    runIds: Array.isArray(details?.runIds) ? (details.runIds as string[]) : undefined,
    artifacts: extractArtifacts(details, persistedEvidence, reproductionAttempt?.logsUrl),
    policyOutcome,
    reproductionSummary: reproductionAttempt?.resultSummary ?? undefined,
    logsUrl: reproductionAttempt?.logsUrl ?? undefined,
  };
}

/**
 * GitHub comment — framed as evidence-first "Verification Report" (not "AI decision").
 */
export function buildVerificationReportComment(report: VerificationReport): string {
  const lines: string[] = [
    "**Verification Report**",
    "",
    "## Classification",
    `- **Result:** ${report.classification}`,
    `- **Confidence:** ${Math.round(report.confidence * 100)}%`,
    `- **Team:** ${report.team}${report.owner ? ` (@${report.owner})` : ""}`,
    "",
    "## Summary",
    report.summary,
    "",
    "## Reasoning",
    report.reasoning,
    "",
    `_Recommended action:_ ${report.recommendedAction}`,
    "",
  ];

  if (report.executionPlan) {
    const plan = report.executionPlan;
    lines.push("## Execution plan", "");
    if (Array.isArray(plan.bugClasses)) {
      lines.push(`- **Bug classes:** ${(plan.bugClasses as string[]).join(", ")}`);
    }
    if (typeof plan.routingConfidence === "number") {
      lines.push(`- **Routing confidence:** ${Math.round(plan.routingConfidence * 100)}%`);
    }
    const primary = plan.primaryScenario as Record<string, unknown> | undefined;
    if (primary?.scenarioId) {
      lines.push(`- **Primary scenario:** ${primary.scenarioId}@${primary.scenarioVersion ?? "?"}`);
    }
    if (typeof plan.reasoning === "string" && plan.reasoning.length > 0) {
      lines.push(`- **Planner:** ${plan.reasoning}`);
    }
    lines.push("");
  }

  if (report.observedSignals.length > 0) {
    lines.push("## Observed signals", "", report.observedSignals.map((s) => `- ${s}`).join("\n"), "");
  }

  if (report.lifecycleCoverage && report.lifecycleCoverage.requiredStates.length > 0) {
    const lc = report.lifecycleCoverage;
    lines.push(
      "## Lifecycle coverage",
      "",
      `- **Required states:** ${lc.requiredStates.join(", ")}`,
      `- **Reached states:** ${lc.reachedStates.length > 0 ? lc.reachedStates.join(", ") : "none"}`,
      `- **Coverage complete:** ${lc.coverageComplete ? "yes" : "no"}`,
    );
    if (lc.missingStates.length > 0) {
      lines.push(`- **Missing states:** ${lc.missingStates.join(", ")}`);
    }
    if (lc.blockedBy) {
      lines.push(`- **Blocked by:** ${lc.blockedBy}`);
    }
    lines.push("");
  }

  if (report.evaluations.length > 0) {
    lines.push(
      "## Reproduction attempts",
      "",
      "| Scenario | Fit | Bug observed | Notes |",
      "| --- | ---: | --- | --- |",
    );
    for (const evaluation of report.evaluations) {
      const fit =
        typeof evaluation.scenarioFit === "number" ? `${Math.round(evaluation.scenarioFit * 100)}%` : "—";
      const observed = evaluation.bugObserved ? "yes" : "no";
      const notes = (evaluation.reasoning ?? "").slice(0, 120);
      lines.push(`| ${evaluation.scenarioId} | ${fit} | ${observed} | ${notes} |`);
    }
    lines.push("");
  }

  if (report.reproductionSummary) {
    lines.push("### Run summary", "", report.reproductionSummary, "");
  }

  if (report.artifacts.length > 0) {
    lines.push("## Artifacts", "");
    for (const artifact of report.artifacts) {
      const label = artifact.description ?? artifact.type;
      lines.push(`- [${label}](${artifact.url})`);
    }
    lines.push("");
  }

  lines.push(
    "## Policy outcome",
    "",
    report.policyOutcome.allowed
      ? `✅ **Auto-close allowed** — ${report.policyOutcome.reason}`
      : `⛔ **Auto-close blocked** — ${report.policyOutcome.reason}`,
    "",
  );

  return lines.join("\n");
}

/** @deprecated Use buildVerificationReportComment */
export function buildDecisionAuditComment(
  decision: Decision,
  team: string,
  owner: string | undefined,
  reproductionAttempt?: ReproductionAttemptRecord,
  autoClose?: AutoCloseEvaluation,
  issue?: IssueRecord,
): string {
  const stubIssue: IssueRecord = issue ?? {
    id: "unknown",
    githubIssueId: 0,
    githubNumber: 0,
    repoOwner: "",
    repoName: "",
    title: "",
    body: null,
    url: "",
    authorLogin: "",
    labels: [],
    state: "open",
    currentStatus: "NEW",
    assignedOwner: null,
    assignedTeam: null,
    githubCreatedAt: new Date(),
    githubUpdatedAt: new Date(),
    updatedAt: new Date(),
  };
  const report = buildVerificationReport(
    stubIssue,
    decision,
    team,
    owner,
    autoClose ?? { allowed: false, reason: "Policy not evaluated." },
    reproductionAttempt,
    [],
  );
  return buildVerificationReportComment(report);
}

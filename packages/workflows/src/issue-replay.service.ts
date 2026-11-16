import type { PolicyEngineOptions } from "./policy-engine";
import { evaluateAutoClose } from "./auto-close-policy";
import { enrichResultDetailsWithLifecycle, type LifecycleCoverage } from "./lifecycle-coverage";
import type { ReplayAt, ReplayEvidenceView, ReplayReport, ReplayStep } from "./replay-report";
import { formatReplayReport, formatTimeTravelReplay } from "./replay-report";
import { WorkflowRepository } from "./workflow-repository.interface";
import type { IssueRecord, ReproductionAttemptRecord } from "./types";

/** One reproduction scenario the planner would consider for an issue, best first. */
export interface ReplayScenarioCandidate {
  scenarioId: string;
  bugClasses: string[];
  priority: number;
}

/**
 * The reproduction planner, as seen by replay. Reproduction is pluggable, so the
 * planner that classifies bugs and ranks scenarios lives with the adapter, not
 * here. Without one, replay reports the planner view from what the attempt
 * persisted (`details.executionPlan`) and leaves inference empty.
 */
export interface ReplayPlannerPort {
  inferBugClasses(input: { issueNumber: number; title: string; body: string | null; labels: string[] }): string[];
  primaryBugClass(classes: readonly string[]): string;
  listCandidateScenarios(
    input: { title: string; body: string | null; labels: string[] },
    scenarioConfigPath?: string,
  ): ReplayScenarioCandidate[];
}

export interface IssueReplayServiceOptions extends PolicyEngineOptions {
  scenarioConfigPath?: string;
  /** Optional planner; see ReplayPlannerPort. */
  planner?: ReplayPlannerPort;
  githubOwner?: string;
  githubRepo?: string;
  /**
   * Port for runner-evidence replay. Orchestrator injects a loader that reads
   * persisted rows; this package must not import Prisma or RunEvidenceService.
   * Absent or throwing → evidence stays unset (the formatter says the stage is not yet available).
   */
  loadEvidenceForIssue?: (githubNumber: number, repository: string) => Promise<ReplayEvidenceView>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function buildPlannerView(
  issue: IssueRecord,
  details: Record<string, unknown> | null,
  scenarioConfigPath?: string,
  planner?: ReplayPlannerPort,
) {
  const inferred = planner
    ? planner.inferBugClasses({
        issueNumber: issue.githubNumber,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
      })
    : stringList(details?.inferredBugClasses);
  const rawCandidates = planner
    ? planner.listCandidateScenarios({ title: issue.title, body: issue.body, labels: issue.labels }, scenarioConfigPath)
    : [];
  const candidates = rawCandidates.map((match, index) => ({
    rank: index + 1,
    scenarioId: match.scenarioId,
    bugClasses: match.bugClasses,
    priority: match.priority,
  }));

  const plan = asRecord(details?.executionPlan);
  const primary = asRecord(plan?.primaryScenario);
  const fallbacks = Array.isArray(plan?.fallbackScenarios) ? plan.fallbackScenarios : [];

  return {
    inferredBugClasses: inferred,
    primaryBugClass: planner ? planner.primaryBugClass(inferred) : (inferred[0] ?? "unknown"),
    routingConfidence: typeof plan?.routingConfidence === "number" ? plan.routingConfidence : undefined,
    primaryScenarioId: typeof primary?.scenarioId === "string" ? primary.scenarioId : undefined,
    fallbackScenarioIds: fallbacks
      .map((row) => asRecord(row)?.scenarioId)
      .filter((id): id is string => typeof id === "string"),
    candidateScenarios: candidates,
    reasoning: typeof plan?.reasoning === "string" ? plan.reasoning : undefined,
    maxAttempts: typeof plan?.maxAttempts === "number" ? plan.maxAttempts : undefined,
    stopCondition: typeof plan?.stopCondition === "string" ? plan.stopCondition : undefined,
  };
}

function buildReproductionView(
  attempt: ReproductionAttemptRecord | null | undefined,
  details: Record<string, unknown> | null,
) {
  const evaluations = Array.isArray(details?.evaluations)
    ? details.evaluations
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
        })
    : Array.isArray(details?.attempts)
      ? details.attempts
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
            };
          })
      : [];

  return {
    providerName: attempt?.providerName,
    externalId: attempt?.externalId,
    status: attempt?.status,
    scenarioFit: typeof details?.scenarioFit === "number" ? details.scenarioFit : undefined,
    incompleteEvidence: details?.incompleteEvidence === true,
    outcomeKind: typeof details?.outcomeKind === "string" ? details.outcomeKind : undefined,
    plannerStopCondition:
      typeof details?.plannerStopCondition === "string" ? details.plannerStopCondition : undefined,
    attempts: evaluations,
    resultSummary: attempt?.resultSummary ?? undefined,
    runIds: Array.isArray(details?.runIds) ? (details.runIds as string[]) : undefined,
    lifecycleCoverage:
      details && typeof details.lifecycleCoverage === "object"
        ? (details.lifecycleCoverage as LifecycleCoverage)
        : undefined,
  };
}

export class IssueReplayService {
  constructor(
    private readonly repository: WorkflowRepository,
    private readonly options: IssueReplayServiceOptions = {},
  ) {}

  async getReplayReport(issueId: string): Promise<ReplayReport | null> {
    const issue = await this.repository.getIssueById(issueId);
    if (!issue) {
      return null;
    }
    return this.buildForIssue(issue);
  }

  async getReplayReportByGithubNumber(
    owner: string,
    repo: string,
    githubNumber: number,
  ): Promise<ReplayReport | null> {
    const issue = await this.repository.getIssueByGithubNumber(owner, repo, githubNumber);
    if (!issue) {
      return null;
    }
    return this.buildForIssue(issue);
  }

  async getReplayReportByGithubNumberDefault(githubNumber: number): Promise<ReplayReport | null> {
    const owner = this.options.githubOwner;
    const repo = this.options.githubRepo;
    if (!owner || !repo) {
      throw new Error("githubOwner and githubRepo must be configured for replay by number");
    }
    return this.getReplayReportByGithubNumber(owner, repo, githubNumber);
  }

  formatReplay(report: ReplayReport, step: ReplayStep = "full"): string {
    return formatReplayReport(report, step);
  }

  formatTimeTravel(report: ReplayReport, at: ReplayAt): string {
    return formatTimeTravelReplay(report, at);
  }

  private async buildForIssue(issue: IssueRecord): Promise<ReplayReport> {
    const decision = await this.repository.getLatestDecisionForIssue(issue.id);
    const reproductionAttempt = decision?.reproductionAttemptId
      ? await this.repository.getReproductionAttemptById(decision.reproductionAttemptId)
      : await this.repository.getLatestReproductionAttemptForIssue(issue.id);

    const details = enrichResultDetailsWithLifecycle(issue, asRecord(reproductionAttempt?.resultDetails));
    const planner = buildPlannerView(issue, details, this.options.scenarioConfigPath, this.options.planner);
    const reproduction = buildReproductionView(reproductionAttempt, details);

    const policy = decision
      ? evaluateAutoClose(
          {
            classification: decision.classification,
            decisionConfidence: decision.confidence,
            resultDetails: details,
          },
          {
            minConfidence: this.options.autoCloseMinConfidence,
            minScenarioFit: this.options.autoCloseMinScenarioFit,
          },
        )
      : { allowed: false, reason: "No decision recorded yet." };

    const report: ReplayReport = {
      issueId: issue.id,
      githubNumber: issue.githubNumber,
      repoOwner: issue.repoOwner,
      repoName: issue.repoName,
      title: issue.title,
      labels: issue.labels,
      url: issue.url,
      githubState: issue.state,
      workflowStatus: issue.currentStatus,
      assignedTeam: issue.assignedTeam,
      assignedOwner: issue.assignedOwner,
      planner,
      reproduction,
      decision: decision
        ? {
            classification: decision.classification,
            confidence: decision.confidence,
            summary: decision.summary,
            reasoning: decision.reasoning,
            recommendedAction: decision.nextAction,
            team: decision.team,
            owner: decision.owner,
          }
        : undefined,
      policy,
      // evidence left unset unless a loader is wired and succeeds. Absence or a
      // thrown loader must stay "not yet available" — do not invent runner-evidence records.
      generatedAt: new Date().toISOString(),
    };

    const loader = this.options.loadEvidenceForIssue;
    if (loader) {
      try {
        report.evidence = await loader(issue.githubNumber, `${issue.repoOwner}/${issue.repoName}`);
      } catch {
        // The formatter already says "not yet available" when evidence is unset.
      }
    }

    return report;
  }
}

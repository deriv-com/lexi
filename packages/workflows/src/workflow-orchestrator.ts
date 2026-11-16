import { randomUUID } from "crypto";
import { DecisionClassification, NotificationTemplate, ReproductionStatus, WorkflowStatus } from "@lexi/database";
import { GitHubProvider, MutationResult } from "@lexi/github";
import { SlackProvider } from "@lexi/slack";
import type { ReproductionProvider, ReproductionRequest } from "@lexi/contracts";
import { AiDecisionInput, Decision, DecisionEngine } from "@lexi/ai";
import { ModuleOwnershipResolution, OwnershipResolver, Platform } from "@lexi/ownership";
import {
  renderNotification,
  NotificationContext,
  NotificationTemplateName,
  isDeliveryComplete,
  verificationModeFor,
  type VerifiableKind,
} from "@lexi/notifications";
import { MetricsRegistry } from "@lexi/metrics";
import { PinoLoggerService } from "@lexi/logger";
import { WorkflowRepository } from "./workflow-repository.interface";
import { WorkflowStateMachine } from "./workflow-state-machine";
import { ClosureEvidence, CrossOrgClosureChecker } from "./cross-org-closure-checker";
import { PolicyEngine } from "./policy-engine";
import {
  buildVerificationReport,
  buildVerificationReportComment,
} from "./verification-report";
import { enrichResultDetailsWithLifecycle } from "./lifecycle-coverage";
import { mapReproductionResultToVerification } from "./verification-adapters";
import { evaluateVerificationAutoClose } from "./verification-policy";
import {
  buildDeterministicDecision,
  evaluateEscalation,
  remapCompleteCoverageClassification,
} from "./escalation-policy";
import { evaluatePendingClosure } from "@lexi/governance";
import type { EvidenceFirstRouter, EvidenceRoutingOutcome } from "@lexi/governance";
import { BacklogSweepBudget, IssueRecord, ReproductionAttemptRecord, WorkflowExecutionRecord } from "./types";

export interface WorkflowOrchestratorOptions {
  reminderThresholdDays: number;
  escalationThresholdDays: number;
  /** Minimum AI confidence to auto-close (default 0.85). */
  autoCloseMinConfidence?: number;
  /** Minimum scenario fit from planner to auto-close (default 0.75). */
  autoCloseMinScenarioFit?: number;
  /** Grace-period closure instead of immediate not-observed close. */
  pendingClosureEnabled?: boolean;
  pendingClosureGraceDays?: number;
  pendingClosureMinAttempts?: number;
  pendingClosureLabel?: string;
  writesEnabled?: boolean;
  dryRun?: boolean;
  /** Called when grace-period closure is scheduled instead of immediate close. */
  onSchedulePendingClosure?: (input: {
    issueId: string;
    githubNumber: number;
    repository: string;
    scheduledCloseAt: Date;
    gracePeriodDays: number;
    evidenceSummary: Record<string, unknown>;
  }) => Promise<void>;
  onCancelPendingClosure?: (input: { issueId: string; actor: string; reason: string }) => Promise<void>;
  /** Called when Slack experience layer should post progress (conversational UX only). */
  onWorkflowStage?: (event: WorkflowStageNotification) => Promise<void>;
  /** Evidence-First Pipeline: when enabled, processIssue routes through evidence assessment before reproduction. */
  evidencePipelineEnabled?: boolean;
  /**
   * After a VERIFIED, reproduced bug: search product-repo code and dispatch
   * a fix if the defect is found. Optional so existing construction sites
   * stay untouched. Fire-and-forget from handleVerified.
   */
  onConfirmedBug?: (input: {
    githubNumber: number;
    title: string;
    body: string | null;
    url: string;
    labels: string[];
    repoOwner: string;
    repoName: string;
    reproduced: boolean;
    summary: string;
  }) => Promise<void>;
  /**
   * Advisory engineering-graph / issue-memory write after a decision.
   * Failures must be swallowed by the caller — memory never fails the pipeline.
   */
  onEngineeringMemory?: (event: {
    githubNumber: number;
    repoOwner: string;
    repoName: string;
    classification: string;
    confidence: number;
    summary: string;
    owner?: string | null;
    team?: string;
    component?: string;
  }) => Promise<void>;
}

// ---------------------------------------------------------------------
// (module x platform) routing
// ---------------------------------------------------------------------

/**
 * What a module inference answers. Structurally identical to
 * `ModuleInferenceService.infer()`'s return, declared here as a PORT because
 * that service lives in the host application and a package may not depend on
 * an app. `method`/`platformMethod` are widened to `string` so the service's
 * narrower unions remain assignable.
 */
export interface ModuleRoutingInference {
  module: string;
  platform: Platform;
  confidence: number;
  method: string;
  evidence: string[];
  /** True when no module was identified and the default was substituted. */
  isFallback: boolean;
  platformMethod: string;
}

export interface ModuleRoutingTarget {
  owner: string;
  repo: string;
  issueNumber: number;
  labels: string[];
}

export interface ModuleLabelWriteOutcome {
  executed: boolean;
  label?: string;
  reason?: string;
}

/**
 * The seam onto `ModuleInferenceService`. `applyModuleLabel` is the ONLY way
 * this orchestrator writes a `module:*` label: it routes through the same
 * governed `runWrite` gateway and fails closed without one, so there is
 * deliberately no second write path here.
 */
export interface ModuleRouter {
  infer(input: {
    title?: string;
    body?: string;
    labels?: string[];
    paths?: string[];
  }): Promise<ModuleRoutingInference>;
  applyModuleLabel(
    github: GitHubProvider,
    target: ModuleRoutingTarget,
    inference: ModuleRoutingInference,
  ): Promise<ModuleLabelWriteOutcome>;
}

/** The two-dimensional answer, once inferred, reused across a whole cycle. */
interface ModuleRoutingContext {
  inference: ModuleRoutingInference;
  ownership: ModuleOwnershipResolution;
}

/**
 * One resolution consulted by every routing site in a cycle, so the ~5 places
 * that used to re-derive a component from labels independently now agree.
 */
interface TriageRouting {
  /**
   * LEGACY one-dimensional component. Deliberately unchanged even on the
   * two-dimensional path — see `composeRouting`.
   */
  component: string;
  team: string;
  owner?: string;
  channel: string;
  /** Present only when two-dimensional resolution succeeded. */
  module?: string;
  platform?: Platform;
  moduleIsFallback?: boolean;
  twoDimensional: boolean;
}

/** `domain:*` labels are authoritative for platform — see `composeRouting`. */
const DOMAIN_LABEL_PLATFORM: Record<string, Platform> = {
  "domain:web": "web",
  "domain:mobile": "mobile",
};

function platformFromLabels(labels: readonly string[]): Platform | undefined {
  for (const label of labels) {
    const platform = DOMAIN_LABEL_PLATFORM[label.trim().toLowerCase()];
    if (platform) return platform;
  }
  return undefined;
}

export interface WorkflowStageNotification {
  issueId: string;
  githubNumber: number;
  stage: string;
  detail?: string;
  classification?: string;
  confidence?: number;
  writeBlocked?: boolean;
  closeRecommended?: boolean;
  writesEnabled?: boolean;
  executionSummary?: string;
}

const DEFAULT_OPTIONS: WorkflowOrchestratorOptions = {
  reminderThresholdDays: 3,
  escalationThresholdDays: 7,
  // FAIL CLOSED. writesEnabled is the kill switch for live GitHub mutations, so
  // absent or unparseable config must mean OFF, never ON. Note that spreading
  // caller options over these defaults means an explicitly-passed `undefined`
  // (e.g. from a config field that failed to parse) replaces this value rather
  // than falling back to it — which is why every guard below tests `!== true`
  // instead of `=== false`.
  writesEnabled: false,
};

const CLASSIFICATION_TO_TEMPLATE: Record<DecisionClassification, NotificationTemplateName> = {
  VERIFIED: "VERIFIED",
  LIKELY_FIXED: "CANNOT_REPRODUCE",
  CANNOT_REPRODUCE: "CANNOT_REPRODUCE",
  DUPLICATE: "CANNOT_REPRODUCE",
  NEEDS_MORE_INFO: "NEEDS_INFO",
  NEEDS_MANUAL_INVESTIGATION: "MANUAL_INVESTIGATION",
  NOT_OBSERVED_WITH_COMPLETE_COVERAGE: "CANNOT_REPRODUCE",
  BLOCKED_BY_OTP: "MANUAL_INVESTIGATION",
  BLOCKED_BY_KYC: "MANUAL_INVESTIGATION",
  BLOCKED_BY_PAYMENT: "MANUAL_INVESTIGATION",
  BLOCKED_BY_CREDENTIALS: "MANUAL_INVESTIGATION",
  BLOCKED_BY_ENVIRONMENT: "MANUAL_INVESTIGATION",
};

const CLASSIFICATION_TO_NOTIFICATION_TEMPLATE: Record<DecisionClassification, NotificationTemplate> = {
  VERIFIED: NotificationTemplate.VERIFIED,
  LIKELY_FIXED: NotificationTemplate.CANNOT_REPRODUCE,
  CANNOT_REPRODUCE: NotificationTemplate.CANNOT_REPRODUCE,
  DUPLICATE: NotificationTemplate.CANNOT_REPRODUCE,
  NEEDS_MORE_INFO: NotificationTemplate.NEEDS_INFO,
  NEEDS_MANUAL_INVESTIGATION: NotificationTemplate.MANUAL_INVESTIGATION,
  NOT_OBSERVED_WITH_COMPLETE_COVERAGE: NotificationTemplate.CANNOT_REPRODUCE,
  BLOCKED_BY_OTP: NotificationTemplate.MANUAL_INVESTIGATION,
  BLOCKED_BY_KYC: NotificationTemplate.MANUAL_INVESTIGATION,
  BLOCKED_BY_PAYMENT: NotificationTemplate.MANUAL_INVESTIGATION,
  BLOCKED_BY_CREDENTIALS: NotificationTemplate.MANUAL_INVESTIGATION,
  BLOCKED_BY_ENVIRONMENT: NotificationTemplate.MANUAL_INVESTIGATION,
};

/** Classifications that should auto-close the GitHub issue once notified. */
const AUTO_CLOSE_CLASSIFICATIONS = new Set<DecisionClassification>([
  "LIKELY_FIXED",
  "DUPLICATE",
  "NOT_OBSERVED_WITH_COMPLETE_COVERAGE",
  "CANNOT_REPRODUCE",
]);

function daysSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Derives the work kind from GitHub labels for verification routing.
 *
 * Defaults to `"bug"` deliberately. Every issue in the bug-report queue
 * this orchestrator tracks IS a bug, so the default preserves today's behaviour
 * exactly; only an issue explicitly labelled otherwise (for example spec
 * issues `type:spec`) takes the deployment-record path. Defaulting the other
 * way would have silently stopped retesting real bugs.
 */
function verifiableKindFromLabels(labels: readonly string[]): VerifiableKind {
  const normalized = labels.map((l) => l.trim().toLowerCase());
  if (normalized.includes("type:spec")) return "spec";
  if (normalized.includes("type:feature")) return "feature";
  if (normalized.includes("type:chore")) return "chore";
  return "bug";
}

/**
 * The orchestration core of Lexi. Every method here
 * is idempotent: re-invoking it with the pipeline already past a given
 * point simply observes the current persisted state and no-ops (via
 * WorkflowStateMachine), which makes every BullMQ job safe to retry.
 *
 * The AI (DecisionEngine) is consulted exactly once per cycle, purely for
 * reasoning; every GitHub/Slack mutation and database write below is
 * deterministic code driven by that Decision, never the AI call itself.
 */
export class WorkflowOrchestrator {
  private readonly options: WorkflowOrchestratorOptions;
  private readonly policyEngine: PolicyEngine;

  constructor(
    private readonly repository: WorkflowRepository,
    private readonly github: GitHubProvider,
    private readonly reproduction: ReproductionProvider,
    private readonly decisionEngine: DecisionEngine,
    private readonly ownership: OwnershipResolver,
    private readonly slack: SlackProvider,
    private readonly metrics: MetricsRegistry,
    private readonly logger: PinoLoggerService,
    private readonly stateMachine: WorkflowStateMachine = new WorkflowStateMachine(),
    private readonly closureChecker: CrossOrgClosureChecker = new CrossOrgClosureChecker(github, logger),
    options: Partial<WorkflowOrchestratorOptions> = {},
    policyEngine?: PolicyEngine,
    private readonly evidenceRouter?: EvidenceFirstRouter,
    /**
     * Two-dimensional routing. OPTIONAL, and last, so every existing
     * construction site keeps compiling untouched: this class has ~20 of them
     * across specs plus the DI factory, and any other change shape would
     * cascade through all of them.
     *
     * Absent — or present but unusable, e.g. an ownership config with no
     * `platforms` block — means the orchestrator behaves exactly as it does
     * today, resolving ownership one-dimensionally from labels.
     */
    private readonly moduleRouter?: ModuleRouter,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.policyEngine =
      policyEngine ??
      new PolicyEngine({
        autoCloseMinConfidence: this.options.autoCloseMinConfidence,
        autoCloseMinScenarioFit: this.options.autoCloseMinScenarioFit,
      });
  }

  // ---------------------------------------------------------------------
  // (module x platform) routing
  // ---------------------------------------------------------------------

  /**
   * Infers `(module, platform)` for an issue and resolves it to a PIC.
   *
   * Returns undefined — meaning "fall back to today's one-dimensional
   * behaviour" — when no router is injected, when the router fails, or when
   * the ownership config predates the `platforms` block (in which case
   * `resolveModuleOwnership` throws by design). Triage that routes coarsely
   * is enormously better than triage that does not run.
   */
  private async inferModuleRouting(issue: IssueRecord): Promise<ModuleRoutingContext | undefined> {
    if (!this.moduleRouter) return undefined;
    try {
      const inference = await this.moduleRouter.infer({
        title: issue.title,
        body: issue.body ?? undefined,
        labels: issue.labels,
      });

      // A `domain:*` label is AUTHORITATIVE and outranks whatever the router
      // concluded. The router is a port: a future implementation may weigh
      // prose over labels, and prose is exactly what gets a mobile bug filed
      // by someone describing the web flow they compared it against.
      const platform = platformFromLabels(issue.labels) ?? inference.platform;

      return {
        inference,
        ownership: this.ownership.resolveModuleOwnership(inference.module, platform),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      this.logger.warn(
        `Two-dimensional ownership unavailable for #${issue.githubNumber}, using legacy component routing: ${message}`,
        "WorkflowOrchestrator",
      );
      return undefined;
    }
  }

  /**
   * Folds the (optional) two-dimensional answer together with the legacy
   * one-dimensional one.
   *
   * PERSISTED-COLUMN DECISION: `component` keeps its legacy, label-derived
   * meaning even here, and the module key is NOT written into it. `component`
   * is a stored column on `decisions` that existing rows, reports and
   * `component_hotspot` analysis already read; a module key ("portfolio") and
   * a component key ("mobile") are different axes, so mixing them in one
   * column would silently make a year of history incomparable — the query
   * would still run and would still return a number, just a meaningless one.
   * Adding `module`/`platform` columns is a schema migration and belongs to
   * whoever owns the migration, so until then the module survives on the
   * issue as the `module:<key>` label and in the decision's `reasoning`.
   *
   * `team` and `owner` DO take the two-dimensional answer. Neither changes
   * meaning: `team` was already the platform team (the legacy `components`
   * map is synthesised from `platforms`), and `owner` was always "who this is
   * assigned to" — it just stops being a round-robin pick from the whole
   * platform and becomes the module's actual PIC, which is the point.
   */
  private composeRouting(
    issue: IssueRecord,
    aiSuggestedComponent: string | undefined,
    context: ModuleRoutingContext | undefined,
  ): TriageRouting {
    const legacy = this.ownership.resolve(issue.labels, aiSuggestedComponent);
    const legacyChannel = this.ownership.getComponentConfig(legacy.component).channel;

    if (!context) {
      return {
        component: legacy.component,
        team: legacy.team,
        owner: legacy.owner,
        channel: legacyChannel,
        twoDimensional: false,
      };
    }

    return {
      component: legacy.component,
      team: context.ownership.team,
      owner: context.ownership.pic.githubLogin,
      channel: context.ownership.channel,
      module: context.ownership.module,
      platform: context.ownership.platform,
      moduleIsFallback: context.inference.isFallback || context.ownership.isDefaultModule,
      twoDimensional: true,
    };
  }

  /** Infer + compose in one step, for sites that have no AI decision to hand. */
  private async resolveRouting(issue: IssueRecord, aiSuggestedComponent?: string): Promise<TriageRouting> {
    return this.composeRouting(issue, aiSuggestedComponent, await this.inferModuleRouting(issue));
  }

  /**
   * Records the inferred module on the issue so the *next* read is a lookup
   * rather than an inference, and returns the label when it was written.
   *
   * A fallback is never written. `module:default` as a label would be read by
   * pass 1 of the next inference as an authoritative, already-decided answer —
   * which is precisely how one weak guess becomes permanent. The router
   * refuses this too; the guard is repeated here because the router is an
   * injected port and this is the side that does the writing.
   */
  private async applyModuleLabel(
    issue: IssueRecord,
    context: ModuleRoutingContext | undefined,
  ): Promise<string | undefined> {
    if (!this.moduleRouter || !context) return undefined;
    if (context.inference.isFallback || context.ownership.isDefaultModule) return undefined;

    try {
      const outcome = await this.moduleRouter.applyModuleLabel(
        this.github,
        {
          owner: issue.repoOwner,
          repo: issue.repoName,
          issueNumber: issue.githubNumber,
          labels: issue.labels,
        },
        context.inference,
      );
      if (!outcome.executed) {
        this.logger.log(
          `Module label ${outcome.label ?? ""} not applied to #${issue.githubNumber}: ${outcome.reason ?? "no reason given"}`,
          "WorkflowOrchestrator",
        );
        return undefined;
      }
      return outcome.label;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      this.logger.warn(
        `Module label write failed for #${issue.githubNumber}: ${message}`,
        "WorkflowOrchestrator",
      );
      return undefined;
    }
  }

  // ---------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------

  async discoverIssues(owner: string, repo: string, label: string): Promise<IssueRecord[]> {
    const githubIssues = await this.github.listBugHuntIssues({ owner, repo, label, state: "open" });
    const records: IssueRecord[] = [];
    for (const gh of githubIssues) {
      const record = await this.repository.upsertIssue({
        githubIssueId: gh.githubIssueId,
        githubNumber: gh.githubNumber,
        repoOwner: gh.repoOwner,
        repoName: gh.repoName,
        title: gh.title,
        body: gh.body,
        url: gh.url,
        authorLogin: gh.authorLogin,
        labels: gh.labels,
        state: gh.state,
        githubCreatedAt: new Date(gh.githubCreatedAt),
        githubUpdatedAt: new Date(gh.githubUpdatedAt),
      });
      records.push(record);
    }
    this.logger.log(`Discovered ${records.length} bug report issue(s) in ${owner}/${repo}`, "WorkflowOrchestrator");
    return records;
  }

  // ---------------------------------------------------------------------
  // /process - kick off (or resume) the pipeline for a single issue
  // ---------------------------------------------------------------------

  async processIssue(issueId: string): Promise<WorkflowExecutionRecord> {
    const issue = await this.requireIssue(issueId);
    let execution = await this.repository.findActiveWorkflowExecution(issue.id);
    if (!execution) {
      execution = await this.repository.createWorkflowExecution(issue.id, `process-${issue.id}-${randomUUID()}`);
      this.metrics.incIssuesProcessed("started");
    }

    // Evidence-First Pipeline: route through assessment before reproduction
    if (this.options.evidencePipelineEnabled && this.evidenceRouter && execution.status === WorkflowStatus.NEW) {
      return this.processWithEvidencePipeline(issue, execution);
    }

    return this.advanceToWaitingForReproduction(issue, execution);
  }

  /**
   * Evidence-First Pipeline path. Runs the full assessment pipeline:
   *   analyse → assess evidence → investigate engineering → assess fix → decide reproduction → route
   *
   * Persists an EvidenceAssessmentRecord before transitioning to the target state.
   * On failure, falls back to the reproduction-first path.
   */
  private async processWithEvidencePipeline(
    issue: IssueRecord,
    execution: WorkflowExecutionRecord,
  ): Promise<WorkflowExecutionRecord> {
    // Transition NEW → EVIDENCE_ASSESSMENT
    execution = await this.transitionExecution(issue, execution, WorkflowStatus.EVIDENCE_ASSESSMENT);
    await this.emitStage(issue, "evidence_assessment_started");

    try {
      const outcome = await this.evidenceRouter!.evaluate({
        issueNumber: issue.githubNumber,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        authorLogin: issue.authorLogin,
        state: issue.state,
        createdAt: issue.githubCreatedAt,
      });

      // Persist the assessment record before acting on it
      await this.persistEvidenceAssessment(issue, execution, outcome);
      await this.emitStage(issue, "evidence_assessment_completed");

      // Route to the target state
      const targetStatus = this.mapRouteToStatus(outcome.routeTo);

      if (targetStatus === WorkflowStatus.QUEUED) {
        // Needs reproduction — continue with the reproduction pipeline
        execution = await this.transitionExecution(issue, execution, WorkflowStatus.QUEUED);
        return this.advanceToWaitingForReproduction(issue, execution);
      }

      // Non-reproduction outcomes
      execution = await this.transitionExecution(issue, execution, targetStatus);
      this.logger.log(
        `Evidence pipeline routed #${issue.githubNumber} to ${targetStatus}: ${outcome.reason}`,
        "WorkflowOrchestrator",
      );
      return execution;
    } catch (err) {
      // On failure, fall back to the reproduction-first path
      const message = err instanceof Error ? err.message : "Unknown evidence pipeline error";
      this.logger.error(
        `Evidence pipeline failed for #${issue.githubNumber}, falling back to reproduction: ${message}`,
        "WorkflowOrchestrator",
      );
      // Transition back to QUEUED and proceed normally
      execution = await this.transitionExecution(issue, execution, WorkflowStatus.QUEUED);
      return this.advanceToWaitingForReproduction(issue, execution);
    }
  }

  private mapRouteToStatus(route: string): WorkflowStatus {
    switch (route) {
      case "QUEUED": return WorkflowStatus.QUEUED;
      case "SLACK_NOTIFIED": return WorkflowStatus.SLACK_NOTIFIED;
      case "RETEST": return WorkflowStatus.RETEST;
      case "CLOSED": return WorkflowStatus.CLOSED;
      case "WRITE_BLOCKED": return WorkflowStatus.WRITE_BLOCKED;
      default: return WorkflowStatus.QUEUED;
    }
  }

  private async persistEvidenceAssessment(
    issue: IssueRecord,
    execution: WorkflowExecutionRecord,
    outcome: EvidenceRoutingOutcome,
  ): Promise<void> {
    try {
      const prisma = (this.repository as any).prisma;
      if (!prisma?.evidenceAssessmentRecord?.create) return;

      await prisma.evidenceAssessmentRecord.create({
        data: {
          id: randomUUID(),
          issueId: issue.id,
          workflowExecutionId: execution.id,
          inputRevision: `${issue.githubNumber}:${issue.title.slice(0, 50)}:${issue.githubUpdatedAt.toISOString()}`,
          analysisStatus: "completed",
          evidenceAssessmentStatus: "completed",
          investigationStatus: outcome.stages.engineeringInvestigation.errors.length > 0 ? "partial" : "completed",
          fixAssessmentStatus: "completed",
          reproductionDecisionStatus: "completed",
          issueAnalysis: outcome.stages.issueAnalysis as unknown as object,
          observationAssessment: outcome.stages.observationAssessment as unknown as object,
          engineeringInvestigation: outcome.stages.engineeringInvestigation as unknown as object,
          fixAssessment: outcome.stages.fixAssessment as unknown as object,
          reproductionDecision: outcome.stages.reproductionDecision as unknown as object,
          policyVersion: "v1.0",
          analysisModel: outcome.stages.issueAnalysis.model,
          analysisSource: outcome.stages.issueAnalysis.source,
          routedTo: outcome.routeTo,
          routingReason: outcome.reason,
          updatedAt: new Date(),
        },
      });
    } catch (persistErr) {
      // Persistence failure must not block the pipeline — log and continue
      const msg = persistErr instanceof Error ? persistErr.message : "unknown";
      this.logger.error(`Failed to persist EvidenceAssessmentRecord for #${issue.githubNumber}: ${msg}`, "WorkflowOrchestrator");
    }
  }

  /**
   * Forces a fresh cycle even if one is already active -- used by
   * POST /reprocess, e.g. after the issue body/labels were manually edited
   * and the in-flight cycle's context is stale. The previous execution (if
   * any) is cancelled rather than deleted, preserving history.
   */
  async reprocessIssue(issueId: string): Promise<WorkflowExecutionRecord> {
    const issue = await this.requireIssue(issueId);
    const active = await this.repository.findActiveWorkflowExecution(issue.id);
    if (active) {
      await this.transitionExecution(issue, active, WorkflowStatus.CANCELLED);
    }
    return this.processIssue(issue.id);
  }

  private async advanceToWaitingForReproduction(
    issue: IssueRecord,
    execution: WorkflowExecutionRecord,
  ): Promise<WorkflowExecutionRecord> {
    if (execution.status === WorkflowStatus.NEW) {
      execution = await this.transitionExecution(issue, execution, WorkflowStatus.QUEUED);
    }

    if (execution.status === WorkflowStatus.QUEUED) {
      const closureEvidence = await this.closureChecker.check(issue);
      if (closureEvidence) {
        return this.closeViaExistingEvidence(issue, execution, closureEvidence);
      }

      const request: ReproductionRequest = {
        issueId: issue.id,
        issueNumber: issue.githubNumber,
        title: issue.title,
        body: issue.body,
        url: issue.url,
        labels: issue.labels,
        repoOwner: issue.repoOwner,
        repoName: issue.repoName,
      };

      const submission = await this.reproduction.submitIssue(request);
      const providerName = this.reproduction.providerName ?? "unknown-reproduction-adapter";

      const createdAttempt = await this.repository.createReproductionAttempt({
        issueId: issue.id,
        workflowExecutionId: execution.id,
        providerName,
        externalId: submission.externalId,
        status: submission.status,
      });
      if (submission.persist) {
        await this.repository.updateReproductionAttempt(createdAttempt.id, {
          resultDetails: submission.persist,
        });
      }
      // `WorkflowExecution.attempts` existed but nothing ever wrote it, so it
      // read 0 for every execution ever created — and it is surfaced to the
      // agent, where a permanent 0 was mistaken for "this never started".
      // Count the reproduction attempts actually dispatched for this execution.
      execution = await this.repository.updateWorkflowExecution(execution.id, {
        attempts: execution.attempts + 1,
      });
      execution = await this.transitionExecution(issue, execution, WorkflowStatus.SENT_TO_REPRODUCTION);
      execution = await this.transitionExecution(issue, execution, WorkflowStatus.WAITING);
      await this.emitStage(issue, "REPRODUCING", `waiting for ${providerName} result`);
      await this.emitStage(issue, "AWAITING_HUMAN_INPUT", submission.externalId);
      this.logger.log(
        `Issue #${issue.githubNumber} sent to reproduction via ${providerName} (${submission.externalId})`,
        "WorkflowOrchestrator",
      );

      // Synchronous providers (an LLM judge, and potentially others) can resolve to a terminal status
      // immediately in submitIssue -- but listActiveReproductionAttempts only ever looks at
      // PENDING/RUNNING rows, so such an attempt would never be picked up by any future poll
      // cycle. Poll it right now in that case rather than leaving the execution stuck in WAITING
      // forever (confirmed as a real gap via live testing, not just a latency nicety).
      if (
        submission.status === "COMPLETED" ||
        submission.status === "FAILED" ||
        submission.status === "TIMEOUT" ||
        submission.status === "CANCELLED"
      ) {
        // WAITING was already persisted above, and for a synchronous provider it
        // is only ever a few lines wide -- this poll is what clears it. If the
        // poll throws (a provider error, or the AI analysis behind it), the row
        // would be left at WAITING, which findActiveWorkflowExecution still
        // counts as active: the execution looks in-flight forever, the retry
        // queue cannot see it (its attempt row is already terminal, so
        // listActiveReproductionAttempts never returns it), and every later
        // `process` no-ops against it. Roll it to FAILED so it stops looking
        // active, then rethrow so the caller reports the failure instead of
        // "submitted for processing".
        try {
          await this.pollReproduction(createdAttempt);
        } catch (err) {
          const message = err instanceof Error ? err.message : "unknown reproduction poll error";
          await this.failStrandedExecution(issue, `inline reproduction poll failed: ${message}`);
          throw err;
        }
        // Re-read by id, not by "active": the poll may well have driven this to
        // CLOSED, which findActiveWorkflowExecution filters out — that returned
        // null and left the caller holding the stale pre-poll WAITING copy,
        // reporting a finished cycle as still waiting.
        const refreshed = await this.repository.getWorkflowExecutionById(execution.id);
        if (refreshed) {
          execution = refreshed;
        }
      }
    }

    // Re-entry. This method only advances NEW and QUEUED, so a WAITING
    // execution falls through both branches above untouched. That silence is
    // correct while the provider genuinely has work in flight, but not when the
    // execution is stranded -- and in that case the caller reports "submitted
    // for processing" with the old workflow id while nothing at all ran.
    if (execution.status === WorkflowStatus.WAITING) {
      execution = await this.recoverStrandedWaiting(issue, execution);
    }

    return execution;
  }

  /**
   * Distinguishes an execution that is legitimately waiting on an asynchronous
   * provider from one that is stranded, and finishes the latter.
   *
   * The discriminator is the attempt row's status. The retry queue only ever
   * selects PENDING/RUNNING attempts, so:
   *   - PENDING/RUNNING -> genuinely in flight; the retry queue owns it and
   *     re-processing must stay a benign no-op.
   *   - terminal        -> no poll cycle can ever pick it up again. The inline
   *     poll that should have finalized it did not, so finish it here.
   *
   * Only WAITING is recovered. An execution parked at SENT_TO_REPRODUCTION is
   * the same class of problem but a far narrower window (two adjacent awaits),
   * and pollReproduction would refuse it anyway; that one still needs reprocess.
   */
  private async recoverStrandedWaiting(
    issue: IssueRecord,
    execution: WorkflowExecutionRecord,
  ): Promise<WorkflowExecutionRecord> {
    const attempt = await this.repository.getLatestReproductionAttemptForIssue(issue.id);

    if (!attempt) {
      // WAITING with no attempt at all: nothing to poll, and nothing will ever
      // create one for this execution. Fail it so the next process starts clean.
      const failed = await this.failStrandedExecution(
        issue,
        "execution reached WAITING with no reproduction attempt to poll",
      );
      return failed ?? execution;
    }

    // The lookup is issue-scoped, so on an issue with history it can return an
    // attempt belonging to an earlier execution. Finalizing this execution from
    // another cycle's evidence would produce a decision about the wrong run, so
    // treat that as unrecoverable here and just stop it looking active.
    if (attempt.workflowExecutionId && attempt.workflowExecutionId !== execution.id) {
      const failed = await this.failStrandedExecution(
        issue,
        `execution stranded in WAITING; the latest reproduction attempt (${attempt.externalId}) belongs to ` +
          `execution ${attempt.workflowExecutionId}, so it cannot be finalized from that evidence`,
      );
      return failed ?? execution;
    }

    if (attempt.status === "PENDING" || attempt.status === "RUNNING") {
      return execution;
    }

    this.logger.warn(
      `Issue #${issue.githubNumber}: execution ${execution.id} was stranded in WAITING behind a terminal ` +
        `${attempt.status} attempt (${attempt.externalId}) that no poll cycle can pick up — finalizing it now`,
      "WorkflowOrchestrator",
    );

    try {
      await this.pollReproduction(attempt);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown reproduction poll error";
      await this.failStrandedExecution(
        issue,
        `recovery poll for a stranded WAITING execution failed: ${message}`,
      );
      throw err;
    }

    return (await this.repository.getWorkflowExecutionById(execution.id)) ?? execution;
  }

  /**
   * Marks whatever execution is currently active for an issue as FAILED, so a
   * half-finished cycle stops being counted as in-flight by
   * findActiveWorkflowExecution (which excludes CLOSED/CANCELLED/FAILED).
   *
   * Re-reads the active execution rather than trusting a caller-held copy: the
   * poll that just threw may already have moved the row on before failing, and
   * the transition has to be asserted against the row's real current status.
   * Never throws -- it runs on an error path, and masking the original error
   * with a bookkeeping failure would lose the actual cause. Returns the updated
   * row, or null if there was nothing to fail (or the update itself failed).
   */
  /**
   * Closes out a reproduction attempt that the currently-wired adapter can never
   * poll, because it was recorded under a different provider.
   *
   * Marks the attempt FAILED so it leaves the retry queue's PENDING/RUNNING
   * selection, and fails its execution so the issue stops looking in-flight.
   * The details deliberately carry `reproduced: null` + `incompleteEvidence`, in
   * the infra-failure shape: this is "we can no longer find out", never "we
   * looked and the bug is not there", so no auto-close can follow from it.
   */
  private async retireUnpollableAttempt(
    attempt: ReproductionAttemptRecord,
    activeProvider: string,
  ): Promise<void> {
    const summary =
      `Reproduction attempt ${attempt.externalId} was recorded under provider ` +
      `${attempt.providerName}, which is no longer active (${activeProvider}); it can never be polled.`;
    this.logger.error(`Retiring unpollable reproduction attempt — ${summary}`, "WorkflowOrchestrator");

    try {
      await this.repository.updateReproductionAttempt(attempt.id, {
        status: "FAILED",
        resultSummary: summary,
        resultDetails: {
          error: "provider_changed",
          outcomeKind: "infra_failure",
          reproduced: null,
          incompleteEvidence: true,
          recordedProvider: attempt.providerName,
          activeProvider,
        },
        completedAt: new Date(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      this.logger.error(
        `Could not retire reproduction attempt ${attempt.externalId}: ${message}`,
        "WorkflowOrchestrator",
      );
      return;
    }

    const issue = await this.repository.getIssueById(attempt.issueId);
    if (issue) {
      await this.failStrandedExecution(issue, summary);
    }
  }

  private async failStrandedExecution(
    issue: IssueRecord,
    reason: string,
  ): Promise<WorkflowExecutionRecord | null> {
    try {
      const current = await this.repository.findActiveWorkflowExecution(issue.id);
      if (!current) return null; // already CLOSED/CANCELLED/FAILED — nothing stranded
      const note = reason.slice(0, 1000);
      this.stateMachine.assertTransition(current.status, WorkflowStatus.FAILED);
      const updated = await this.repository.updateWorkflowExecution(current.id, {
        status: WorkflowStatus.FAILED,
        lastError: note,
        completedAt: new Date(),
      });
      await this.repository.recordIssueState(issue.id, WorkflowStatus.FAILED, undefined, note);
      this.logger.error(
        `Issue #${issue.githubNumber}: execution ${current.id} marked FAILED — ${note}`,
        "WorkflowOrchestrator",
      );
      return updated;
    } catch (bookkeepingErr) {
      const message = bookkeepingErr instanceof Error ? bookkeepingErr.message : "unknown error";
      this.logger.error(
        `Issue #${issue.githubNumber}: could not mark the stranded execution FAILED: ${message}`,
        "WorkflowOrchestrator",
      );
      return null;
    }
  }

  /**
   * Cross-org closure short-circuit: CrossOrgClosureChecker found a linked
   * issue/PR (in this or another org) that's already closed/merged, which
   * is a deterministic, stronger signal than the AI's textual guess would
   * be. No AI call is made -- reproduction and AI analysis are skipped
   * entirely, and the Decision recorded here reflects that (confidence 1,
   * reasoning citing the evidence URL) rather than pretending the model was
   * consulted.
   */
  private async closeViaExistingEvidence(
    issue: IssueRecord,
    execution: WorkflowExecutionRecord,
    evidence: ClosureEvidence,
  ): Promise<WorkflowExecutionRecord> {
    const comment = [
      `**Automated Bug Triage Result**`,
      ``,
      `This issue appears to already be fixed: it links to a ${evidence.type === "pull" ? "pull request" : "issue"} ` +
        `that is already ${evidence.type === "pull" ? "merged" : "closed"} (${evidence.url}).`,
      ``,
      `_Reasoning:_ Cross-org closure check found ${evidence.url} confirming this was already resolved. Closing automatically.`,
    ].join("\n");

    const commentResult = await this.mutateGithub("github.addComment", (g) =>
      g.addComment(issue.repoOwner, issue.repoName, issue.githubNumber, comment),
    );
    if (!commentResult.executed) {
      return this.finishWriteGateBlocked(issue, execution, true);
    }
    this.metrics.incGithubUpdate("add_comment");

    const closeResult = await this.mutateGithub("github.closeIssue", (g) =>
      g.closeIssue(issue.repoOwner, issue.repoName, issue.githubNumber, "completed"),
    );
    if (!closeResult.executed) {
      return this.finishWriteGateBlocked(issue, execution, true);
    }
    this.metrics.incGithubUpdate("close_issue");

    await this.repository.createDecision({
      issueId: issue.id,
      reproductionAttemptId: null,
      classification: "LIKELY_FIXED",
      component: "unassigned",
      team: issue.assignedTeam ?? "Triage",
      owner: issue.assignedOwner ?? null,
      confidence: 1,
      labels: issue.labels,
      summary: "Already fixed: confirmed via a linked cross-org issue/PR.",
      reasoning: `Cross-org closure check found ${evidence.url} (${evidence.type === "pull" ? "merged PR" : "closed issue"}) confirming this was already resolved. No AI call was made.`,
      nextAction: "None -- issue closed automatically.",
    });

    execution = await this.transitionExecution(issue, execution, WorkflowStatus.CLOSED);
    await this.repository.updateIssue(issue.id, { currentStatus: WorkflowStatus.CLOSED, state: "closed" });
    this.metrics.incIssuesProcessed("cross_org_closed");

    this.logger.log(
      `Issue #${issue.githubNumber} closed via cross-org closure check (${evidence.url})`,
      "WorkflowOrchestrator",
    );

    return execution;
  }

  // ---------------------------------------------------------------------
  // Polling - called by the scheduler's retry queue for every WAITING issue
  // ---------------------------------------------------------------------

  /**
   * Resolves which adapter owns a reproduction attempt for polling.
   * With a single configured provider, fallback runs (e.g. an LLM judge when no scenario
   * matches) are still polled through the same `this.reproduction` instance.
   */
  private resolveReproductionProvider(providerName: string): ReproductionProvider {
    return this.reproduction;
  }

  async pollReproduction(reproductionAttempt: ReproductionAttemptRecord): Promise<void> {
    const activeProvider = this.reproduction.providerName ?? "unknown-reproduction-adapter";
    if (reproductionAttempt.providerName !== activeProvider) {
      // REPRODUCTION_PROVIDER was changed after this attempt was recorded, so
      // its externalId means nothing to the adapter now wired up and it can
      // never be polled. This used to just `return`, which looked harmless but
      // was permanent: the attempt stayed PENDING, so every retry cycle
      // re-selected it and re-skipped it, and its execution sat in WAITING
      // forever -- silently, with no error anywhere. Retire it instead, so the
      // execution stops looking in-flight and a fresh cycle can run.
      await this.retireUnpollableAttempt(reproductionAttempt, activeProvider);
      return;
    }

    const provider = this.resolveReproductionProvider(reproductionAttempt.providerName);
    if (provider.preparePoll) {
      await provider.preparePoll(reproductionAttempt.externalId, reproductionAttempt.resultDetails);
    }
    const status = await provider.getStatus(reproductionAttempt.externalId);
    if (status === "PENDING" || status === "RUNNING") {
      const persist = provider.getSessionPersist?.(reproductionAttempt.externalId);
      const patch: { status?: ReproductionStatus; resultDetails?: Record<string, unknown> } = {};
      if (status !== reproductionAttempt.status) {
        patch.status = status;
      }
      if (persist) {
        patch.resultDetails = persist;
      }
      if (Object.keys(patch).length > 0) {
        await this.repository.updateReproductionAttempt(reproductionAttempt.id, patch);
      }
      return;
    }

    const result = await provider.getResult(reproductionAttempt.externalId);
    const issueForLifecycle = await this.repository.getIssueById(reproductionAttempt.issueId);
    const rawDetails = result?.details ?? null;
    const enrichedDetails =
      issueForLifecycle
        ? enrichResultDetailsWithLifecycle(issueForLifecycle, rawDetails as Record<string, unknown> | null)
        : rawDetails;

    const updated = await this.repository.updateReproductionAttempt(reproductionAttempt.id, {
      status,
      resultSummary: result?.summary ?? null,
      resultDetails: enrichedDetails ?? null,
      logsUrl: result?.logsUrl ?? null,
      completedAt: new Date(),
    });

    await this.persistEvidence(updated.issueId, result?.details);

    const issue = await this.requireIssue(updated.issueId);
    let execution = await this.repository.findActiveWorkflowExecution(issue.id);
    if (!execution) {
      this.logger.error(
        `No active workflow execution found for issue ${issue.id} while finalizing reproduction`,
        "WorkflowOrchestrator",
      );
      return;
    }

    if (execution.status !== WorkflowStatus.WAITING && execution.status !== WorkflowStatus.RETEST) {
      // Already progressed past this point by a previous (possibly retried) job.
      return;
    }

    if (execution.status === WorkflowStatus.RETEST) {
      await this.finalizeRetest(issue, execution, updated);
      return;
    }

    execution = await this.transitionExecution(issue, execution, WorkflowStatus.RESULT_RECEIVED);
    await this.emitStage(issue, "ANALYSING");
    await this.runAiAnalysis(issue, execution, updated);
  }

  private async runAiAnalysis(
    issue: IssueRecord,
    execution: WorkflowExecutionRecord,
    reproductionAttempt: ReproductionAttemptRecord,
  ): Promise<void> {
    execution = await this.transitionExecution(issue, execution, WorkflowStatus.AI_ANALYSIS);

    const input: AiDecisionInput = {
      issue: {
        number: issue.githubNumber,
        title: issue.title,
        body: issue.body,
        url: issue.url,
        authorLogin: issue.authorLogin,
        labels: issue.labels,
      },
      reproduction: {
        status: reproductionAttempt.status,
        resultSummary: reproductionAttempt.resultSummary,
        resultDetails: reproductionAttempt.resultDetails,
        logsUrl: reproductionAttempt.logsUrl,
      },
    };

    const enrichedDetails = enrichResultDetailsWithLifecycle(
      issue,
      reproductionAttempt.resultDetails as Record<string, unknown> | null,
    );

    const escalation = evaluateEscalation(enrichedDetails, { issueLabels: issue.labels });

    // Inferred ONCE per cycle and reused by every routing site below, so the
    // sites cannot disagree with each other about who owns this issue.
    const moduleRouting = await this.inferModuleRouting(issue);

    let decision: Decision;
    let ownershipResolution: TriageRouting;

    if (escalation) {
      const seedOwnership = this.composeRouting(issue, "web", moduleRouting);
      decision = buildDeterministicDecision(escalation, {
        component: seedOwnership.component,
        team: seedOwnership.team,
        owner: seedOwnership.owner,
        labels: issue.labels,
      });
      ownershipResolution = this.composeRouting(issue, decision.component, moduleRouting);
      this.logger.log(
        `Issue #${issue.githubNumber} escalation override: ${decision.classification} (${escalation.escalationTarget})`,
        "WorkflowOrchestrator",
      );

    } else {
      decision = await this.decisionEngine.decide(input);
      decision = {
        ...decision,
        classification: remapCompleteCoverageClassification(
          decision.classification,
          enrichedDetails,
        ),
      };
      ownershipResolution = this.composeRouting(issue, decision.component, moduleRouting);
    }

    if (
      enrichedDetails?.evidenceSource === "manual_slack" &&
      enrichedDetails?.incompleteEvidence === true &&
      decision.classification === "CANNOT_REPRODUCE"
    ) {
      decision = {
        ...decision,
        classification: "NEEDS_MANUAL_INVESTIGATION",
        summary: `${decision.summary} Slack manual reproduction lacked structured lifecycle evidence.`,
        reasoning: `${decision.reasoning} A shallow Slack reply cannot satisfy lifecycle coverage — manual investigation required.`,
        nextAction: "Perform structured reproduction with lifecycle evidence before any closure.",
      };
      ownershipResolution = this.composeRouting(issue, decision.component, moduleRouting);
    }

    // Record the module on the issue itself before the decision row is written,
    // and fold the applied label into the in-memory snapshot: handleVerified's
    // setLabels sweep is computed from `issue.labels`, so a label applied after
    // this point would be stripped by the very next write.
    const appliedModuleLabel = await this.applyModuleLabel(issue, moduleRouting);
    if (appliedModuleLabel) {
      issue = { ...issue, labels: [...issue.labels, appliedModuleLabel] };
    }

    const moduleNote = ownershipResolution.twoDimensional
      ? ` Routed by module/platform: ${ownershipResolution.module}/${ownershipResolution.platform}` +
        `${ownershipResolution.moduleIsFallback ? " (module not identified — default)" : ""}.`
      : "";

    const decisionRecord = await this.repository.createDecision({
      issueId: issue.id,
      reproductionAttemptId: reproductionAttempt.id,
      classification: decision.classification,
      component: ownershipResolution.component,
      team: ownershipResolution.team,
      owner: ownershipResolution.owner ?? null,
      confidence: decision.confidence,
      labels: decision.labels,
      summary: decision.summary,
      // The module/platform axis has no column on `decisions` (see
      // composeRouting), so it is recorded here rather than being lost.
      reasoning: `${decision.reasoning}${moduleNote}`,
      nextAction: decision.nextAction,
    });

    if (this.options.onEngineeringMemory) {
      try {
        await this.options.onEngineeringMemory({
          githubNumber: issue.githubNumber,
          repoOwner: issue.repoOwner,
          repoName: issue.repoName,
          classification: decision.classification,
          confidence: decision.confidence,
          summary: decision.summary,
          owner: ownershipResolution.owner,
          team: ownershipResolution.team,
          component: ownershipResolution.component,
        });
      } catch (error) {
        this.logger.warn(
          `Engineering memory hook failed for #${issue.githubNumber}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }

    this.metrics.incVerificationSuccess(decision.classification === "VERIFIED" ? "success" : "not_verified");

    await this.emitStage(issue, "POLICY_EVALUATION", decision.classification, {
      classification: decision.classification,
      confidence: decision.confidence,
      executionSummary: decision.summary,
    });

    if (decision.classification === "VERIFIED") {
      await this.handleVerified(
        issue,
        execution,
        decision,
        ownershipResolution.team,
        ownershipResolution.owner,
        decisionRecord.id,
        reproductionAttempt,
        ownershipResolution,
      );
    } else {
      await this.handleNonVerified(
        issue,
        execution,
        decision,
        ownershipResolution.team,
        ownershipResolution.owner,
        decisionRecord.id,
        reproductionAttempt,
        ownershipResolution,
      );
    }
  }

  private async handleVerified(
    issue: IssueRecord,
    execution: WorkflowExecutionRecord,
    decision: Decision,
    team: string,
    owner: string | undefined,
    decisionId: string,
    reproductionAttempt: ReproductionAttemptRecord,
    routing?: TriageRouting,
  ): Promise<void> {
    execution = await this.transitionExecution(issue, execution, WorkflowStatus.VERIFIED);

    const statusLabels = this.ownership.getStatusLabels();
    // A "status:*" label is mutually exclusive by convention in this tracker (confirmed via live
    // testing: without this filter, an issue already carrying e.g. "status:in_progress" ended up
    // with both that AND "status:to_do" simultaneously) -- strip any existing status:* label
    // before adding the one this transition actually implies.
    const nonStatusLabels = [...issue.labels, ...decision.labels].filter((label) => !label.startsWith("status:"));
    const desiredLabels = Array.from(new Set([...nonStatusLabels, statusLabels.toDo]));
    const labelsResult = await this.mutateGithub("github.setLabels", (g) =>
      g.setLabels(issue.repoOwner, issue.repoName, issue.githubNumber, desiredLabels),
    );
    if (!labelsResult.executed) {
      await this.finishWriteGateBlocked(issue, execution, false);
      return;
    }
    this.metrics.incGithubUpdate("set_labels");

    if (owner) {
      const assignResult = await this.mutateGithub("github.assignUsers", (g) =>
        g.assignUsers(issue.repoOwner, issue.repoName, issue.githubNumber, [owner]),
      );
      if (!assignResult.executed) {
        await this.finishWriteGateBlocked(issue, execution, false);
        return;
      }
      this.metrics.incGithubUpdate("assign_users");
    }

    const verificationBody = await this.buildVerificationComment(issue, decision, team, owner, reproductionAttempt);
    const commentResult = await this.mutateGithub("github.addComment", (g) =>
      g.addComment(issue.repoOwner, issue.repoName, issue.githubNumber, verificationBody),
    );
    if (!commentResult.executed) {
      await this.finishWriteGateBlocked(issue, execution, false);
      return;
    }
    this.metrics.incGithubUpdate("add_comment");

    await this.repository.updateIssue(issue.id, {
      currentStatus: WorkflowStatus.VERIFIED,
      assignedTeam: team,
      assignedOwner: owner ?? null,
      labels: desiredLabels,
    });

    execution = await this.transitionExecution(issue, execution, WorkflowStatus.ASSIGNED);

    const channel = routing?.channel ?? this.ownership.getComponentConfig(decision.component).channel;
    await this.sendNotification(issue, "VERIFIED", NotificationTemplate.VERIFIED, decisionId, channel, decision, team, owner);

    await this.transitionExecution(issue, execution, WorkflowStatus.SLACK_NOTIFIED);
    await this.repository.updateIssue(issue.id, { currentStatus: WorkflowStatus.SLACK_NOTIFIED });
    this.metrics.incIssuesProcessed("verified");
    await this.emitStage(issue, "COMPLETED", decision.classification, {
      classification: decision.classification,
      confidence: decision.confidence,
      executionSummary: decision.summary,
    });

    if (this.options.onConfirmedBug) {
      const details = (reproductionAttempt.resultDetails ?? {}) as Record<string, unknown>;
      void this.options
        .onConfirmedBug({
          githubNumber: issue.githubNumber,
          title: issue.title,
          body: issue.body,
          url: issue.url,
          labels: issue.labels,
          repoOwner: issue.repoOwner,
          repoName: issue.repoName,
          reproduced: details.reproduced === true,
          summary: decision.summary,
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "unknown error";
          this.logger.warn(
            `Confirmed-bug fix callback failed for #${issue.githubNumber}: ${message}`,
            "WorkflowOrchestrator",
          );
        });
    }
  }

  private async handleNonVerified(
    issue: IssueRecord,
    execution: WorkflowExecutionRecord,
    decision: Decision,
    team: string,
    owner: string | undefined,
    decisionId: string,
    reproductionAttempt: ReproductionAttemptRecord,
    routing?: TriageRouting,
  ): Promise<void> {
    const templateName = CLASSIFICATION_TO_TEMPLATE[decision.classification];
    const notificationTemplate = CLASSIFICATION_TO_NOTIFICATION_TEMPLATE[decision.classification];
    // Consults the cycle's single resolution rather than re-deriving a
    // component from the AI's guess.
    const channel = routing?.channel ?? this.ownership.getComponentConfig(decision.component).channel;

    const autoCloseEval = (() => {
      // For reproduction-based classifications, use the canonical VerificationResult path.
      // For non-reproduction classifications (LIKELY_FIXED, DUPLICATE), trust the AI.
      const reproductionBasedClassifications = new Set(["CANNOT_REPRODUCE", "NOT_OBSERVED_WITH_COMPLETE_COVERAGE", "BLOCKED_BY_OTP", "BLOCKED_BY_KYC", "BLOCKED_BY_PAYMENT", "BLOCKED_BY_CREDENTIALS", "BLOCKED_BY_ENVIRONMENT"]);

      if (reproductionBasedClassifications.has(decision.classification)) {
        const verificationResult = mapReproductionResultToVerification(
          issue,
          reproductionAttempt.resultDetails as any,
          (reproductionAttempt.resultDetails as any)?.reproduced ?? null,
          reproductionAttempt.externalId,
          reproductionAttempt.logsUrl,
        );
        // The auto-close gate requires BOTH verification confidence AND decision confidence.
        const effectiveConfidence = Math.min(verificationResult.confidence, decision.confidence);
        const gatedResult = { ...verificationResult, confidence: effectiveConfidence };
        return evaluateVerificationAutoClose(gatedResult, {
          minConfidence: this.options.autoCloseMinConfidence ?? 0.85,
          minScenarioFit: this.options.autoCloseMinScenarioFit ?? 0.75,
        });
      }

      // Non-reproduction classifications: use decision confidence directly.
      // LIKELY_FIXED, DUPLICATE don't depend on reproduction evidence quality.
      const allowed = decision.confidence >= (this.options.autoCloseMinConfidence ?? 0.85);
      return {
        allowed,
        reason: allowed
          ? `Classification ${decision.classification} with confidence ${decision.confidence.toFixed(2)} passes auto-close gate.`
          : `Decision confidence ${decision.confidence.toFixed(2)} below threshold.`,
      };
    })();

    const verificationBody = await this.buildVerificationComment(
      issue,
      decision,
      team,
      owner,
      reproductionAttempt,
      autoCloseEval,
    );
    const commentResult = await this.mutateGithub("github.addComment", (g) =>
      g.addComment(issue.repoOwner, issue.repoName, issue.githubNumber, verificationBody),
    );
    if (!commentResult.executed) {
      await this.finishWriteGateBlocked(issue, execution, autoCloseEval.allowed);
      return;
    }
    this.metrics.incGithubUpdate("add_comment");

    execution = await this.transitionExecution(issue, execution, WorkflowStatus.SLACK_NOTIFIED);
    // A dynamic-reproduction hand-off borrows the MANUAL_INVESTIGATION template,
    // whose default copy does not say what kind of session was asked for. The
    // judge's bar for needsDynamicReproduction is "a real browser OR device
    // session", which covers reading a console error on a public URL as well as
    // a selfie capture. Announcing that a person is needed for the first kind is
    // wrong, so say which kind was actually asked for. Read straight off the
    // attempt that produced the verdict, which is the record the judge wrote.
    const rawKind = reproductionAttempt.resultDetails?.dynamicReproductionKind;
    const dynamicKind = rawKind === "browser" || rawKind === "human" ? rawKind : null;

    const isDynamicHandOff =
      decision.classification === "NEEDS_MANUAL_INVESTIGATION" &&
      reproductionAttempt.resultDetails?.needsDynamicReproduction === true;
    const notificationReason = isDynamicHandOff
      ? dynamicKind === "browser"
        ? "Reproduction needs a live browser session; the text-only judge could not confirm it " +
          "from the report alone. No human-only step (OTP, selfie, passkey, funded account) was " +
          "identified, so an automated session should settle it. This is a hand-off, not a stalled issue."
        : dynamicKind === "human"
          ? "Reproduction requires a human on a real device (a human-verification step such as OTP, " +
            "selfie, passkey, or a real account state). This is a hand-off, not a stalled issue."
          : "Reproduction needs a live browser or device session; the text-only judge could not " +
            "confirm it from the report alone. This is a hand-off, not a stalled issue."
      : undefined;

    await this.sendNotification(
      issue,
      templateName,
      notificationTemplate,
      decisionId,
      channel,
      decision,
      team,
      owner,
      notificationReason,
    );

    // Pending closure requires writes — when disabled, fall through to immediate close if allowed.
    if (AUTO_CLOSE_CLASSIFICATIONS.has(decision.classification) && autoCloseEval.allowed) {
      const enrichedDetails = enrichResultDetailsWithLifecycle(
        issue,
        reproductionAttempt.resultDetails as Record<string, unknown> | null,
      );
      const lifecycle = enrichedDetails?.lifecycleCoverage as
        | { coverageComplete?: boolean }
        | undefined;
      const attempts = enrichedDetails?.attempts;
      const qualifyingAttemptCount =
        Array.isArray(attempts) ? attempts.length : 1;
      const lastEval = Array.isArray(enrichedDetails?.evaluations)
        ? (enrichedDetails.evaluations as Array<{ retryRecommended?: boolean }>).at(-1)
        : undefined;

      const pendingEval = evaluatePendingClosure(
        {
          classification: decision.classification,
          decisionConfidence: decision.confidence,
          lifecycleCoverageComplete: Boolean(lifecycle?.coverageComplete),
          incompleteEvidence: enrichedDetails?.incompleteEvidence === true,
          qualifyingAttemptCount,
          outcomeKind: enrichedDetails?.outcomeKind as string | undefined,
          reproduced: enrichedDetails?.reproduced as boolean | null | undefined,
          labels: issue.labels,
          hasLinkedOpenPr: false,
          hasRecentHumanComment: false,
          retryRecommended: lastEval?.retryRecommended,
        },
        {
          enabled: this.options.pendingClosureEnabled ?? false,
          gracePeriodDays: this.options.pendingClosureGraceDays ?? 7,
          minQualifyingAttempts: this.options.pendingClosureMinAttempts ?? 2,
          pendingLabel: this.options.pendingClosureLabel ?? "lexi:pending-closure",
          notObservedLabel: "lexi:not-observed",
          holdLabels: ["lexi:hold", "keep-open"],
          protectedLabels: ["security", "keep-open", "lexi:hold"],
          protectedSeverities: ["s1", "s2"],
          protectedPriorities: ["p0", "p1"],
          minConfidence: this.options.autoCloseMinConfidence ?? 0.85,
          humanActivityWindowDays: 14,
        },
      );

      if (pendingEval.shouldMarkPending && this.options.pendingClosureEnabled) {
        if (this.options.writesEnabled !== true || this.options.dryRun) {
          await this.finishWriteGateBlocked(issue, execution, true);
          return;
        }

        const graceDays = this.options.pendingClosureGraceDays ?? 7;
        const scheduledCloseAt = new Date();
        scheduledCloseAt.setDate(scheduledCloseAt.getDate() + graceDays);

        const labelsResult = await this.mutateGithub("github.addLabels", (g) =>
          g.addLabels(
            issue.repoOwner,
            issue.repoName,
            issue.githubNumber,
            [this.options.pendingClosureLabel ?? "lexi:pending-closure"],
          ),
        );
        if (!labelsResult.executed) {
          await this.finishWriteGateBlocked(issue, execution, true);
          return;
        }

        const commentResult = await this.mutateGithub("github.addComment", (g) =>
          g.addComment(
            issue.repoOwner,
            issue.repoName,
            issue.githubNumber,
            [
              "## Pending closure",
              "",
              `Scheduled closure: ${scheduledCloseAt.toISOString().slice(0, 10)}`,
              `Reason: ${pendingEval.reason}`,
              "",
              "Comment, react, or add `keep-open` / `lexi:hold` to cancel.",
            ].join("\n"),
          ),
        );
        if (!commentResult.executed) {
          await this.finishWriteGateBlocked(issue, execution, true);
          return;
        }

        if (this.options.onSchedulePendingClosure) {
          await this.options.onSchedulePendingClosure({
            issueId: issue.id,
            githubNumber: issue.githubNumber,
            repository: `${issue.repoOwner}/${issue.repoName}`,
            scheduledCloseAt,
            gracePeriodDays: graceDays,
            evidenceSummary: {
              ...(enrichedDetails ?? {}),
              issueId: issue.id,
              labelsSnapshot: issue.labels,
              assigneesSnapshot: [],
            },
          });
        }

        await this.repository.updateIssue(issue.id, { currentStatus: WorkflowStatus.SLACK_NOTIFIED });
      } else {
        const closeResult = await this.mutateGithub("github.closeIssue", (g) =>
          g.closeIssue(issue.repoOwner, issue.repoName, issue.githubNumber, "not_planned"),
        );
        if (!closeResult.executed) {
          await this.finishWriteGateBlocked(issue, execution, true);
          return;
        }
        this.metrics.incGithubUpdate("close_issue");
        execution = await this.transitionExecution(issue, execution, WorkflowStatus.CLOSED);
        await this.repository.updateIssue(issue.id, { currentStatus: WorkflowStatus.CLOSED, state: "closed" });
      }
    } else if (AUTO_CLOSE_CLASSIFICATIONS.has(decision.classification) && !autoCloseEval.allowed) {
      this.logger.warn(
        `Auto-close blocked for issue #${issue.githubNumber} (${decision.classification}): ${autoCloseEval.reason}`,
        "WorkflowOrchestrator",
      );
      await this.repository.updateIssue(issue.id, { currentStatus: WorkflowStatus.SLACK_NOTIFIED });
    } else {
      await this.repository.updateIssue(issue.id, { currentStatus: WorkflowStatus.SLACK_NOTIFIED });
    }

    this.metrics.incIssuesProcessed(decision.classification.toLowerCase());

    const issueAfter = await this.repository.getIssueById(issue.id);
    const closed = issueAfter?.state === "closed";
    await this.emitStage(issue, closed ? "ACTION_EXECUTED" : "COMPLETED", decision.classification, {
      classification: decision.classification,
      confidence: decision.confidence,
      executionSummary: decision.summary,
      closeRecommended: issueAfter?.currentStatus === WorkflowStatus.CLOSE_RECOMMENDED,
      writeBlocked: issueAfter?.currentStatus === WorkflowStatus.WRITE_BLOCKED,
    });
  }

  async retest(issueId: string): Promise<WorkflowExecutionRecord> {
    const issue = await this.requireIssue(issueId);
    let execution = await this.repository.findActiveWorkflowExecution(issue.id);
    if (!execution) {
      execution = await this.repository.createWorkflowExecution(issue.id, `retest-${issue.id}-${randomUUID()}`);
    }

    execution = await this.transitionExecution(issue, execution, WorkflowStatus.RETEST);

    const request: ReproductionRequest = {
      issueId: issue.id,
      issueNumber: issue.githubNumber,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      labels: issue.labels,
    };
    const submission = await this.reproduction.submitIssue(request);
    await this.repository.createReproductionAttempt({
      issueId: issue.id,
      workflowExecutionId: execution.id,
      providerName: this.reproduction.providerName ?? "unknown-reproduction-adapter",
      externalId: submission.externalId,
      status: submission.status,
    });

    // Deliberately stays in RETEST (rather than moving on to WAITING) while
    // the reproduction attempt is outstanding, so pollReproduction can tell
    // a retest cycle apart from a first-time processing cycle and route the
    // result through the deterministic finalizeRetest path.
    return execution;
  }

  /**
   * Retest confirmation is deterministic: it relies on the reproduction
   * bot's binary "reproduced" outcome directly, without another AI call,
   * since confirming a fix is a yes/no signal rather than something that
   * benefits from open-ended reasoning.
   */
  private async finalizeRetest(
    issue: IssueRecord,
    execution: WorkflowExecutionRecord,
    reproductionAttempt: ReproductionAttemptRecord,
  ): Promise<void> {
    const reproduced = Boolean(reproductionAttempt.resultDetails && reproductionAttempt.status === "COMPLETED"
      ? (reproductionAttempt.resultDetails as { reproduced?: boolean }).reproduced
      : reproductionAttempt.status !== "COMPLETED");

    if (!reproduced) {
      const commentResult = await this.mutateGithub("github.addComment", (g) =>
        g.addComment(
          issue.repoOwner,
          issue.repoName,
          issue.githubNumber,
          "Retest confirms the fix: the reproduction bot could no longer trigger the reported behavior. Closing this issue.",
        ),
      );
      if (!commentResult.executed) {
        await this.finishWriteGateBlocked(issue, execution, true);
        return;
      }
      const closeResult = await this.mutateGithub("github.closeIssue", (g) =>
        g.closeIssue(issue.repoOwner, issue.repoName, issue.githubNumber, "completed"),
      );
      if (!closeResult.executed) {
        await this.finishWriteGateBlocked(issue, execution, true);
        return;
      }
      this.metrics.incGithubUpdate("close_issue");
      await this.repository.updateIssue(issue.id, { currentStatus: WorkflowStatus.CLOSED, state: "closed" });
      await this.transitionExecution(issue, execution, WorkflowStatus.CLOSED);
    } else {
      const commentResult = await this.mutateGithub("github.addComment", (g) =>
        g.addComment(
          issue.repoOwner,
          issue.repoName,
          issue.githubNumber,
          "Retest failed: the reproduction bot could still trigger the reported behavior. Reopening for further investigation.",
        ),
      );
      if (!commentResult.executed) {
        await this.finishWriteGateBlocked(issue, execution, false);
        return;
      }
      if (issue.state === "closed") {
        const reopenResult = await this.mutateGithub("github.reopenIssue", (g) =>
          g.reopenIssue(issue.repoOwner, issue.repoName, issue.githubNumber),
        );
        if (!reopenResult.executed) {
          await this.finishWriteGateBlocked(issue, execution, false);
          return;
        }
      }
      // Consults the same (module, platform) resolution as the rest of the
      // cycle. The legacy expression it replaces looked a component up by the
      // LOWERCASED TEAM NAME ("Web" -> "web"), which only ever resolved
      // because the two namespaces happened to collide; it is kept verbatim
      // as the fallback so one-dimensional behaviour is byte-identical.
      const retestRouting = await this.resolveRouting(issue);
      await this.sendNotification(
        issue,
        "ESCALATION",
        NotificationTemplate.ESCALATION,
        null,
        retestRouting.twoDimensional
          ? retestRouting.channel
          : this.ownership.getComponentConfig(issue.assignedTeam ? issue.assignedTeam.toLowerCase() : "unassigned").channel,
        undefined,
        issue.assignedTeam ?? undefined,
        issue.assignedOwner ?? undefined,
        "Retest indicates the bug is still present after the fix was merged.",
      );
      await this.repository.updateIssue(issue.id, { currentStatus: WorkflowStatus.SLACK_NOTIFIED, state: "open" });
      await this.transitionExecution(issue, execution, WorkflowStatus.SLACK_NOTIFIED);
    }
  }

  // ---------------------------------------------------------------------
  // /reassign - deterministic manual override of team/owner
  // ---------------------------------------------------------------------

  async reassign(issueId: string, team?: string, owner?: string): Promise<IssueRecord> {
    const issue = await this.requireIssue(issueId);
    // One resolution for both the owner/team defaults and the announcement
    // channel below, instead of the two independent derivations this had.
    const routing = await this.resolveRouting(issue);
    const twoDimensional = routing.twoDimensional ? routing : undefined;
    const resolvedOwner = owner ?? twoDimensional?.owner ?? this.ownership.nextOwner(team ?? "unassigned");
    const resolvedTeam = team ?? twoDimensional?.team ?? issue.assignedTeam ?? "Triage";

    if (resolvedOwner) {
      const assignResult = await this.mutateGithub("github.assignUsers", (g) =>
        g.assignUsers(issue.repoOwner, issue.repoName, issue.githubNumber, [resolvedOwner]),
      );
      if (!assignResult.executed) {
        throw new Error(`Write gate blocked reassignment: ${assignResult.reason ?? "writes disabled"}`);
      }
      this.metrics.incGithubUpdate("assign_users");
    }

    await this.repository.createAuditLog({
      issueId: issue.id,
      actor: "orchestrator",
      action: "reassign",
      details: { team: resolvedTeam, owner: resolvedOwner ?? null },
    });

    const updated = await this.repository.updateIssue(issue.id, {
      assignedTeam: resolvedTeam,
      assignedOwner: resolvedOwner ?? null,
    });

    const channel = routing.channel;
    await this.slack.sendMessage({
      channel,
      text: `Issue ${issue.repoOwner}/${issue.repoName}#${issue.githubNumber} has been reassigned to ${resolvedOwner ?? "unassigned"} (${resolvedTeam}).`,
    });

    return updated;
  }

  /**
   * Governed hold signal — cancels scheduled pending closure (if any) and applies
   * hold labels through the write gate. Invoked from Slack or API, not ad hoc adapters.
   */
  async requestKeepOpen(issueId: string, actor: string): Promise<{ executed: boolean; message: string }> {
    const issue = await this.requireIssue(issueId);

    if (this.options.onCancelPendingClosure) {
      await this.options.onCancelPendingClosure({ issueId: issue.id, actor, reason: "keep_open" });
    }

    const holdLabels = ["keep-open", "lexi:hold"];
    const labelsResult = await this.mutateGithub("github.addLabels", (g) =>
      g.addLabels(issue.repoOwner, issue.repoName, issue.githubNumber, holdLabels),
    );

    await this.repository.createAuditLog({
      issueId: issue.id,
      actor,
      action: "keep_open",
      details: {
        labels: holdLabels,
        executed: labelsResult.executed,
        reason: labelsResult.reason ?? null,
      },
    });

    if (!labelsResult.executed) {
      return {
        executed: false,
        message:
          "Hold recorded in the audit log. GitHub labels were not applied because writes are disabled.",
      };
    }

    this.metrics.incGithubUpdate("add_labels");
    await this.repository.updateIssue(issue.id, {
      labels: [...new Set([...issue.labels, ...holdLabels])],
    });
    return { executed: true, message: `Applied hold labels on #${issue.githubNumber}.` };
  }

  // ---------------------------------------------------------------------
  // /cleanup - backlog cleanup: discover + kick off processing for all NEW
  // ---------------------------------------------------------------------

  /**
   * Sweep the backlog, processing every issue still sitting at NEW.
   *
   * `budget` is optional and, when supplied, is the only thing bounding this
   * loop. Without it the loop is unbounded: a single run-budget token consumed
   * for the whole sweep would let it dispatch as many reproductions, Slack
   * messages and issue edits as there are NEW issues.
   *
   * Accounting is deliberately limited to what is observable at this level.
   * `issuesModified` is consumed per issue actually processed, and
   * `slackMessages` when the execution came to rest at SLACK_NOTIFIED.
   * Anything dispatched several layers down stays bounded only transitively,
   * by issuesModified.
   */
  async cleanupBacklog(
    owner: string,
    repo: string,
    label: string,
    budget?: BacklogSweepBudget,
  ): Promise<{ discovered: number; processed: number; stoppedEarly: boolean; stopReason?: string }> {
    const discovered = await this.discoverIssues(owner, repo, label);
    let processed = 0;
    let stoppedEarly = false;
    let stopReason: string | undefined;

    for (const issue of discovered) {
      if (issue.currentStatus !== WorkflowStatus.NEW) {
        continue;
      }

      // Checked BEFORE the work, so the ceiling is a ceiling rather than a
      // post-hoc note in the digest.
      if (budget) {
        const check = budget.checkBudget("issuesModified");
        if (!check.allowed) {
          stoppedEarly = true;
          stopReason = check.reason ?? "issuesModified budget exhausted";
          budget.recordOutcome?.({
            issueNumber: issue.githubNumber,
            action: "backlog_sweep_item",
            result: "skipped_budget",
            reason: stopReason,
          });
          this.logger.warn(
            `Backlog sweep stopped early after ${processed} issue(s): ${stopReason}`,
            "WorkflowOrchestrator",
          );
          break;
        }
      }

      const execution = await this.processIssue(issue.id);
      processed += 1;

      if (budget) {
        budget.consume("issuesModified");
        if (execution?.status === WorkflowStatus.SLACK_NOTIFIED) {
          budget.consume("slackMessages");
        }
      }
    }

    return { discovered: discovered.length, processed, stoppedEarly, stopReason };
  }

  // ---------------------------------------------------------------------
  // Retry queue - poll every in-flight reproduction attempt
  // ---------------------------------------------------------------------

  async pollAllActiveReproductions(): Promise<number> {
    const attempts = await this.repository.listActiveReproductionAttempts();
    let failed = 0;
    for (const attempt of attempts) {
      // Isolate each attempt. Without this, a single unpollable row -- e.g. an
      // attempt whose provider lost its in-memory session across a pod roll, so
      // getStatus throws -- aborted the entire sweep, silently freezing every
      // other in-flight issue for as long as the bad row stayed PENDING/RUNNING.
      // One poisoned attempt must not be able to stop the retry queue.
      try {
        await this.pollReproduction(attempt);
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : "unknown error";
        this.logger.error(
          `Retry queue: polling attempt ${attempt.externalId} (issue ${attempt.issueId}) failed: ${message} — ` +
            `continuing with the remaining attempts`,
          "WorkflowOrchestrator",
        );
      }
    }
    if (failed > 0) {
      this.logger.warn(
        `Retry queue: ${failed}/${attempts.length} attempt(s) could not be polled this cycle`,
        "WorkflowOrchestrator",
      );
    }
    return attempts.length;
  }

  // ---------------------------------------------------------------------
  // Daily automation / progress tracker
  // ---------------------------------------------------------------------

  async runProgressCheck(issueId: string): Promise<void> {
    const issue = await this.requireIssue(issueId);
    if (this.stateMachine.isTerminal(issue.currentStatus)) {
      return;
    }

    const githubIssue = await this.github.getIssue(issue.repoOwner, issue.repoName, issue.githubNumber);
    if (githubIssue.state === "closed" && issue.currentStatus !== WorkflowStatus.CLOSED) {
      await this.repository.updateIssue(issue.id, { currentStatus: WorkflowStatus.CLOSED, state: "closed" });
      return;
    }

    const trackedStatuses: WorkflowStatus[] = [
      WorkflowStatus.SLACK_NOTIFIED,
      WorkflowStatus.IN_PROGRESS,
      WorkflowStatus.PR_CREATED,
      WorkflowStatus.MERGED,
    ];
    if (!trackedStatuses.includes(issue.currentStatus)) {
      return;
    }

    const linkedPrs = await this.github.listLinkedPullRequests(issue.repoOwner, issue.repoName, issue.githubNumber);
    const hasOpenOrMergedPr = linkedPrs.length > 0;
    // Multi-PR progress detection. This was `linkedPrs.some(pr => pr.merged)`,
    // which declared delivery on the FIRST merged PR — so a fix split across
    // three PRs was marked MERGED and retested after one of them landed, and
    // the retest then failed against a half-shipped fix. `isDeliveryComplete`
    // requires every still-OPEN linked PR to be merged; a PR closed WITHOUT
    // merging is excluded, so an abandoned PR cannot strand the issue forever.
    const deliveryComplete = isDeliveryComplete({ linkedPrs });

    if (deliveryComplete && issue.currentStatus !== WorkflowStatus.MERGED) {
      await this.repository.updateIssue(issue.id, { currentStatus: WorkflowStatus.MERGED });
      // Feature-vs-bug verification. Only a bug has a defect to
      // re-attempt; a feature/chore/spec is verified by a deployment record
      // (feature-policy.yaml: verification.featureVerifiedBy). The mode
      // is chosen from the work kind BEFORE any retest evidence is read, which
      // is what makes the wrong path unreachable rather than merely discouraged.
      //
      // Kind is derived from labels and defaults to "bug", so every genuine
      // bug report behaves exactly as it did before. Only an issue
      // explicitly labelled `type:feature`/`type:chore`/`type:spec` takes the
      // new branch — which is the case that used to silently retest a feature.
      const kind = verifiableKindFromLabels(issue.labels);
      if (verificationModeFor(kind) === "retest") {
        await this.retest(issue.id);
      } else {
        this.logger.log(
          `Issue ${issue.githubNumber} is a ${kind}; skipping bug retest — verification requires a deployment record.`,
          "WorkflowOrchestrator",
        );
      }
      return;
    }

    if (hasOpenOrMergedPr && issue.currentStatus === WorkflowStatus.SLACK_NOTIFIED) {
      await this.repository.updateIssue(issue.id, { currentStatus: WorkflowStatus.IN_PROGRESS });
      return;
    }

    const age = daysSince(issue.updatedAt);
    const channel = (await this.resolveRouting(issue)).channel;

    if (age >= this.options.escalationThresholdDays) {
      await this.sendNotification(
        issue,
        "ESCALATION",
        NotificationTemplate.ESCALATION,
        null,
        channel,
        undefined,
        issue.assignedTeam ?? undefined,
        issue.assignedOwner ?? undefined,
        undefined,
        age,
      );
    } else if (age >= this.options.reminderThresholdDays) {
      await this.sendNotification(
        issue,
        "REMINDER",
        NotificationTemplate.REMINDER,
        null,
        channel,
        undefined,
        issue.assignedTeam ?? undefined,
        issue.assignedOwner ?? undefined,
        undefined,
        age,
      );
    }
  }

  async runDailyAutomation(owner: string, repo: string, label: string): Promise<void> {
    await this.discoverIssues(owner, repo, label);
    const issues = await this.repository.listIssues({ state: "open" });
    for (const issue of issues) {
      if (issue.currentStatus === WorkflowStatus.NEW) {
        await this.processIssue(issue.id);
      } else {
        await this.runProgressCheck(issue.id);
      }
    }
    await this.pollAllActiveReproductions();
  }

  // ---------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------

  /**
   * Persists any evidence (screenshots/logs) a reproduction adapter attached
   * to its terminal result -- e.g. files an operator downloaded from the
   * Slack Reproduction Bot's thread reply -- as `Evidence` rows. Purely
   * deterministic persistence, not an AI call: `details.evidence` is just
   * read off the already-computed ReproductionResult.
   */
  private async persistEvidence(issueId: string, details: Record<string, unknown> | undefined): Promise<void> {
    const evidence = details?.evidence;
    if (!Array.isArray(evidence)) {
      return;
    }
    for (const item of evidence as Array<{ type?: unknown; url?: unknown; description?: unknown }>) {
      if (typeof item?.type !== "string") {
        continue;
      }
      await this.repository.createEvidence({
        issueId,
        type: item.type,
        url: typeof item.url === "string" ? item.url : undefined,
        description: typeof item.description === "string" ? item.description : undefined,
      });
    }
  }

  private async requireIssue(issueId: string): Promise<IssueRecord> {
    const issue = await this.repository.getIssueById(issueId);
    if (!issue) {
      throw new Error(`Issue not found: ${issueId}`);
    }
    return issue;
  }

  private async transitionExecution(
    issue: IssueRecord,
    execution: WorkflowExecutionRecord,
    to: WorkflowStatus,
  ): Promise<WorkflowExecutionRecord> {
    if (execution.status === to) {
      return execution;
    }
    this.stateMachine.assertTransition(execution.status, to);
    const updated = await this.repository.updateWorkflowExecution(execution.id, {
      status: to,
      completedAt: this.stateMachine.isTerminal(to) ? new Date() : null,
    });
    await this.repository.recordIssueState(issue.id, to);
    return updated;
  }

  private async buildVerificationComment(
    issue: IssueRecord,
    decision: Decision,
    team: string,
    owner: string | undefined,
    reproductionAttempt: ReproductionAttemptRecord,
    policyOutcome?: import("./verification-policy").VerificationAutoCloseEvaluation,
  ): Promise<string> {
    const outcome =
      policyOutcome ??
      (() => {
        const verificationResult = mapReproductionResultToVerification(
          issue,
          reproductionAttempt.resultDetails as any,
          (reproductionAttempt.resultDetails as any)?.reproduced ?? null,
          reproductionAttempt.externalId,
          reproductionAttempt.logsUrl,
        );
        const effectiveConfidence = Math.min(verificationResult.confidence, decision.confidence);
        const gatedResult = { ...verificationResult, confidence: effectiveConfidence };
        return evaluateVerificationAutoClose(gatedResult, {
          minConfidence: this.options.autoCloseMinConfidence ?? 0.85,
          minScenarioFit: this.options.autoCloseMinScenarioFit ?? 0.75,
        });
      })();
    const evidence = await this.repository.listEvidenceForIssue(issue.id);
    const report = buildVerificationReport(
      issue,
      decision,
      team,
      owner,
      outcome,
      reproductionAttempt,
      evidence,
    );
    return buildVerificationReportComment(report);
  }

  private async sendNotification(
    issue: IssueRecord,
    templateName: NotificationTemplateName,
    notificationTemplate: NotificationTemplate,
    decisionId: string | null,
    channel: string,
    decision?: Decision,
    team?: string,
    owner?: string,
    reason?: string,
    daysSinceLastUpdate?: number,
  ): Promise<void> {
    const context: NotificationContext = {
      issue: {
        number: issue.githubNumber,
        title: issue.title,
        url: issue.url,
        repoOwner: issue.repoOwner,
        repoName: issue.repoName,
      },
      decision: decision
        ? {
            classification: decision.classification,
            summary: decision.summary,
            reasoning: decision.reasoning,
            nextAction: decision.nextAction,
            confidence: decision.confidence,
          }
        : undefined,
      team,
      owner,
      reason,
      daysSinceLastUpdate,
    };

    const rendered = renderNotification(templateName, context);
    const result = await this.slack.sendMessage({ channel, text: rendered.text, blocks: rendered.blocks });
    this.metrics.incSlackNotification(templateName);

    await this.repository.createNotification({
      issueId: issue.id,
      decisionId,
      template: notificationTemplate,
      channel,
      messageTs: result.ts ?? null,
      success: result.ok,
      error: result.error ?? null,
    });
  }

  private async mutateGithub<T>(
    action: string,
    operation: (provider: GitHubProvider) => Promise<T>,
  ): Promise<MutationResult<T>> {
    // Use the gateway's runWrite if available (GitHubMutationGateway or GuardedMutationGateway)
    if ("runWrite" in this.github && typeof (this.github as any).runWrite === "function") {
      return (this.github as any).runWrite(action, operation);
    }
    if (this.options.writesEnabled !== true || this.options.dryRun) {
      return {
        executed: false,
        wouldExecute: true,
        action,
        reason: this.options.dryRun ? "dry run is enabled" : "writes are disabled",
      };
    }
    const result = await operation(this.github);
    return { executed: true, wouldExecute: false, action, result };
  }

  private async finishWriteGateBlocked(
    issue: IssueRecord,
    execution: WorkflowExecutionRecord,
    closeRecommended: boolean,
  ): Promise<WorkflowExecutionRecord> {
    const status = closeRecommended ? WorkflowStatus.CLOSE_RECOMMENDED : WorkflowStatus.WRITE_BLOCKED;
    const updated = await this.transitionExecution(issue, execution, status);
    await this.repository.updateIssue(issue.id, { currentStatus: status });
    this.logger.warn(
      `Issue #${issue.githubNumber} write gate blocked — workflow ${status}, GitHub state unchanged`,
      "WorkflowOrchestrator",
    );
    await this.emitStage(issue, "ACTION_BLOCKED", status, {
      closeRecommended,
      writeBlocked: true,
    });
    return updated;
  }

  private async emitStage(
    issue: IssueRecord,
    stage: string,
    detail?: string,
    extra?: Partial<WorkflowStageNotification>,
  ): Promise<void> {
    if (!this.options.onWorkflowStage) {
      return;
    }
    try {
      await this.options.onWorkflowStage({
        issueId: issue.id,
        githubNumber: issue.githubNumber,
        stage,
        detail,
        writesEnabled: this.options.writesEnabled,
        ...extra,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      this.logger.warn(`onWorkflowStage failed: ${message}`, "WorkflowOrchestrator");
    }
  }
}

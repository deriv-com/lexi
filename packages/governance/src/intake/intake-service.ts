import { randomUUID } from "node:crypto";
import type { GitHubProvider } from "@lexi/github";
import type { PrismaService } from "@lexi/database";
import type { PinoLoggerService } from "@lexi/logger";
import type { OwnershipResolver } from "@lexi/ownership";
import {
  bugSubmissionSchema,
  type BugSubmission,
  type IntakeResponse,
} from "./bug-submission.schema";
import { validateCompleteness } from "./completeness-validator";
import {
  evaluateValidityPolicy,
  type ValidityRecommendation,
} from "./validity-policy";
import type { DuplicateEngine } from "../duplicate/duplicate-engine";
import type {
  ClosedIssueResolution,
  ClosedIssueResolver,
} from "../duplicate/closed-issue-resolver";
import type { GovernanceConfig } from "../config/governance-config.schema";
import { evaluateSeverityPriority } from "../severity/severity-priority-policy";
import { normalizeIssueBody } from "./issue-body-normalizer";

export interface IntakeServiceOptions {
  writesEnabled: boolean;
  dryRun: boolean;
  canonicalOwner: string;
  canonicalRepo: string;
}

export class IntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubProvider,
    private readonly ownership: OwnershipResolver,
    private readonly duplicateEngine: DuplicateEngine,
    private readonly config: GovernanceConfig,
    private readonly options: IntakeServiceOptions,
    private readonly logger: PinoLoggerService,
    /**
     * Appended last so existing positional call sites stay valid. Absent means
     * closed-issue semantics are simply not evaluated.
     */
    private readonly closedIssueResolver?: ClosedIssueResolver,
  ) {}

  async submit(raw: unknown): Promise<IntakeResponse> {
    const parsed = bugSubmissionSchema.safeParse(raw);
    if (!parsed.success) {
      const requestId = randomUUID();
      const missingFields = parsed.error.issues.map((issue) => issue.path.join(".") || "payload");
      const response: IntakeResponse = {
        verdict: "NEEDS_INFO",
        reasonCode: "INVALID_PAYLOAD",
        explanation: `Invalid submission: ${missingFields.join(", ")}`,
        missingFields,
        similarIssues: [],
        requestId,
      };
      await this.prisma.intakeSubmission.create({
        data: { requestId, sourceType: "api", payload: (raw ?? {}) as object, status: "NEEDS_INFO" },
      });
      await this.recordDecision(requestId, "NEEDS_INFO", response);
      return response;
    }
    const submission = parsed.data;
    const requestId = randomUUID();

    await this.prisma.intakeSubmission.create({
      data: {
        requestId,
        sourceType: submission.source.type,
        payload: submission as object,
        status: "processing",
      },
    });

    const completeness = validateCompleteness(submission);
    if (!completeness.complete) {
      const response: IntakeResponse = {
        verdict: "NEEDS_INFO",
        reasonCode: "INCOMPLETE_SUBMISSION",
        explanation: `Missing required fields: ${completeness.missingFields.join(", ")}`,
        missingFields: completeness.missingFields,
        similarIssues: [],
        requestId,
      };
      await this.recordDecision(requestId, "NEEDS_INFO", response);
      return response;
    }

    const validityRecommendation = await this.classifyValidity(submission);
    const validityDecision = evaluateValidityPolicy(
      validityRecommendation,
      submission.labels ?? [],
      this.config.intakePolicy,
    );

    await this.prisma.policyEvaluation.create({
      data: {
        policyId: "intake-rejection",
        policyVersion: this.config.intakePolicy.version,
        inputs: { recommendation: validityRecommendation as object, labels: submission.labels },
        outcome: validityDecision.accept ? "accept" : "reject",
        reasons: [validityDecision.explanation],
      },
    });

    if (!validityDecision.accept) {
      const response: IntakeResponse = {
        verdict: "INVALID",
        reasonCode: validityDecision.reasonCode,
        explanation: validityDecision.explanation,
        missingFields: [],
        similarIssues: [],
        requestId,
      };
      await this.recordDecision(requestId, "INVALID", response);
      return response;
    }

    const candidates = await this.listCandidateIssues();
    const duplicateOutcome = await this.duplicateEngine.evaluate(
      submission.title,
      submission.stepsToReproduce,
      submission.actualBehaviour,
      candidates,
    );

    const isSecurityLabel = (submission.labels ?? []).some((label) =>
      this.config.intakePolicy.securityLabels.some(
        (sl) => label.toLowerCase() === sl.toLowerCase(),
      ),
    );
    const effectiveDuplicateOutcome =
      isSecurityLabel && duplicateOutcome.action === "REJECT_DUPLICATE"
        ? {
            ...duplicateOutcome,
            action: "CREATE_WITH_REVIEW" as const,
            reasonCode: "SECURITY_BYPASS_DEDUP",
            explanation: "Security-labelled intake bypasses automated duplicate rejection.",
          }
        : duplicateOutcome;

    if (effectiveDuplicateOutcome.action === "REJECT_DUPLICATE" && effectiveDuplicateOutcome.canonicalIssueNumber) {
      const canonical = candidates.find((c) => c.number === effectiveDuplicateOutcome.canonicalIssueNumber);
      // A closed canonical issue is not a plain duplicate: it is either still
      // outstanding (closed unobserved), a regression (closed as fixed), or a
      // pointer to another issue. The verdict stays DUPLICATE; the resolution is
      // reported alongside it.
      let closedIssueResolution: ClosedIssueResolution | undefined;
      if (this.closedIssueResolver && canonical && canonical.state === "closed") {
        closedIssueResolution = await this.closedIssueResolver.resolve(canonical.number, {
          title: submission.title,
          url: submission.source.sourceIssueUrl,
          summary: submission.actualBehaviour,
        });
      }
      const response: IntakeResponse = {
        verdict: "DUPLICATE",
        canonicalIssue: canonical
          ? {
              repository: `${this.options.canonicalOwner}/${this.options.canonicalRepo}`,
              number: canonical.number,
              url: canonical.url,
              title: canonical.title,
              state: canonical.state,
            }
          : undefined,
        reasonCode: effectiveDuplicateOutcome.reasonCode,
        explanation: effectiveDuplicateOutcome.explanation,
        missingFields: [],
        similarIssues: effectiveDuplicateOutcome.decisions.map((d) => ({
          number: d.issueNumber,
          url: candidates.find((c) => c.number === d.issueNumber)?.url ?? "",
          similarity: d.similarity,
        })),
        closedIssueResolution,
        requestId,
      };
      await this.recordDecision(requestId, "DUPLICATE", response);
      return response;
    }

    if (!this.options.writesEnabled || this.options.dryRun) {
      const dryRunReason =
        validityDecision.reasonCode === "SECURITY_BYPASS_REJECTION"
          ? validityDecision.reasonCode
          : this.options.dryRun
            ? "DRY_RUN_ACCEPTED"
            : "WRITES_DISABLED";
      const response: IntakeResponse = {
        verdict: "ACCEPTED",
        reasonCode: dryRunReason,
        explanation: this.options.dryRun
          ? "Dry-run — canonical issue would be created."
          : "Writes disabled — canonical issue not created.",
        missingFields: [],
        similarIssues: effectiveDuplicateOutcome.decisions.map((d) => ({
          number: d.issueNumber,
          url: candidates.find((c) => c.number === d.issueNumber)?.url ?? "",
          similarity: d.similarity,
        })),
        requestId,
      };
      await this.recordDecision(requestId, "ACCEPTED", response);
      return response;
    }

    const severityInputs = this.extractSeverityInputs(submission);
    const severityDecision = evaluateSeverityPriority(severityInputs, this.config.severityPriority);

    const body = normalizeIssueBody(submission);
    const labels = [
      ...(submission.labels ?? []),
      `severity:${severityDecision.severity.toLowerCase()}`,
      `priority:${severityDecision.priority.toLowerCase()}`,
    ];
    if (validityDecision.applyReviewLabel) {
      labels.push(this.config.intakePolicy.reviewLabel);
    }
    if (effectiveDuplicateOutcome.action === "CREATE_WITH_REVIEW") {
      labels.push(this.config.duplicatePolicy.reviewDedupLabel);
    }

    const created = await this.github.createIssue(
      this.options.canonicalOwner,
      this.options.canonicalRepo,
      submission.title,
      body,
      labels,
    );

    const component = this.ownership.resolve(labels).component;
    const owner = this.ownership.nextOwner(component);

    if (owner) {
      await this.github.assignUsers(
        this.options.canonicalOwner,
        this.options.canonicalRepo,
        created.githubNumber,
        [owner],
      );
    }

    const response: IntakeResponse = {
      verdict: "ACCEPTED",
      canonicalIssue: {
        repository: `${this.options.canonicalOwner}/${this.options.canonicalRepo}`,
        number: created.githubNumber,
        url: created.url,
        title: created.title,
        state: created.state,
        assignee: owner,
        severity: severityDecision.severity,
        priority: severityDecision.priority,
      },
      reasonCode: "ACCEPTED",
      explanation: severityDecision.explanation,
      missingFields: [],
      similarIssues: effectiveDuplicateOutcome.decisions.map((d) => ({
        number: d.issueNumber,
        url: candidates.find((c) => c.number === d.issueNumber)?.url ?? "",
        similarity: d.similarity,
      })),
      requestId,
    };

    await this.recordDecision(requestId, "ACCEPTED", response, created.githubNumber);
    return response;
  }

  async getByRequestId(requestId: string): Promise<IntakeResponse | null> {
    const decision = await this.prisma.intakeDecision.findUnique({ where: { requestId } });
    if (!decision) return null;
    return decision.response as IntakeResponse;
  }

  private async recordDecision(
    requestId: string,
    verdict: string,
    response: IntakeResponse,
    canonicalNumber?: number,
  ): Promise<void> {
    await this.prisma.intakeDecision.create({
      data: {
        requestId,
        verdict,
        response: response as object,
        canonicalIssueNumber: canonicalNumber,
      },
    });
    await this.prisma.intakeSubmission.update({
      where: { requestId },
      data: { status: verdict },
    });
  }

  private async classifyValidity(submission: BugSubmission): Promise<ValidityRecommendation> {
    // Heuristic validity when no dedicated intake LLM is wired — prefer acceptance.
    const blob = `${submission.title} ${submission.actualBehaviour}`.toLowerCase();
    if (blob.includes("how do i") || blob.includes("how to")) {
      return {
        verdict: "SUPPORT_QUERY",
        confidence: 0.7,
        reasoning: "Submission reads like a support question.",
      };
    }
    if (blob.includes("feature request") || blob.includes("would be nice")) {
      return {
        verdict: "FEATURE_REQUEST",
        confidence: 0.75,
        reasoning: "Submission reads like a feature request.",
      };
    }
    return {
      verdict: "VALID_BUG",
      confidence: 0.9,
      reasoning: "Submission describes observable incorrect behaviour.",
      promptVersion: "heuristic-1.0.0",
    };
  }

  private extractSeverityInputs(submission: BugSubmission) {
    const blob = `${submission.title} ${submission.actualBehaviour}`.toLowerCase();
    return {
      tradingImpact: blob.includes("trade") || blob.includes("order"),
      moneyMovement: blob.includes("deposit") || blob.includes("withdraw"),
      authentication: blob.includes("login") || blob.includes("auth"),
      customerFacing: true,
      frequency: blob.includes("always") ? "frequent" as const : "occasional" as const,
    };
  }

  private async listCandidateIssues() {
    const issues = await this.github.listIssues({
      owner: this.options.canonicalOwner,
      repo: this.options.canonicalRepo,
      state: "all",
      perPage: 100,
    });
    return issues.map((issue) => ({
      number: issue.githubNumber,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      state: issue.state,
      url: issue.url,
      // Real GitHub state_reason. Previously hardcoded to "completed", which
      // would have classified every closed issue as a regression once the
      // closed-issue rules were wired.
      closedReason: issue.stateReason,
    }));
  }
}

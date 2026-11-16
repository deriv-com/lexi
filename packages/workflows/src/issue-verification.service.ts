import type { PolicyEngineOptions } from "./policy-engine";
import { evaluateAutoClose } from "./auto-close-policy";
import { enrichResultDetailsWithLifecycle } from "./lifecycle-coverage";
import { buildVerificationReport, VerificationReport } from "./verification-report";
import { WorkflowRepository } from "./workflow-repository.interface";
import type { IssueRecord } from "./types";
import type { VerificationResult } from "./verification-contract";
import { mapReproductionResultToVerification } from "./verification-adapters";
import { evaluateVerificationAutoClose, extractCapabilityGap, type CapabilityGap } from "./verification-policy";

export class IssueVerificationService {
  constructor(
    private readonly repository: WorkflowRepository,
    private readonly policyOptions: PolicyEngineOptions = {},
    private readonly onCapabilityGap?: (gap: CapabilityGap) => Promise<void>,
  ) {}

  /**
   * Produce the canonical VerificationResult from a reproduction attempt.
   * This is the PRIMARY path — downstream consumers should use this.
   */
  async getCanonicalVerificationResult(issueId: string): Promise<VerificationResult | null> {
    const issue = await this.repository.getIssueById(issueId);
    if (!issue) return null;

    const decision = await this.repository.getLatestDecisionForIssue(issueId);
    const reproductionAttempt = decision?.reproductionAttemptId
      ? await this.repository.getReproductionAttemptById(decision.reproductionAttemptId)
      : await this.repository.getLatestReproductionAttemptForIssue(issueId);

    const details = reproductionAttempt?.resultDetails as Record<string, unknown> | null;
    const reproduced = details?.reproduced as boolean | null ?? null;

    const result = mapReproductionResultToVerification(
      issue,
      details as any,
      reproduced,
      reproductionAttempt?.externalId,
      reproductionAttempt?.logsUrl,
    );

    // Record capability gap if UNSUPPORTED
    if (result.verdict === "UNSUPPORTED" && this.onCapabilityGap) {
      const gap = extractCapabilityGap(result, issue.githubNumber, `${issue.repoOwner}/${issue.repoName}`, issue.title, issue.labels);
      if (gap) {
        await this.onCapabilityGap(gap).catch(() => {}); // Non-blocking
      }
    }

    return result;
  }

  /**
   * Evaluate auto-close using the canonical contract.
   * This is the new PRIMARY auto-close path.
   */
  async evaluateCanonicalAutoClose(issueId: string): Promise<{ allowed: boolean; reason: string; result: VerificationResult | null }> {
    const result = await this.getCanonicalVerificationResult(issueId);
    if (!result) {
      return { allowed: false, reason: "No verification result available.", result: null };
    }

    const evaluation = evaluateVerificationAutoClose(result, {
      minConfidence: this.policyOptions.autoCloseMinConfidence ?? 0.85,
      minScenarioFit: this.policyOptions.autoCloseMinScenarioFit ?? 0.75,
    });

    return { ...evaluation, result };
  }

  /**
   * Legacy path — produces VerificationReport for backward compatibility.
   * @deprecated Use getCanonicalVerificationResult() for new code.
   */
  async getVerificationReport(issueId: string): Promise<VerificationReport | null> {
    const issue = await this.repository.getIssueById(issueId);
    if (!issue) {
      return null;
    }

    const decision = await this.repository.getLatestDecisionForIssue(issueId);
    if (!decision) {
      return null;
    }

    const reproductionAttempt = decision.reproductionAttemptId
      ? await this.repository.getReproductionAttemptById(decision.reproductionAttemptId)
      : await this.repository.getLatestReproductionAttemptForIssue(issueId);

    const evidence = await this.repository.listEvidenceForIssue(issueId);

    const enrichedDetails = enrichResultDetailsWithLifecycle(
      issue,
      reproductionAttempt?.resultDetails as Record<string, unknown> | null,
    );

    const policyOutcome = evaluateAutoClose(
      {
        classification: decision.classification,
        decisionConfidence: decision.confidence,
        resultDetails: enrichedDetails,
      },
      {
        minConfidence: this.policyOptions.autoCloseMinConfidence,
        minScenarioFit: this.policyOptions.autoCloseMinScenarioFit,
      },
    );

    return buildVerificationReport(
      issue,
      decision,
      decision.team,
      decision.owner,
      policyOutcome,
      reproductionAttempt,
      evidence,
    );
  }

  /** @deprecated Use evaluateCanonicalAutoClose() */
  async getVerificationReportForIssue(issue: IssueRecord): Promise<VerificationReport | null> {
    return this.getVerificationReport(issue.id);
  }
}

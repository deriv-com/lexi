import type {
  ReproductionProvider,
  ReproductionRequest,
  ReproductionResult,
  ReproductionStatus,
  ReproductionSubmission,
} from "@lexi/contracts";

/**
 * The reproduction adapter for a deployment that has none.
 *
 * Every submission completes immediately as NOT reproduced, with a summary that
 * says no reproduction ran. It never reports a bug as observed and never as
 * fixed: "nothing was checked" must stay distinguishable from "checked and not
 * seen", so the result carries `details.reproductionAttempted: false` and the
 * pending-closure policy should not count it as a qualifying attempt.
 */
export class NoopReproductionProvider implements ReproductionProvider {
  readonly providerName = "noop";
  private readonly submissions = new Map<string, { request: ReproductionRequest; submittedAt: string }>();
  private sequence = 0;

  async submitIssue(request: ReproductionRequest): Promise<ReproductionSubmission> {
    const externalId = `noop-${request.issueNumber}-${++this.sequence}`;
    this.submissions.set(externalId, { request, submittedAt: new Date().toISOString() });
    return { externalId, status: "COMPLETED" };
  }

  async getStatus(externalId: string): Promise<ReproductionStatus> {
    return this.submissions.has(externalId) ? "COMPLETED" : "FAILED";
  }

  async getResult(externalId: string): Promise<ReproductionResult | null> {
    const submission = this.submissions.get(externalId);
    if (!submission) return null;
    return {
      externalId,
      status: "COMPLETED",
      reproduced: false,
      summary: `No reproduction adapter is configured, so issue #${submission.request.issueNumber} was not reproduced.`,
      details: { reproductionAttempted: false, provider: this.providerName },
      logsUrl: null,
      submittedAt: submission.submittedAt,
      completedAt: submission.submittedAt,
    };
  }

  async cancel(externalId: string): Promise<void> {
    this.submissions.delete(externalId);
  }
}

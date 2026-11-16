/**
 * The reproduction port: how the orchestrator asks something outside it to
 * reproduce a reported bug, and how it reads the answer back.
 *
 * Only the interface lives here. Adapters (a browser-automation service, a chat
 * bot, a mock) implement it in their own packages, so swapping one for another
 * changes no calling code — only which class is registered against the port.
 */

export type ReproductionStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMEOUT" | "CANCELLED";

export interface ReproductionRequest {
  issueId: string;
  issueNumber: number;
  title: string;
  body: string | null;
  url: string;
  labels: string[];
  /** Repository owner, for adapters that cannot parse it from `url`. */
  repoOwner?: string;
  /** Repository name, for adapters that cannot parse it from `url`. */
  repoName?: string;
  /**
   * Optional message body for chat-based adapters. When set, the adapter posts
   * this verbatim instead of its default "please reproduce issue #N" line.
   */
  mentionText?: string;
}

export interface ReproductionSubmission {
  externalId: string;
  status: ReproductionStatus;
  /** Adapter-specific snapshot for poll recovery after a process restart. */
  persist?: Record<string, unknown>;
}

export interface ReproductionResult {
  externalId: string;
  status: ReproductionStatus;
  /** True only when the adapter observed the bug; never inferred from silence. */
  reproduced: boolean;
  summary: string;
  details: Record<string, unknown>;
  logsUrl: string | null;
  submittedAt: string;
  completedAt: string | null;
}

/**
 * One downloaded attachment, as stored under `ReproductionResult.details.evidence`
 * by adapters that collect files. `details` stays loosely typed because it is
 * adapter-specific and persisted as opaque JSON.
 */
export interface ReproductionEvidenceItem {
  type: string;
  url: string;
  description?: string;
}

export interface ReproductionProvider {
  /** Identifier of the adapter in use, persisted with each reproduction attempt. */
  readonly providerName?: string;
  submitIssue(request: ReproductionRequest): Promise<ReproductionSubmission>;
  getStatus(externalId: string): Promise<ReproductionStatus>;
  getResult(externalId: string): Promise<ReproductionResult | null>;
  cancel(externalId: string): Promise<void>;
  /** Rehydrate in-memory state before polling (for example after a restart). */
  preparePoll?(externalId: string, persist: Record<string, unknown> | null): Promise<void>;
  /** Current adapter state to persist onto the reproduction attempt. */
  getSessionPersist?(externalId: string): Record<string, unknown> | null;
  /** Teardown hook for adapters that own resources (queues, workers, connections). */
  close?(): Promise<void>;
}

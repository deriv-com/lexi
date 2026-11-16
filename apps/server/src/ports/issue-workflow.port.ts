/**
 * What the HTTP action endpoints need from the workflow engine.
 *
 * The server depends on this port, not on the engine, so the engine can be
 * replaced (or not deployed at all) without touching the HTTP surface.
 */

export interface IssueTarget {
  /** `owner/name`. Omit to use the deployment's default repository. */
  repository?: string;
  issueNumber: number;
}

/** Run the triage workflow for an issue. */
export interface ProcessIssuePort {
  process(request: IssueTarget): Promise<unknown>;
}

/** The full set of issue actions exposed over HTTP. */
export interface IssueWorkflowPort extends ProcessIssuePort {
  /** Run the workflow again from the start, discarding earlier results. */
  reprocess(request: IssueTarget): Promise<unknown>;
  /** Re-run verification for an issue that already has a result. */
  retest(request: IssueTarget): Promise<unknown>;
}

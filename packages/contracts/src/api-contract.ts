/**
 * API-contract snapshot contracts.
 *
 * The rebuild's backend surface is the Acme Core OpenAPI document
 * (acme-labs/e2e-tests, apidog/core_openapi.json). Build
 * agents must implement against ITS endpoints and never invent one, so the
 * orchestrator snapshots the document — FILTERED of archived/admin/internal
 * operations — into a versioned row the brief references by URL, exactly the
 * `DesignContextDocument` posture: durable, self-contained, served by the
 * programme controller because the runner has no access to the source repo.
 */

export interface ApiContractOperation {
  /** Uppercase HTTP method, e.g. "GET". */
  method: string;
  path: string;
  tags: string[];
  summary?: string;
  operationId?: string;
}

export interface ApiContractDocument {
  id: string;
  /** "organization/repository" the OpenAPI document was read from. */
  sourceRepoSlug: string;
  sourcePath: string;
  /** Git blob SHA of the source at capture time — the dedupe key. */
  sourceSha: string;
  /** Monotonic per source; a re-snapshot is a new version, never an edit. */
  version: number;
  capturedAt: string;
  info: { title: string; version: string };
  /** Operations that SURVIVED filtering — what a build agent may target. */
  operations: ApiContractOperation[];
  /** Operations removed by the exclude patterns, counted for the audit trail. */
  excludedOperationCount: number;
  /**
   * The filtered OpenAPI document itself. Everything matching an exclude
   * pattern is REMOVED, not marked: an endpoint a build agent must not call
   * is one it must not see.
   */
  spec: unknown;
}

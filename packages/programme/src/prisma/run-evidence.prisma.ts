import { createHash } from "node:crypto";
import type {
  FailingTestProof,
  RunCheckResult,
  RunEvidenceArtifact,
  RunEvidenceBundle,
  RunEvidencePhase,
  RunEvidenceReceipt,
} from "@lexi/contracts";
import type { ProgrammeEvidencePort, RunEvidenceListRow } from "../engine/ports";
import { isoString, prismaDelegate, type PrismaDelegateHost } from "./prisma-delegate";

const PHASES: readonly RunEvidencePhase[] = ["red", "green", "refactor", "checks"];
const CHECK_STATUSES = new Set(["passed", "failed", "skipped", "errored"]);
const ARTIFACT_TYPES = new Set(["screenshot", "video", "log", "report", "trace", "coverage"]);

/** Bounds on an untrusted bundle. Generous for a real runner, tight for abuse. */
export const RUN_EVIDENCE_LIMITS = {
  maxChecks: 200,
  maxFailingTests: 200,
  maxArtifacts: 200,
  maxTextChars: 8_000,
  maxIdChars: 200,
} as const;

/** Refusal reason when a bundle's repository is not the attempt's. */
export const REPOSITORY_MISMATCH = "repository does not match the attempt";

export type ParsedRunEvidence = { ok: true; bundle: RunEvidenceBundle } | { ok: false; reason: string };

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Validates an untrusted evidence bundle. Unknown top-level fields are
 * ignored; malformed known fields refuse the whole bundle rather than storing
 * half of it, so a runner bug is visible instead of silently thinning the
 * record. Free text is truncated, never refused.
 */
export function parseRunEvidenceBundle(input: unknown): ParsedRunEvidence {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "body must be a JSON object" };
  const raw = input as Record<string, unknown>;
  const attemptId = typeof raw.attemptId === "string" ? raw.attemptId.trim() : "";
  if (!attemptId || attemptId.length > RUN_EVIDENCE_LIMITS.maxIdChars) return { ok: false, reason: "attemptId is required" };
  if (typeof raw.phase !== "string" || !PHASES.includes(raw.phase as RunEvidencePhase)) {
    return { ok: false, reason: `phase must be one of ${PHASES.join(", ")}` };
  }
  const bundle: RunEvidenceBundle = { attemptId, phase: raw.phase as RunEvidencePhase };

  for (const key of ["workflowRunId", "commitSha", "reportedAt"] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string" || text.length > RUN_EVIDENCE_LIMITS.maxIdChars) return { ok: false, reason: `${key} must be a short string` };
    bundle[key] = text;
  }
  if (bundle.reportedAt !== undefined && Number.isNaN(Date.parse(bundle.reportedAt))) {
    return { ok: false, reason: "reportedAt must be an ISO 8601 timestamp" };
  }

  if (raw.checks !== undefined) {
    if (!Array.isArray(raw.checks) || raw.checks.length > RUN_EVIDENCE_LIMITS.maxChecks) return { ok: false, reason: "checks must be an array" };
    const checks: RunCheckResult[] = [];
    for (const item of raw.checks) {
      const check = item as Record<string, unknown> | null;
      const name = boundedString(check?.name, RUN_EVIDENCE_LIMITS.maxIdChars);
      if (!check || !name || typeof check.status !== "string" || !CHECK_STATUSES.has(check.status)) {
        return { ok: false, reason: "every check needs a name and a status of passed, failed, skipped or errored" };
      }
      const detail = boundedString(check.detail, RUN_EVIDENCE_LIMITS.maxTextChars);
      checks.push({
        name,
        status: check.status as RunCheckResult["status"],
        ...(detail !== undefined ? { detail } : {}),
        ...(typeof check.durationMs === "number" && Number.isFinite(check.durationMs) ? { durationMs: check.durationMs } : {}),
      });
    }
    bundle.checks = checks;
  }

  if (raw.failingTests !== undefined) {
    if (!Array.isArray(raw.failingTests) || raw.failingTests.length > RUN_EVIDENCE_LIMITS.maxFailingTests) {
      return { ok: false, reason: "failingTests must be an array" };
    }
    const tests: FailingTestProof[] = [];
    for (const item of raw.failingTests) {
      const test = item as Record<string, unknown> | null;
      const testName = boundedString(test?.testName, RUN_EVIDENCE_LIMITS.maxTextChars);
      const failureOutput = boundedString(test?.failureOutput, RUN_EVIDENCE_LIMITS.maxTextChars);
      if (!test || !testName || failureOutput === undefined) {
        return { ok: false, reason: "every failing test needs a testName and its failureOutput" };
      }
      const file = boundedString(test.file, RUN_EVIDENCE_LIMITS.maxTextChars);
      const criterion = boundedString(test.acceptanceCriterionId, RUN_EVIDENCE_LIMITS.maxIdChars);
      tests.push({
        testName,
        failureOutput,
        ...(file !== undefined ? { file } : {}),
        ...(criterion !== undefined ? { acceptanceCriterionId: criterion } : {}),
      });
    }
    bundle.failingTests = tests;
  }

  if (raw.artifacts !== undefined) {
    if (!Array.isArray(raw.artifacts) || raw.artifacts.length > RUN_EVIDENCE_LIMITS.maxArtifacts) {
      return { ok: false, reason: "artifacts must be an array" };
    }
    const artifacts: RunEvidenceArtifact[] = [];
    for (const item of raw.artifacts) {
      const artifact = item as Record<string, unknown> | null;
      const uri = boundedString(artifact?.uri, RUN_EVIDENCE_LIMITS.maxTextChars);
      if (!artifact || !uri || typeof artifact.type !== "string" || !ARTIFACT_TYPES.has(artifact.type)) {
        return { ok: false, reason: "every artifact needs a known type and a uri" };
      }
      const sha256 = boundedString(artifact.sha256, RUN_EVIDENCE_LIMITS.maxIdChars);
      const label = boundedString(artifact.label, RUN_EVIDENCE_LIMITS.maxIdChars);
      // Recorded, never dereferenced: fetching a runner-supplied URL from the
      // orchestrator would be a server-side request forgery.
      artifacts.push({
        type: artifact.type as RunEvidenceArtifact["type"],
        uri,
        ...(sha256 !== undefined ? { sha256 } : {}),
        ...(label !== undefined ? { label } : {}),
      });
    }
    bundle.artifacts = artifacts;
  }
  return { ok: true, bundle };
}

/**
 * Content key of a bundle: the same bundle POSTed and later read off the
 * run's artifact stores once. Built from the validated bundle, so field order
 * in the sender's JSON does not matter.
 */
export function runEvidenceBundleKey(bundle: RunEvidenceBundle): string {
  const canonical = JSON.stringify([
    bundle.attemptId,
    bundle.phase,
    bundle.workflowRunId ?? null,
    bundle.commitSha ?? null,
    bundle.reportedAt ?? null,
    bundle.checks ?? [],
    bundle.failingTests ?? [],
    bundle.artifacts ?? [],
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export interface RunEvidenceIngestOptions {
  /**
   * The attempt id is a correlation key, not authority: an unknown id is
   * refused so evidence cannot accumulate attached to nothing.
   */
  isKnownAttempt(attemptId: string): Promise<boolean>;
  /**
   * The repository (`owner/name`) the attempt was dispatched to, or null when
   * the attempt records none. When this is supplied and returns a value, the
   * bundle must name the same repository in a top-level `repository` field
   * (the runner's `GITHUB_REPOSITORY`), compared case-insensitively; a bundle
   * that names another repository, or none, is refused.
   *
   * This binds evidence to the attempt's repository, not to a runner: the
   * evidence token is shared by every runner that holds it, and `repository`
   * is the sender's own claim. It stops a runner in one repository from
   * writing evidence against an attempt dispatched to another by mistake or
   * by reusing a leaked attempt id; it does not stop a holder of the token
   * who writes the expected repository name.
   */
  repositoryOfAttempt?(attemptId: string): Promise<string | null>;
}

/** Repository names GitHub accepts: `owner/name`, no path, no whitespace. */
const REPOSITORY_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * The `repository` a bundle claims, when it carries a well-formed one. Read
 * from the raw body because it is a delivery check, not part of the stored
 * evidence (and not part of the content key, so a re-delivery still
 * de-duplicates against a bundle stored before the field existed).
 */
export function claimedEvidenceRepository(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).repository;
  if (typeof value !== "string") return undefined;
  const slug = value.trim();
  return REPOSITORY_SLUG.test(slug) ? slug : undefined;
}

/**
 * Evidence bundles over `RunEvidenceRecord`. Append-only and idempotent by
 * content (`bundleKey`). Implements the engine's read port.
 */
export class PrismaRunEvidenceStore implements ProgrammeEvidencePort {
  constructor(
    private readonly prisma: PrismaDelegateHost,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listByAttempt(attemptId: string): Promise<RunEvidenceListRow[]> {
    const rows = await prismaDelegate(this.prisma, "runEvidenceRecord").findMany({
      where: { attemptId },
      orderBy: { receivedAt: "asc" },
    });
    return rows.map((row) => ({
      id: String(row.id),
      attemptId: String(row.attemptId),
      phase: String(row.phase),
      workflowRunId: (row.workflowRunId as string | null) ?? null,
      commitSha: (row.commitSha as string | null) ?? null,
      checks: row.checks ?? [],
      failingTests: row.failingTests ?? [],
      artifacts: row.artifacts ?? [],
      reportedAt: row.reportedAt instanceof Date ? row.reportedAt : row.reportedAt ? new Date(isoString(row.reportedAt)) : null,
      receivedAt: row.receivedAt instanceof Date ? row.receivedAt : new Date(isoString(row.receivedAt)),
    }));
  }

  /** Validates, de-duplicates and stores one bundle. Never throws on bad input. */
  async ingest(input: unknown, options: RunEvidenceIngestOptions): Promise<RunEvidenceReceipt> {
    const parsed = parseRunEvidenceBundle(input);
    if (!parsed.ok) {
      const raw = (input ?? {}) as { attemptId?: unknown; phase?: unknown };
      return {
        accepted: false,
        attemptId: typeof raw.attemptId === "string" ? raw.attemptId : "",
        phase: (typeof raw.phase === "string" ? raw.phase : "checks") as RunEvidencePhase,
        reason: parsed.reason,
      };
    }
    const { bundle } = parsed;
    if (!(await options.isKnownAttempt(bundle.attemptId))) {
      return { accepted: false, attemptId: bundle.attemptId, phase: bundle.phase, reason: "unknown attempt" };
    }
    if (options.repositoryOfAttempt) {
      const expected = (await options.repositoryOfAttempt(bundle.attemptId))?.trim();
      if (expected) {
        const claimed = claimedEvidenceRepository(input);
        if (!claimed || claimed.toLowerCase() !== expected.toLowerCase()) {
          return { accepted: false, attemptId: bundle.attemptId, phase: bundle.phase, reason: REPOSITORY_MISMATCH };
        }
      }
    }
    const delegate = prismaDelegate(this.prisma, "runEvidenceRecord");
    const bundleKey = runEvidenceBundleKey(bundle);
    const existing = await delegate.findUnique({ where: { bundleKey } });
    if (existing) {
      return { accepted: true, attemptId: bundle.attemptId, phase: bundle.phase, evidenceId: String(existing.id), deduplicated: true };
    }
    let row: Record<string, unknown>;
    try {
      row = await delegate.create({
        data: {
          bundleKey,
          attemptId: bundle.attemptId,
          phase: bundle.phase,
          workflowRunId: bundle.workflowRunId ?? null,
          commitSha: bundle.commitSha ?? null,
          checks: bundle.checks ?? [],
          failingTests: bundle.failingTests ?? [],
          artifacts: bundle.artifacts ?? [],
          reportedAt: bundle.reportedAt ? new Date(bundle.reportedAt) : null,
          receivedAt: this.now(),
        },
      });
    } catch (error) {
      // Two arrivals of one bundle (the POST and the artifact fallback) can
      // race past the read above; the unique bundleKey decides, and the loser
      // is a duplicate, not a failure.
      const raced = await delegate.findUnique({ where: { bundleKey } });
      if (!raced) throw error;
      return { accepted: true, attemptId: bundle.attemptId, phase: bundle.phase, evidenceId: String(raced.id), deduplicated: true };
    }
    return { accepted: true, attemptId: bundle.attemptId, phase: bundle.phase, evidenceId: String(row.id) };
  }
}

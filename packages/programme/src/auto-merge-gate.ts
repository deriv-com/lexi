import type { AutoMergeVerdict, RunEvidenceBundle } from "@lexi/contracts";

/**
 * The pure auto-merge gate.
 *
 * This function is the ONLY place that decides whether a programme PR may
 * merge without a human, and it is deliberately pure: the caller
 * (the orchestrator build service, inside the advance scheduler job —
 * never a model tool) fetches evidence rows, bindings and PR state, and this
 * function turns them into a verdict. Every refusal is named in `reasons`;
 * an empty `reasons` with `allowed: false` is unrepresentable by
 * construction, because `allowed` is derived from `reasons.length === 0`.
 *
 * Fail-closed is the design, not a convention: absence of any required
 * input — no evidence, no red phase, a missing check, an unbound criterion,
 * an unknown head SHA — produces a refusal, never a pass.
 */

/**
 * One persisted evidence row, as the gate needs it. Structural rather than
 * the Prisma model so the gate stays testable with fixtures and the package
 * keeps its dependency on `@lexi/contracts` alone. `receivedAt` is the
 * STORE's clock (never the sender's `reportedAt`) — red-before-green ordered
 * by a timestamp the sender controls would be one the sender can forge.
 */
export interface EvidenceRow {
  phase: RunEvidenceBundle["phase"];
  checks?: RunEvidenceBundle["checks"];
  failingTests?: RunEvidenceBundle["failingTests"];
  commitSha?: string;
  receivedAt: Date;
}

export interface AutoMergeGateInput {
  evidence: EvidenceRow[];
  /**
   * The acceptance-criterion ids the task's brief carried. Every one must be
   * proven green by a check-phase bundle's AC statuses before merge.
   */
  acceptanceCriterionIds: string[];
  /**
   * Latest per-criterion status, as evaluated by `evaluateAcMatrix` over the
   * same evidence. Passed in rather than recomputed so the verdict the
   * caller persists and the matrix it posts to Slack can never disagree.
   */
  acStatuses: Array<{ criterionId: string; status: "red" | "green" | "missing" | "unbound" }>;
  policy: {
    requiredEvidencePhases: Array<RunEvidenceBundle["phase"]>;
    requiredChecks: string[];
    requireAcMatrixGreen: boolean;
    requireHeadShaMatch: boolean;
  };
  pr: {
    headSha: string;
    open: boolean;
    /** GitHub's own mergeability verdict, when known. */
    mergeable?: boolean;
  };
}

function latestCheckStatuses(evidence: EvidenceRow[]): Map<string, "passed" | "failed" | "missing"> {
  const statuses = new Map<string, "passed" | "failed" | "missing">();
  const ordered = [...evidence].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  for (const row of ordered) {
    for (const check of row.checks ?? []) {
      // "skipped"/"errored" are neither pass nor fail for the gate: a check
      // that did not run has not passed, so it reads as missing.
      if (check.status === "passed" || check.status === "failed") {
        statuses.set(check.name, check.status);
      }
    }
  }
  return statuses;
}

export function evaluateAutoMergeGate(input: AutoMergeGateInput): AutoMergeVerdict {
  const reasons: string[] = [];

  // 1. Required evidence phases, each present at least once.
  const phasesSeen = new Set(input.evidence.map((row) => row.phase));
  for (const phase of input.policy.requiredEvidencePhases) {
    if (!phasesSeen.has(phase)) {
      reasons.push(`missing required evidence phase: ${phase}`);
    }
  }

  // 2. Red before green, by the store's own receive order. A green with no
  //    earlier red means the failing test was never demonstrated — the only
  //    durable difference between TDD and a suite written after the fact.
  const firstRedAt = input.evidence
    .filter((row) => row.phase === "red")
    .reduce<Date | null>((min, row) => (min === null || row.receivedAt < min ? row.receivedAt : min), null);
  const firstGreenAt = input.evidence
    .filter((row) => row.phase === "green")
    .reduce<Date | null>((min, row) => (min === null || row.receivedAt < min ? row.receivedAt : min), null);
  const redBeforeGreen =
    firstRedAt !== null && firstGreenAt !== null && firstRedAt.getTime() < firstGreenAt.getTime();
  if (!redBeforeGreen) {
    reasons.push("no red evidence bundle received before the first green one");
  }

  // 3. Every policy-required check reported passed in a checks bundle.
  const checkStatuses = latestCheckStatuses(input.evidence);
  const requiredChecks = input.policy.requiredChecks.map((name) => {
    const status = checkStatuses.get(name) ?? "missing";
    if (status !== "passed") {
      reasons.push(`required check ${name}: ${status}`);
    }
    return { name, status };
  });

  // 4. AC matrix: every criterion the brief carried must be green.
  const acMatrix = input.acceptanceCriterionIds.map((criterionId) => {
    const entry = input.acStatuses.find((status) => status.criterionId === criterionId);
    return { criterionId, status: entry?.status ?? ("unbound" as const) };
  });
  if (input.policy.requireAcMatrixGreen) {
    for (const entry of acMatrix) {
      if (entry.status !== "green") {
        reasons.push(criterionReason(entry.criterionId, entry.status));
      }
    }
  }

  // 5. Head SHA: the evidence must describe the commit that would merge.
  //    Evidence rows without a commitSha cannot vouch for anything.
  if (input.policy.requireHeadShaMatch) {
    const vouched = input.evidence.some((row) => row.commitSha === input.pr.headSha);
    if (!vouched) {
      reasons.push(`no evidence bundle carries the PR head SHA ${input.pr.headSha}`);
    }
  }

  // 6. PR sanity — the caller re-checks this against live GitHub state too;
  //    this half makes a stale snapshot refuse rather than pass.
  if (!input.pr.open) {
    reasons.push("pull request is not open");
  }
  if (input.pr.mergeable === false) {
    reasons.push("GitHub reports the pull request as not mergeable");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    requiredChecks,
    acMatrix,
    redBeforeGreen,
  };
}

/**
 * The gate's per-criterion refusal reason, and its inverse. One place for the
 * wording, so a reader of persisted verdicts (the programme status line)
 * cannot drift from what the gate writes.
 */
export function criterionReason(criterionId: string, status: string): string {
  return `acceptance criterion ${criterionId}: ${status}`;
}

export function parseCriterionReason(reason: string): { criterionId: string; status: string } | null {
  const match = /^acceptance criterion (AC-[0-9a-f]+): (\w+)$/i.exec(reason);
  return match ? { criterionId: match[1]!, status: match[2]! } : null;
}

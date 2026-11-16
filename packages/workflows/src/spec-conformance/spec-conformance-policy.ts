/**
 * Deterministic policy for spec conformance.
 *
 * House rule: AI proposes, deterministic policy disposes. Model judgement is
 * appropriate for the comparison itself — "does this diff implement this
 * paragraph" is not expressible as a rule. Everything AROUND that judgement is
 * here, in pure code: what counts as drift, what survives into the report, and
 * how a set of points becomes one verdict.
 *
 * Every function in this file is pure. No IO, no clock, no model.
 */

import { createHash } from "node:crypto";

import type {
  BuiltArtefact,
  ConformancePoint,
  RawConformanceJudgement,
  SpecConformanceJudgeInput,
} from "./spec-conformance.types";

export type ConformanceVerdict = "conforms" | "drifted" | "indeterminate" | "unverifiable";

const STATUSES = ["extra", "missing", "diverged", "satisfied", "indeterminate"] as const;
type PointStatus = (typeof STATUSES)[number];

const DRIFT_STATUSES: ReadonlySet<string> = new Set(["extra", "missing", "diverged"]);

/**
 * Resolved feature flag: `feature-policy.yaml:
 * verification.specConformanceEnabled` AND `SPEC_CONFORMANCE_ENABLED`.
 *
 * The AND is the kill switch, not redundancy — either half back to false stops
 * the feature, so it can be killed from the environment without a config
 * deploy, or from config without an env change.
 */
export function isSpecConformanceEnabled(input: {
  policyEnabled: boolean;
  envEnabled: boolean;
}): boolean {
  return input.policyEnabled && input.envEnabled;
}

/**
 * Hash of the approved body — what makes a post-approval redraft detectable.
 *
 * Normalised for line endings and trailing whitespace first. A redraft is a
 * change of MEANING; re-saving a file with CRLF endings is not one, and
 * flagging it would train readers to ignore the signal that exists to catch
 * real redrafts. Interior changes are untouched by the normalisation.
 */
export function hashSpecBody(body: string): string {
  const normalised = body
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\s+$/, "");
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

/**
 * The isolation boundary, enforced by construction.
 *
 * Built by explicit PROJECTION, never by spread. The realistic leak is a caller
 * passing the object it already had — which happens to carry the builder's
 * session or its recalled memory — and a spread would forward all of it. With
 * a projection, a field added to `BuiltArtefact` later cannot reach the judge
 * by default; someone has to come here and add it deliberately.
 *
 * Frozen so context cannot be appended after construction either.
 */
export function buildJudgeInput(
  approvedSpecBody: string,
  artefact: BuiltArtefact,
): SpecConformanceJudgeInput {
  const projected: BuiltArtefact = Object.freeze({
    pullRequests: [...(artefact.pullRequests ?? [])],
    changedFiles: [...(artefact.changedFiles ?? [])],
    diffSummary: artefact.diffSummary ?? "",
    testNames: artefact.testNames ? [...artefact.testNames] : undefined,
  });

  return Object.freeze({ approvedSpecBody, artefact: projected });
}

/**
 * Normalise raw judge output into points policy can act on.
 *
 * Every ambiguity resolves toward `indeterminate`. A model that answers
 * "probably fine" has not said `satisfied`, and reading it as such is exactly
 * the false pass this service exists to prevent.
 */
export function normaliseJudgement(
  raw: RawConformanceJudgement | null | undefined,
): ConformancePoint[] {
  const rawPoints = raw?.points;
  if (!Array.isArray(rawPoints)) return [];

  const points: ConformancePoint[] = [];

  for (const candidate of rawPoints) {
    if (!candidate || typeof candidate !== "object") continue;

    const requirement =
      typeof candidate.requirement === "string" ? candidate.requirement.trim() : "";
    // A point with no requirement names nothing — it cannot be reported to a
    // human as a finding, and counting it would only inflate the point count.
    if (requirement.length === 0) continue;

    const evidence = Array.isArray(candidate.evidence)
      ? candidate.evidence.filter((e): e is string => typeof e === "string" && e.trim().length > 0)
      : [];

    let status: PointStatus = (STATUSES as readonly string[]).includes(candidate.status as string)
      ? (candidate.status as PointStatus)
      : "indeterminate";

    // The contract says evidence is never empty for `diverged`, `extra`, or
    // `missing`. An unevidenced drift claim is an assertion the report cannot
    // support, so it is refused — downward, to `indeterminate`, never up to
    // `satisfied`. For `missing`, evidence may be "not in changed files / tests".
    if (DRIFT_STATUSES.has(status) && evidence.length === 0) status = "indeterminate";

    const point: ConformancePoint = { requirement, status };
    if (typeof candidate.dimension === "string" && candidate.dimension.trim().length > 0) {
      point.dimension = candidate.dimension.trim();
    }
    if (typeof candidate.observed === "string" && candidate.observed.trim().length > 0) {
      point.observed = candidate.observed.trim();
    }
    if (evidence.length > 0) point.evidence = evidence;

    points.push(point);
  }

  return points;
}

/**
 * The roll-up. Pure, total, and it fails toward `indeterminate`.
 *
 * Order matters and each step is a decision:
 *
 *  1. No provenance is `unverifiable` FIRST, before any point can influence it.
 *     A work item with no linked approved spec must never roll up to a pass —
 *     that turns an audit hole into a green tick, which is worse than no check
 *     at all because it is a green tick someone will trust.
 *  2. Any `extra`, `missing`, or `diverged` point is `drifted`, even alongside
 *     indeterminate points. A found gap is the most actionable thing in the
 *     report and must not be diluted by uncertainty elsewhere. `extra` and
 *     `missing` reopen the spec; they still roll up `drifted` so they post.
 *  3. A spec that moved after approval cannot yield `conforms`. The comparison
 *     was against the approved text, which is no longer what the spec says, so
 *     a clean pass would assert conformance to a document that no longer
 *     exists. Drift already found survives — a redraft does not absolve it.
 *  4. No points is `indeterminate`. Nothing compared is not nothing wrong.
 */
export function rollUpVerdict(input: {
  hasProvenance: boolean;
  specUnchangedSinceApproval: boolean;
  points: ConformancePoint[];
}): ConformanceVerdict {
  if (!input.hasProvenance) return "unverifiable";

  if (input.points.some((p) => DRIFT_STATUSES.has(p.status))) return "drifted";

  if (!input.specUnchangedSinceApproval) return "indeterminate";

  if (input.points.length === 0) return "indeterminate";

  if (input.points.some((p) => p.status !== "satisfied")) return "indeterminate";

  return "conforms";
}

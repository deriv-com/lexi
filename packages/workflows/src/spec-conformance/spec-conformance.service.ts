/**
 * Spec conformance verifier — the EXIT gate.
 *
 * Reconstructs what the APPROVED SPEC REVISION asked for, compares it with what
 * was built, and reports the difference. It never blocks.
 *
 * ## Report, not gate
 *
 * There is no code path here that fails a PR, closes anything, or gates a
 * deploy. That is a hard constraint, not a default: `evaluateSpecGate` contains
 * no model judgement by design, and humans own the production gate. A
 * model-driven verdict able to fail a PR would put model judgement in a
 * governance position the architecture refuses it. Enabling this service makes
 * that constraint MORE load-bearing, not less, which is why it is asserted
 * structurally in `spec-conformance-isolation.spec.ts` rather than promised
 * here.
 *
 * `verify()` therefore resolves for every outcome, including its own failures.
 * A throw would be a blocking path by another name — a caller in a merge step
 * would surface it as a failure.
 *
 * ## Isolation
 *
 * The constructor takes four collaborators and none of them can carry the
 * builder's context: no memory port, no agent session, no dispatch
 * conversation. If the assumptions that produced a wrong implementation are
 * reachable by the checker, the check reproduces the mistake rather than
 * catching it. Two independent readings of the spec is the entire mechanism.
 */

import type {
  ApprovedSpecRevisionPort,
  BuiltArtefact,
  ConformancePoint,
  SpecConformanceJudge,
  SpecConformanceOptions,
  SpecConformanceReport,
  SpecProvenance,
  SpecProvenancePort,
} from "./spec-conformance.types";
import {
  buildJudgeInput,
  hashSpecBody,
  normaliseJudgement,
  rollUpVerdict,
} from "./spec-conformance-policy";

export interface SpecConformanceDeps {
  provenance: SpecProvenancePort;
  specRevisions: ApprovedSpecRevisionPort;
  judge: SpecConformanceJudge;
  options: SpecConformanceOptions;
}

/** The redraft finding, reported as a point in its own right. */
const REDRAFT_POINT: ConformancePoint = Object.freeze({
  requirement:
    "The approved spec body is unchanged since approval (redraft check, changed since approval)",
  status: "indeterminate",
});

function report(fields: {
  workItemId: string;
  provenance?: SpecProvenance;
  source: SpecConformanceReport["source"];
  specUnchangedSinceApproval: boolean;
  points: ConformancePoint[];
  verdict: SpecConformanceReport["verdict"];
  summary: string;
}): SpecConformanceReport {
  const base: SpecConformanceReport = {
    workItemId: fields.workItemId,
    source: fields.source,
    specUnchangedSinceApproval: fields.specUnchangedSinceApproval,
    points: fields.points,
    verdict: fields.verdict,
    summary: fields.summary,
  };
  if (fields.provenance) base.provenance = fields.provenance;
  return base;
}

export class SpecConformanceService {
  constructor(private readonly deps: SpecConformanceDeps) {}

  /**
   * Produce a conformance report for one work item.
   *
   * `null` while the feature flag is off — a dark feature must not spend model
   * calls or emit reports it was never certified to make.
   */
  async verify(
    workItemId: string,
    artefact: BuiltArtefact,
  ): Promise<SpecConformanceReport | null> {
    if (!this.deps.options.enabled) return null;

    try {
      const provenance = await this.deps.provenance.loadSpecProvenance(workItemId);

      // SHORT CIRCUIT — before the model.
      //
      // Day one this is nearly every work item: provenance is only written for
      // dispatches after the write half ships. Paying for a judgement to learn
      // "no spec was linked" is spend that cannot produce a finding, on the
      // highest-volume path there is.
      if (!provenance) {
        return report({
          workItemId,
          source: "unverifiable",
          specUnchangedSinceApproval: false,
          points: [],
          verdict: "unverifiable",
          summary:
            "No approved spec was linked to this work item, so there was nothing to compare what shipped against. This is an audit gap, not a drift finding.",
        });
      }

      const body = await this.deps.specRevisions.loadApprovedSpecBody(
        provenance.specId,
        provenance.revision,
      );

      // Provenance exists — the audit trail is intact. It is the comparison
      // that failed, which is a different finding from "no spec was linked",
      // so this is `indeterminate` and not `unverifiable`.
      if (body === null || body === undefined) {
        return report({
          workItemId,
          provenance,
          source: "spec_provenance",
          specUnchangedSinceApproval: false,
          points: [],
          verdict: "indeterminate",
          summary: `The spec that authorised this work (${provenance.specId} rev ${provenance.revision}) could not be retrieved, so no comparison was made.`,
        });
      }

      const hash = (this.deps.options.hashSpecBody ?? hashSpecBody)(body);
      const specUnchangedSinceApproval = hash === provenance.contentHash;

      let points: ConformancePoint[] = [];
      let judgeFailed = false;
      try {
        const raw = await this.deps.judge.compare(buildJudgeInput(body, artefact));
        points = normaliseJudgement(raw);
      } catch {
        // A judge failure is not a pass and not a divergence. It is an absence
        // of evidence, and the report says so.
        judgeFailed = true;
      }

      if (!specUnchangedSinceApproval) points = [REDRAFT_POINT, ...points];

      const verdict = judgeFailed
        ? "indeterminate"
        : rollUpVerdict({ hasProvenance: true, specUnchangedSinceApproval, points });

      return report({
        workItemId,
        provenance,
        source: "spec_provenance",
        specUnchangedSinceApproval,
        points,
        verdict,
        summary: summarise(verdict, provenance, specUnchangedSinceApproval, points, judgeFailed),
      });
    } catch {
      // Infrastructure failure. Reported as `indeterminate`, never as
      // `unverifiable` — claiming the work item has no approved spec because a
      // lookup timed out would be a false audit finding about the work.
      return report({
        workItemId,
        source: "unverifiable",
        specUnchangedSinceApproval: false,
        points: [],
        verdict: "indeterminate",
        summary:
          "The conformance check could not run for this work item. No conclusion is drawn about whether what shipped matches its spec.",
      });
    }
  }
}

function summarise(
  verdict: SpecConformanceReport["verdict"],
  provenance: SpecProvenance,
  specUnchanged: boolean,
  points: ConformancePoint[],
  judgeFailed: boolean,
): string {
  const ref = `${provenance.specId} rev ${provenance.revision}`;
  const redraft = specUnchanged
    ? ""
    : ` The spec body no longer matches the revision that was approved — it was redrafted after authorising this work, so the comparison is against the approved text.`;

  if (judgeFailed) {
    return `The comparison against ${ref} could not be completed, so no conclusion is drawn.${redraft}`;
  }

  const extras = points.filter((p) => p.status === "extra").length;
  const missing = points.filter((p) => p.status === "missing").length;
  const diverged = points.filter((p) => p.status === "diverged").length;
  const drift = extras + missing + diverged;

  switch (verdict) {
    case "conforms":
      return `What shipped matches the ${points.length} requirement(s) reconstructed from ${ref}.${redraft}`;
    case "drifted":
      return `What shipped diverges from ${ref} on ${drift} of ${points.length} requirement(s).${redraft}`;
    default:
      return `The comparison against ${ref} was inconclusive on at least one requirement.${redraft}`;
  }
}

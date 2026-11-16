/**
 * Rendering and delivery target for a conformance report.
 *
 * Two properties are load-bearing here and both are tested:
 *
 *  - `unverifiable` must not read like `drifted`. On day one nearly every work
 *    item is unverifiable, because provenance is only written for dispatches
 *    that happen after the write half lands. "No approved spec was linked to
 *    this work" and "what shipped diverges from what was approved" are
 *    different sentences, and collapsing them would make the whole report read
 *    as a wall of failures before anyone could act on one.
 *
 *  - the report is governance output. It goes to the spec thread or the
 *    governance channel and nowhere else, and it @-mentions nobody. A
 *    capability that is on and posts is a capability that can burst.
 */

import type {
  ConformanceDestination,
  ConformancePoint,
  SpecConformanceReport,
} from "./spec-conformance.types";

/** Shared footer. Deliberately free of the words a reader scans for as a red mark. */
const FOOTER = "This is a report — it does not block a merge or a deploy. A human decides.";

function renderPoint(point: ConformancePoint): string {
  const lines = [`• ${point.requirement} — ${point.status}`];
  if (point.dimension) lines.push(`  dimension: ${point.dimension}`);
  if (point.observed) lines.push(`  observed: ${point.observed}`);
  if (point.evidence?.length) lines.push(`  evidence: ${point.evidence.join(", ")}`);
  return lines.join("\n");
}

/**
 * One human-readable block, safe to post unedited.
 *
 * Keyed off `verdict`, not `source`: an infrastructure failure that prevented
 * the check reports as `indeterminate`, and must NOT say "no approved spec was
 * linked" — that would be a false audit finding about the work item.
 */
export function renderConformanceReport(report: SpecConformanceReport): string {
  const provenance = report.provenance
    ? `spec ${report.provenance.specId} rev ${report.provenance.revision}, approved ${report.provenance.approvedAt}`
    : null;

  if (report.verdict === "unverifiable") {
    return [
      "Spec conformance — unverifiable",
      "No approved spec was linked to this work item, so there was nothing to compare what shipped against.",
      "This is not a drift finding. It means the work predates spec provenance, or was dispatched without it.",
      FOOTER,
    ].join("\n");
  }

  if (report.verdict === "drifted") {
    return [
      "Spec conformance — drifted",
      `What shipped diverges from the spec that authorised it (${provenance ?? "provenance unavailable"}).`,
      ...report.points.map(renderPoint),
      report.specUnchangedSinceApproval
        ? ""
        : "Note: the spec body no longer matches the revision that was approved — it was redrafted after authorising this work. The comparison above is against the text that was approved.",
      FOOTER,
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }

  if (report.verdict === "conforms") {
    return [
      "Spec conformance — conforms",
      `What shipped matches the spec that authorised it (${provenance ?? "provenance unavailable"}).`,
      ...report.points.map(renderPoint),
      FOOTER,
    ].join("\n");
  }

  return [
    "Spec conformance — indeterminate",
    `The comparison could not be completed with confidence (${provenance ?? "provenance unavailable"}).`,
    ...report.points.map(renderPoint),
    FOOTER,
  ].join("\n");
}

/**
 * Where a conformance report may be delivered.
 *
 * There are exactly two destinations and neither is a platform team channel.
 * Constraining the blast radius here rather than at the call site is
 * deliberate: a caller that forgets cannot widen it.
 */
export function resolveConformanceDestination(input: {
  governanceChannelId: string;
  specThreadTs?: string;
}): ConformanceDestination {
  if (input.specThreadTs) {
    return {
      kind: "spec_thread",
      channelId: input.governanceChannelId,
      threadTs: input.specThreadTs,
    };
  }

  return { kind: "governance_channel", channelId: input.governanceChannelId };
}

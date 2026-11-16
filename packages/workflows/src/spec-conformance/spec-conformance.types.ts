/**
 * Spec conformance — the EXIT gate's ports.
 *
 * The pipeline has an entrance gate: a code task refuses to dispatch without an
 * approved spec at a referenced revision. Without an exit gate, an approved spec
 * authorises work and is then never consulted again.
 *
 * What this closes is NOT behaviour verification. `issue-verification.service`
 * and `verification-policy` already answer "did the bug reproduce, does the fix
 * hold" — that is testing. The gap here is conformance: the implementation and
 * its tests can encode the SAME misreading of the spec and both pass. Spec says
 * a three-step flow, builder reads two, tests cover two, everything is green,
 * product is wrong. Only a comparison against the approved text catches that.
 *
 * ## Why these are ports and not imports
 *
 * The WRITE half (recording provenance at dispatch) is built independently in
 * `@lexi/specs` + the orchestrator. Binding to its module or its function name
 * here would couple two components at their implementations rather than at the
 * frozen contract. Every port below is structural: any object with the right
 * shape satisfies it, so integration binds whatever the write half ended up
 * calling its helper without a change in this package.
 */

import type {
  ConformancePoint,
  SpecConformanceReport,
  SpecProvenance,
} from "@lexi/contracts";

/**
 * Reads provenance recorded at dispatch. `null` means the work item carries no
 * approved spec — an audit hole, reported as `unverifiable` and NEVER as a pass.
 *
 * Satisfied structurally by the write half's read helper, whatever package it
 * lands in and whatever shape it took. As built, that helper is a free function
 * `loadSpecProvenance(store, workItemId)` in `@lexi/governance/spec`, so
 * integration binds it with an adapter rather than a change here:
 *
 * ```ts
 * const provenance: SpecProvenancePort = {
 *   loadSpecProvenance: (workItemId) => loadSpecProvenance(store, workItemId),
 * };
 * ```
 *
 * Defining the port on this side is what made the two halves independently
 * buildable — neither had to wait on the other's naming.
 */
export interface SpecProvenancePort {
  loadSpecProvenance(workItemId: string): Promise<SpecProvenance | null>;
}

/**
 * Loads the spec body AT A NAMED REVISION.
 *
 * The revision argument is not decoration. Re-resolving "the current approved
 * spec" would silently follow a post-approval redraft — the check would then
 * agree with whatever the spec says *now* and never notice it moved after
 * authorising the work, which is precisely the drift being detected.
 *
 * `null` means the authorising text could not be retrieved. That is not a pass
 * and not `unverifiable` either: provenance exists, the comparison is what
 * failed, so it rolls up `indeterminate`.
 */
export interface ApprovedSpecRevisionPort {
  loadApprovedSpecBody(specId: string, revision: number): Promise<string | null>;
}

/**
 * What was actually built. Supplied by the caller, already gathered.
 *
 * Deliberately flat and small. The judge is handed a projection of this built
 * by `buildJudgeInput()`, never this object itself — see the isolation note on
 * `SpecConformanceJudge`.
 */
export interface BuiltArtefact {
  /** PR numbers/urls the work landed in. */
  pullRequests: string[];
  /** Paths touched. */
  changedFiles: string[];
  /** Diff text or a summary of it. */
  diffSummary: string;
  /** Names of tests added/changed, when known. */
  testNames?: string[];
}

/**
 * The ONLY thing the judge may see.
 *
 * Isolation is a correctness property here, not hygiene. If the checker can
 * reach the assumptions that produced a wrong implementation — the builder's
 * session, recalled memory, the dispatch conversation — the check reproduces
 * the mistake instead of catching it. Two independent readings of the spec is
 * the entire mechanism; a shared context collapses them into one.
 *
 * So this type is a closed allowlist of two fields, and
 * `buildJudgeInput()` constructs it by explicit projection (never by spread),
 * so a field added to `BuiltArtefact` later cannot leak into the judge by
 * default.
 */
export interface SpecConformanceJudgeInput {
  /** The approved spec body, at the approved revision. */
  approvedSpecBody: string;
  /** The built artefact, projected to the fields above. */
  artefact: BuiltArtefact;
}

/**
 * Raw, UNVALIDATED judge output.
 *
 * `unknown`-ish on purpose: the model proposes, deterministic policy disposes.
 * Everything here is normalised and validated by `normaliseJudgement()` before
 * it can influence a verdict, and anything unparseable becomes `indeterminate`
 * rather than being dropped or optimistically read as a match.
 */
export interface RawConformanceJudgement {
  points?: Array<{
    requirement?: unknown;
    dimension?: unknown;
    status?: unknown;
    observed?: unknown;
    evidence?: unknown;
  }>;
}

/**
 * Model judgement for the comparison itself — appropriate here, because
 * "does this diff implement this paragraph" is not expressible as a rule.
 * The POLICY around it is not model judgement: what counts as drift, what is
 * reported, and how a verdict rolls up are all deterministic code.
 */
export interface SpecConformanceJudge {
  compare(input: SpecConformanceJudgeInput): Promise<RawConformanceJudgement>;
}

/** Where a conformance report may be delivered. */
export type ConformanceDestinationKind = "spec_thread" | "governance_channel";

/**
 * Resolved delivery target.
 *
 * Drift reports are GOVERNANCE output. They go to the spec thread or the
 * governance channel and nowhere else — never to a platform team channel, and
 * never @-mentioning a code owner. A capability that is on and posts is a
 * capability that can burst; the blast radius is constrained by construction
 * rather than by the caller remembering.
 */
export interface ConformanceDestination {
  kind: ConformanceDestinationKind;
  /** Slack channel id, from config. Never hard-coded in TypeScript. */
  channelId: string;
  /** Thread ts when replying onto the spec thread. */
  threadTs?: string;
}

export interface SpecConformanceOptions {
  /**
   * Resolved feature flag. `feature-policy.yaml:
   * verification.specConformanceEnabled` AND `SPEC_CONFORMANCE_ENABLED` —
   * see `isSpecConformanceEnabled()`. Either half false stops the feature.
   */
  enabled: boolean;
  /** Governance channel id (escalation-policy.yaml: governance.channelId). */
  governanceChannelId: string;
  /** Override for tests/replay. Defaults to sha256-hex of the normalised body. */
  hashSpecBody?: (body: string) => string;
}

export type { ConformancePoint, SpecConformanceReport, SpecProvenance };

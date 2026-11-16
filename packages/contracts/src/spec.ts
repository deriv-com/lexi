/**
 * Clarification and spec-pipeline contracts.
 *
 * Coverage is held as machine-readable state precisely so the stop condition
 * is deterministic code rather than a model judgement, and so a dimension that
 * is already covered is never re-asked (checked in code, not by the model).
 */

/**
 * The clarification checklist. Frozen because `SpecSession.coverage` is
 * persisted against these keys — renaming or removing one orphans stored
 * sessions.
 *
 * ADDING is a different operation from renaming, and is safe here for two
 * structural reasons: `CoverageRecord.dimensions` is `Partial`, so a stored
 * session that has never heard of a new key is already a legal value; and
 * `isReadyToDraft()` iterates `policy.mandatoryDimensions` from
 * `config/spec-policy.yaml` rather than this union, so existence and
 * requirement are separate decisions. A dimension added here and left out of
 * that config is inert: asked about when convenient, never blocking a draft.
 *
 * That is deliberately how the three below ship. Promoting one to mandatory is
 * a config change made once in-flight sessions have drained — doing both at
 * once would make every session that is mid-clarification suddenly incomplete
 * against a question nobody has been asked.
 */
export type CoverageDimension =
  /** What is actually wrong or missing, in the user's terms. */
  | "problem"
  /** Who is affected, and how they hit it. */
  | "users"
  /** What is in scope for this change. */
  | "scope"
  /** What is deliberately excluded — the boundary that stops scope creep. */
  | "non_goals"
  /** How we will know it is done. */
  | "acceptance_criteria"
  /** Which platforms/repos are targeted; mobile-first is the default. */
  | "platforms"
  /** Upstream work, services, or approvals this blocks on. */
  | "dependencies"
  /** What could go wrong, and what we accept. */
  | "risks"
  /** How it ships: flags, sequencing, verification. */
  | "rollout"
  /**
   * The states the journey actually reaches — empty, loading, partial, error,
   * offline, permission, recovery — not just the happy path.
   *
   * `SPEC_SECTIONS` has carried an "Edge states" heading with no dimension and
   * no fallback behind it, so every rendered spec has shipped that section
   * reading `_Not yet specified._`. The heading asked the question; nothing
   * collected the answer.
   */
  | "journey_states"
  /**
   * Ownership and freshness of the data the change reads or writes: which
   * resource, who owns it, what is cached and for how long, what invalidates
   * it, and which mutations are safe to retry.
   *
   * Backs the "API & data" heading, dead for the same reason as above.
   */
  | "api_contract"
  /**
   * The user-perceived milestone this change is measured by, its budget, and
   * who owns a regression: metric, percentile, segment, threshold, owner.
   *
   * Backs the "Metrics" heading. Named for the *plan* rather than the numbers
   * because a budget with no owner and no rollback condition is a wish.
   */
  | "performance_plan";

/**
 * `open` — still needs an answer. `covered` — answered, never ask again.
 * `deferred` — explicitly out of scope for this spec; counts as satisfied by
 * `isReadyToDraft()`.
 */
export type CoverageStatus = "open" | "covered" | "deferred";

export interface CoverageEntry {
  status: CoverageStatus;
  /** Where the answer came from: thread, corpus, code, or the user. */
  evidence?: string;
  /** Turn that settled it, for replay. */
  sourceTurnId?: string;
  /** Why it was deferred; required in practice for `deferred`. */
  reason?: string;
}

/**
 * The whole checklist plus the two counters the stop condition reads.
 * `readyToDraft` is computed by `isReadyToDraft(coverage, policy)` — all
 * mandatory dimensions covered or explicitly deferred, the `maxQuestionTurns`
 * cap reached, or a user override.
 */
export interface CoverageRecord {
  dimensions: Partial<Record<CoverageDimension, CoverageEntry>>;
  /** Question rounds spent so far, against `spec-policy.yaml: maxQuestionTurns`. */
  questionTurns: number;
  readyToDraft: boolean;
}

/**
 * Revision ledger — the six fields a spec revision must carry for review.
 *
 * Already persisted elsewhere: specification version (`SpecDocument.revision`),
 * approval or exception (`SpecApproval.action`), timestamp (`createdAt` /
 * `approvedAt`). The three below are the ones that were missing or were
 * faked with the literal string `"thread"`.
 */

/** One section that moved between revisions. Bodies stay off the row — they can be large. */
export interface SpecChangedSection {
  id: string;
  heading: string;
  kind: "added" | "removed" | "changed";
}

/** Where the revision's evidence actually lives. `href` must be an http(s) URL. */
export type SpecEvidenceKind = "slack_thread" | "github_issue" | "github_pr" | "figma" | "other";

export interface SpecEvidenceLink {
  href: string;
  label?: string;
  kind?: SpecEvidenceKind;
}

/** A named owner of an open question or constraint. */
export interface SpecNamedOwner {
  role: string;
  name: string;
  slackUserId?: string;
}

/** Spec lifecycle, mirrored on `SpecSession.status` / `SpecDocument.status`. */
export type SpecStatus =
  | "DRAFTING"
  | "DRAFT_READY"
  | "IN_REVIEW"
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REJECTED"
  | "SUPERSEDED";

/**
 * A reference to an approved spec, as carried by work items and by
 * `trigger_code_task`. A feature dispatch without one is refused.
 */
export interface SpecRef {
  specId: string;
  revision: number;
  status: SpecStatus;
  /** Product repo the spec governs and where its issue lives. */
  trackingRepoKey: string;
  codeRepoKey?: string;
  issueNumber?: number;
  contentHash: string;
}

/**
 * One acceptance criterion, addressable by a stable id.
 *
 * ## Why this type exists
 *
 * Acceptance criteria were a newline split of one coverage dimension's free
 * text — `string[]`, positional, with nothing durable to point at. Three
 * separate review requirements all need a criterion to be *addressable*: the
 * acceptance-to-test matrix maps criterion → test, per-criterion
 * performance budgets hang off one, and the PR evidence index is
 * "evidence for every acceptance criterion". None of those can exist while the
 * only handle is a line number that renumbers whenever someone inserts a line
 * above it.
 *
 * ## What "stable" means here, precisely
 *
 * `id` is derived from the criterion's own normalised text, not from its
 * position and not from a counter. Two consequences, both intended:
 *
 *   - Reordering, inserting, or deleting *other* criteria does not change this
 *     one's id. A test that cited `AC-a1b2c3d4` in revision 3 still cites the
 *     same criterion in revision 9.
 *   - **Rewording a criterion changes its id.** This is deliberate. The
 *     alternative — matching a reworded line back to its predecessor — is a
 *     guess, and a wrong guess is worse than an orphan: it would leave a test
 *     asserting it covers a criterion whose meaning has since moved, which is
 *     exactly the drift the spec-driven model exists to catch. An orphaned
 *     reference is visible and answerable; a silently re-pointed one is not.
 *
 * Derivation is pure and needs no storage, which keeps it consistent with the
 * rest of the spec pipeline: `renderSpec` is deterministic and `contentHash`
 * exists so replay never depends on GitHub state. An id that had to be looked
 * up in a table would break that property.
 */
export interface AcceptanceCriterion {
  /** `AC-` followed by 8 hex characters of the normalised text's digest. */
  id: string;
  /** The criterion as written, list marker stripped and whitespace collapsed. */
  text: string;
  /**
   * 1-based position within the spec, for display and ordering only.
   *
   * NEVER an identity. It changes whenever a criterion is inserted above this
   * one, which is the whole reason `id` is not derived from it.
   */
  ordinal: number;
}

import { createHash } from "node:crypto";
import type { AcceptanceCriterion, RepoDescriptor } from "@lexi/contracts";
import type { DerivedTask, SpecSessionState } from "./spec-session";

/**
 * Spec → `trigger_code_task` candidate shaping.
 *
 * `generate_task_breakdown` is read-only and proposes work. A proposal is only
 * worth reviewing if the next step can actually act on it, so a candidate is
 * shaped as a **valid `trigger_code_task` input** — the same fields that tool
 * requires, under the same names — rather than as a free-form summary someone
 * would have to translate by hand.
 *
 * ## What this deliberately refuses to invent
 *
 * `trigger_code_task` demands a concrete `target` (an exact file, screen,
 * component or symbol) precisely so a "remove one file" request cannot become a
 * sprawling PR: it is the only scope control that tool has, since a non-bug
 * task has no reproduction anchoring it. A spec states *outcomes* — what should
 * be true when the work is done — and almost never names a file. So `target` is
 * usually absent here, and absent is the correct answer: a plausible-looking
 * path guessed from a title would satisfy the tool's check while removing the
 * protection the check exists to provide.
 *
 * The same applies to `dependsOn`. It carries what the requester actually said
 * in the `dependencies` dimension, verbatim, and infers nothing. An ordering
 * nobody wrote down is a schedule nobody agreed to, and on a board it would be
 * indistinguishable from one that was.
 *
 * Pure and dependency-free like the rest of `@lexi/specs`: whether a candidate
 * may actually be dispatched is a *policy* question, answered by
 * `evaluateQuickFixEligibility` in `@lexi/governance` at the call site that
 * holds both.
 */

/** A candidate task, in the shape `trigger_code_task` accepts. */
export interface SpecTaskCandidate {
  specId: string;
  title: string;
  kind: "feature" | "chore" | "bug";
  /** `config/repos.yaml` key the change lands in. */
  codeRepoKey: string;
  /** The registry's platform value for that repo — never a hard-coded union. */
  platform?: string;
  /**
   * The concrete thing to change. Absent whenever the spec did not name one,
   * which is the common case — see the note above on why this is not guessed.
   */
  target?: string;
  /**
   * One entry per acceptance criterion the spec states, each addressable by a
   * stable id so a test or a piece of evidence can cite one.
   */
  acceptanceCriteria: AcceptanceCriterion[];
  /** Stated dependencies, verbatim. Never inferred. */
  dependsOn: string[];
  notes?: string;
}

/** Leading list markers this strips: `-`, `*`, `•`, `1.`, `1)`. */
const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * Splits a coverage dimension's free text into discrete criteria.
 *
 * Line-based rather than sentence-based on purpose: people write acceptance
 * criteria as lists, and splitting prose on full stops would shred "retries up
 * to 3 times, then surfaces the failure." into two criteria that each mean
 * something different from the whole.
 */
export function splitAcceptanceCriteria(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.replace(LIST_MARKER, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * How many hex characters of the digest an acceptance-criterion id carries.
 *
 * Eight gives a 4-billion space against the handful of criteria in one spec, so
 * an accidental collision is not a real risk, while staying short enough that a
 * person can read `AC-a1b2c3d4` out of a PR description and type it into a test
 * name without transcribing a paragraph.
 */
const CRITERION_ID_HEX = 8;

/**
 * Normalisation applied before hashing.
 *
 * Whitespace runs collapse so that re-indenting a list, or joining a line that
 * was wrapped by an editor, does not mint a new id for a criterion nobody
 * edited. Case is deliberately NOT folded: a case change is a text change, and
 * silently treating "Deposit succeeds" and "deposit succeeds" as one criterion
 * would be the same class of guess this design rejects elsewhere.
 */
function normalizeCriterionText(line: string): string {
  return line.replace(LIST_MARKER, "").replace(/\s+/g, " ").trim();
}

/** `AC-` + the first {@link CRITERION_ID_HEX} hex characters of sha256(text). */
export function acceptanceCriterionId(text: string): string {
  const digest = createHash("sha256").update(normalizeCriterionText(text), "utf8").digest("hex");
  return `AC-${digest.slice(0, CRITERION_ID_HEX)}`;
}

/**
 * Parses a coverage dimension's free text into addressable criteria.
 *
 * Identical criteria collapse to one. Two lines with the same normalised text
 * are the same criterion — they hash to the same id, so keeping both would put
 * two rows in the matrix under one address and make "evidence for AC-x"
 * ambiguous. Deduplicating is the only option that keeps ids addressable; the
 * first occurrence wins so `ordinal` still reflects reading order, and the
 * dropped duplicate is observable as a count difference rather than silently
 * changing what a criterion means.
 */
export function parseAcceptanceCriteria(text: string | undefined): AcceptanceCriterion[] {
  const seen = new Set<string>();
  const criteria: AcceptanceCriterion[] = [];

  for (const line of splitAcceptanceCriteria(text)) {
    const normalized = normalizeCriterionText(line);
    if (normalized.length === 0) continue;

    const id = acceptanceCriterionId(normalized);
    if (seen.has(id)) continue;
    seen.add(id);

    criteria.push({ id, text: normalized, ordinal: criteria.length + 1 });
  }

  return criteria;
}

/**
 * Turns one `deriveTaskBreakdown` row into a dispatch candidate.
 *
 * `repo` is the resolved `RepoDescriptor`, so `platform` comes from
 * `config/repos.yaml` rather than from a literal in a schema — adding a repo
 * stays a config change.
 */
export function toDispatchCandidate(
  task: DerivedTask,
  context: { session: SpecSessionState; repo: RepoDescriptor },
): SpecTaskCandidate {
  const { session, repo } = context;
  const dimensions = session.coverage.dimensions;

  // The scope dimension is the only place a requester states *where* the change
  // lands. When they did not, target stays absent rather than being synthesised
  // from the title.
  const target = dimensions.scope?.state === "COVERED" ? dimensions.scope.notes?.trim() : undefined;

  return {
    specId: task.specId,
    title: task.title,
    kind: task.kind,
    codeRepoKey: task.codeRepoKey ?? repo.key,
    ...(repo.platform !== undefined ? { platform: repo.platform } : {}),
    ...(target ? { target } : {}),
    acceptanceCriteria: parseAcceptanceCriteria(dimensions.acceptance_criteria?.notes),
    // Still plain strings: a dependency is a thing someone said, not something
    // a test cites. Giving it an id would imply an addressability nothing uses.
    dependsOn: splitAcceptanceCriteria(
      dimensions.dependencies?.state === "COVERED" ? dimensions.dependencies.notes : undefined,
    ),
    ...(task.notes ? { notes: task.notes } : {}),
  };
}

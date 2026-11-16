import { randomUUID } from "node:crypto";
import type {
  CoverageDimension,
  SpecChangedSection,
  SpecEvidenceLink,
  SpecNamedOwner,
  SpecStatus,
} from "@lexi/contracts";
import {
  createCoverageRecord,
  deferDimension,
  recordCoverage,
  type SpecCoverageRecord,
} from "./coverage";
import type { SpecPolicy } from "./load-spec-policy";
import { nextQuestionBatch, questionPolicyFrom, type QuestionBatch } from "./question-policy";
import { isReadyToDraft, readinessPolicyFrom, type ReadinessResult } from "./readiness";
import { SpecStateMachine } from "./spec-state-machine";
import { classifySpecRisk, type SpecRiskClassification } from "./risk-tier";
import { diffSpecRevisions, type SpecRevisionSide } from "./spec-diff";
import {
  ledgerFromDiff,
  requesterOwner,
  sanitizeEvidenceLinks,
  sanitizeNamedOwners,
} from "./spec-revision-ledger";
import {
  renderSpec,
  SPEC_REVISION_LEDGER_SECTION_ID,
  type RenderedSpec,
  type SpecTaskBreakdownItem,
} from "./spec-template";

/**
 * The clarification session — the state a spec conversation carries
 * between turns, and the deterministic transitions over it.
 *
 * Deliberately pure. The session is a value; persisting it to `SpecSession` /
 * `SpecDocument` and posting to Slack belong to the caller. That keeps the
 * stop condition provably free of I/O, makes the whole loop testable without a
 * database, and means a replay can re-derive every decision from the record
 * rather than from whatever GitHub happens to say today.
 */

const machine = new SpecStateMachine();

export interface SpecSessionState {
  specId: string;
  threadKey: string;
  requestedBy: string;
  title: string;
  targetRepoKey?: string;
  status: SpecStatus;
  revision: number;
  coverage: SpecCoverageRecord;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  /** Free-text section overrides carried across revisions. */
  sections?: Record<string, string>;
  /**
   * Real evidence URLs for this session's revision ledger. Empty when the
   * caller has no permalink — never the literal string `"thread"`.
   */
  evidenceLinks?: SpecEvidenceLink[];
  /** Named owners of open questions / constraints. */
  owners?: SpecNamedOwner[];
}

/** One dimension's answer for a turn. `defer` records an explicit deferral. */
export interface DimensionAnswer {
  answer?: string;
  confidence?: number;
  defer?: string;
  evidence?: string;
  sourceTurnId?: string;
}

export type SessionAnswers = Partial<Record<CoverageDimension, DimensionAnswer>>;

export function startSpecSession(args: {
  threadKey: string;
  requestedBy: string;
  title: string;
  targetRepoKey?: string;
  /** What the opening request already answered — mined, not asked. */
  seed?: SessionAnswers;
  /**
   * Slack permalink / GitHub URL that justified opening this spec. Invalid
   * hrefs (including `"thread"`) are dropped, not rewritten.
   */
  evidenceLinks?: SpecEvidenceLink[];
  owners?: SpecNamedOwner[];
  now?: Date;
}): SpecSessionState {
  const evidenceLinks = sanitizeEvidenceLinks(args.evidenceLinks ?? []);
  const owners = sanitizeNamedOwners(args.owners ?? [requesterOwner(args.requestedBy)]);
  const session: SpecSessionState = {
    specId: randomUUID(),
    threadKey: args.threadKey,
    requestedBy: args.requestedBy,
    title: args.title,
    ...(args.targetRepoKey !== undefined ? { targetRepoKey: args.targetRepoKey } : {}),
    status: "DRAFTING",
    revision: 1,
    coverage: createCoverageRecord(),
    createdAt: (args.now ?? new Date()).toISOString(),
    ...(evidenceLinks.length > 0 ? { evidenceLinks } : {}),
    ...(owners.length > 0 ? { owners } : {}),
  };

  if (!args.seed) return session;

  // Seeding does NOT count as a question turn: nobody was asked anything.
  return { ...session, coverage: applyToCoverage(session.coverage, args.seed, "thread") };
}

function applyToCoverage(
  coverage: SpecCoverageRecord,
  answers: SessionAnswers,
  defaultEvidence: string,
): SpecCoverageRecord {
  let next = coverage;

  for (const [key, answer] of Object.entries(answers)) {
    const dimension = key as CoverageDimension;
    if (!answer) continue;

    if (answer.defer) {
      next = deferDimension(next, dimension, answer.defer);
      continue;
    }

    if (!answer.answer || answer.answer.trim().length === 0) continue;

    const confidence = answer.confidence ?? 1;
    // Below 0.7 an answer is treated as a partial: "not sure yet" is
    // information, but it is not an answer, and recording it as COVERED would
    // stop the loop from ever coming back to it.
    const state = confidence >= 0.7 ? "COVERED" : "PARTIAL";

    next = recordCoverage(next, dimension, {
      state,
      confidence,
      notes: answer.answer.trim(),
      evidence: answer.evidence ?? defaultEvidence,
      ...(answer.sourceTurnId !== undefined ? { sourceTurnId: answer.sourceTurnId } : {}),
    });
  }

  return next;
}

/**
 * Folds a turn's answers into the session and burns one question turn.
 *
 * The turn is counted even when the answers are empty — that is what makes the
 * `maxQuestionTurns` cap a real bound. A user who replies "dunno" five times
 * must still reach a draft rather than being asked forever.
 */
export function applyAnswers(session: SpecSessionState, answers: SessionAnswers): SpecSessionState {
  const coverage = applyToCoverage(session.coverage, answers, "user");

  return {
    ...session,
    coverage: { ...coverage, questionTurns: session.coverage.questionTurns + 1 },
  };
}

export type SpecSessionStep =
  | { kind: "ask"; batch: QuestionBatch; readiness: ReadinessResult }
  | { kind: "draft"; readiness: ReadinessResult };

/**
 * What to do next. Deterministic and LLM-free: the decision to stop asking is
 * a function of the coverage record and the policy, nothing else.
 */
export function advanceSpecSession(
  session: SpecSessionState,
  policy: SpecPolicy,
  options: { userOverride?: boolean } = {},
): SpecSessionStep {
  const readiness = isReadyToDraft(session.coverage, readinessPolicyFrom(policy), options);
  if (readiness.ready) return { kind: "draft", readiness };

  return { kind: "ask", batch: nextQuestionBatch(session.coverage, questionPolicyFrom(policy)), readiness };
}

export interface DraftedSpec {
  session: SpecSessionState;
  rendered: RenderedSpec;
  /** Sections that moved vs `options.previous`. Empty on the first revision. */
  changedSections: SpecChangedSection[];
  readiness: ReadinessResult;
  /**
   * The classified tier, or `undefined` when no rule matched.
   *
   * Undefined is a real answer and must be persisted as absent: the gate
   * substitutes `defaultRiskTier` for an absent tier, which applies the
   * two-person rule. A caller that filled this in with a guess would be
   * choosing a spec's supervision on no evidence.
   */
  riskTier?: string;
  /** Why the tier came out as it did — for the approval card and the audit trail. */
  riskClassification: SpecRiskClassification;
}

export function draftSpec(
  session: SpecSessionState,
  policy: SpecPolicy,
  options: {
    userOverride?: boolean;
    tasks?: SpecTaskBreakdownItem[];
    /**
     * The previous revision's section map, from `renderSpec` — never parsed
     * out of stored markdown. Absent on the first revision.
     */
    previous?: SpecRevisionSide;
  } = {},
): DraftedSpec {
  if (!session.targetRepoKey) {
    throw new Error(
      `Cannot draft spec ${session.specId}: no target repo. A spec is filed in the product repo it governs, ` +
        `so the repo has to be resolved before the document exists.`,
    );
  }

  const readiness = isReadyToDraft(session.coverage, readinessPolicyFrom(policy), options);
  machine.assertTransition(session.status, "DRAFT_READY");

  // Classified here, from the coverage record, because this is the one place a
  // spec becomes a document. Deriving the tier anywhere else would let the
  // stored frontmatter and the hashed body disagree about the same revision —
  // and `classifySpecRisk` is pure, so re-rendering unchanged answers still
  // produces an identical hash. That property is what stops a redraft creating
  // a spurious revision.
  const riskClassification = classifySpecRisk({ coverage: session.coverage, title: session.title }, policy);
  const riskTier = riskClassification.tier ?? undefined;

  const platforms = session.coverage.dimensions.platforms?.notes;
  const draftInput = {
    frontmatter: {
      specId: session.specId,
      title: session.title,
      status: "DRAFT_READY" as const,
      revision: session.revision,
      requestedBy: session.requestedBy,
      trackingRepoKey: session.targetRepoKey,
      codeRepoKey: session.targetRepoKey,
      platforms: platforms ? [platforms] : [],
      createdAt: session.createdAt,
      labels: [policy.output.labels.type, policy.output.labels.draft],
      ...(riskTier !== undefined ? { riskTier: riskTier as never } : {}),
    },
    coverage: session.coverage,
    ...(session.sections ? { sections: session.sections } : {}),
    blockingOpenQuestions: readiness.blockingOpenQuestions,
    ...(options.tasks ? { tasks: options.tasks } : {}),
  };

  // Diff the content sections only. The ledger is derived from that diff, so
  // including it would make every subsequent revision report itself as changed.
  const preliminary = renderSpec({ ...draftInput, omitLedger: true });
  const previousSections = options.previous
    ? options.previous.rendered.sections.filter((section) => section.id !== SPEC_REVISION_LEDGER_SECTION_ID)
    : [];
  const changedSections =
    options.previous !== undefined
      ? ledgerFromDiff(
          diffSpecRevisions(
            { rendered: { ...options.previous.rendered, sections: previousSections } },
            { rendered: preliminary },
          ),
        )
      : [];

  const rendered = renderSpec({
    ...draftInput,
    ledger: {
      changedSections,
      evidenceLinks: sanitizeEvidenceLinks(session.evidenceLinks ?? []),
      owners: sanitizeNamedOwners(session.owners ?? [requesterOwner(session.requestedBy)]),
      ...(session.approvedBy !== undefined
        ? { approvalAction: "approve", approvedAt: session.approvedAt }
        : {}),
    },
  });

  return {
    session: { ...session, status: "DRAFT_READY" },
    rendered,
    changedSections,
    readiness,
    ...(riskTier !== undefined ? { riskTier } : {}),
    riskClassification,
  };
}

export function submitForReview(session: SpecSessionState): SpecSessionState {
  machine.assertTransition(session.status, "IN_REVIEW");
  return { ...session, status: "IN_REVIEW" };
}

/**
 * Approval. Only ever reached from a human Slack interaction — `approve_spec`
 * is withheld from the model payload entirely, and the governance
 * authorization classes gate the actor. This function enforces the *lifecycle*
 * half: a spec nobody submitted cannot be approved.
 */
export function approveSession(
  session: SpecSessionState,
  actorSlackId: string,
  now: Date = new Date(),
): SpecSessionState {
  machine.assertTransition(session.status, "APPROVED");
  return { ...session, status: "APPROVED", approvedBy: actorSlackId, approvedAt: now.toISOString() };
}

/**
 * Sends a spec back for another pass. The coverage record survives on purpose:
 * a reviewer asking for a rollout plan should not cost the user the eight
 * questions they already answered.
 */
export function requestChanges(
  session: SpecSessionState,
  _actorSlackId: string,
  _reason: string,
): SpecSessionState {
  machine.assertTransition(session.status, "CHANGES_REQUESTED");
  machine.assertTransition("CHANGES_REQUESTED", "DRAFTING");
  return { ...session, status: "DRAFTING", revision: session.revision + 1 };
}

export function rejectSession(session: SpecSessionState): SpecSessionState {
  machine.assertTransition(session.status, "REJECTED");
  return { ...session, status: "REJECTED" };
}

export interface DerivedTask extends SpecTaskBreakdownItem {
  specId: string;
}

/**
 * Derives child work items from an approved spec — one per target code repo,
 * deterministically. This is the *skeleton* a human or a later model turn
 * refines; generating it in code means the common case costs nothing and
 * always produces the same rows for the same spec.
 */
export function deriveTaskBreakdown(
  session: SpecSessionState,
  args: { codeRepoKeys: string[]; kind?: SpecTaskBreakdownItem["kind"] },
): DerivedTask[] {
  return args.codeRepoKeys.map((codeRepoKey) => ({
    specId: session.specId,
    title: `${session.title} — ${codeRepoKey}`,
    kind: args.kind ?? "feature",
    codeRepoKey,
    ...(session.coverage.dimensions.acceptance_criteria?.notes
      ? { notes: session.coverage.dimensions.acceptance_criteria.notes }
      : {}),
  }));
}

export interface TaskBreakdownValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Structural validation before anything is created on a board.
 *
 * An empty breakdown is invalid rather than trivially valid: "we generated no
 * tasks" reported as success is how a spec ends up approved with nothing
 * scheduled against it.
 */
export function validateTaskBreakdown(tasks: SpecTaskBreakdownItem[]): TaskBreakdownValidation {
  const errors: string[] = [];

  if (tasks.length === 0) {
    errors.push("Task breakdown is empty — an approved spec with no tasks schedules no work.");
  }

  tasks.forEach((task, index) => {
    if (!task.title || task.title.trim().length === 0) {
      errors.push(`Task ${index}: title is required.`);
    }
    if (!task.codeRepoKey || task.codeRepoKey.trim().length === 0) {
      // Without a code repo there is nothing to dispatch against, and the task
      // would sit on the board as a permanent no-op.
      errors.push(`Task ${index}: codeRepoKey is required so the task can be dispatched.`);
    }
  });

  return { valid: errors.length === 0, errors };
}

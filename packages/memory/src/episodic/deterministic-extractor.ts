import type { MemoryEpisodeInput, MemoryEpisodeKind, MemoryEntityType } from "@lexi/contracts";

/**
 * Deterministic episodic extraction.
 *
 * This is a worked example of the deterministic-first rule:
 * "episodic-memory extraction from structured tool outcomes" is plain code,
 * zero LLM calls. A dispatch, an approval, an escalation and a correction are
 * all *structured events* — the turn already knows they happened, so asking a
 * model to notice them would be paying for information already in hand.
 *
 * This module is a pure synchronous function with no injected client, which
 * is the strongest available guarantee that no model is consulted: there is
 * nothing here to call one with.
 *
 * Free-text extraction, which genuinely needs judgement, is deliberately *not*
 * implemented here — policy `extraction.llmFreeText` is off, and when it is
 * turned on it belongs behind its own gate, off the fast path.
 */

/** One tool call, as the agent loop already records it. */
export interface TurnToolCall {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  result?: Record<string, unknown>;
}

/** A decision stated on the turn, already structured by the caller. */
export interface TurnDecision {
  decidedBy: string;
  statement: string;
}

/** Everything a finished turn knows about itself. */
export interface TurnOutcome {
  threadKey: string;
  actorUserId: string;
  toolCalls?: TurnToolCall[];
  decisions?: TurnDecision[];
  /**
   * DM-derived content is user-scoped whatever its kind.
   *
   * REQUIRED, and deliberately not optional. When it was optional, the only
   * runtime producer — the agent's turn-end writer — never passed it.
   * `undefined` took the `: "org"` branch of the ternary in `scopedEpisode`,
   * so every tool outcome derived from a DM was written to org-visible memory,
   * recallable by the whole workspace.
   *
   * The claim that the store catches this independently was false: the store's
   * `isDmDerived` reads `provenance.source`, which the same ternary had already
   * stamped `"channel"`. Both "independent" checks read one poisoned input, so
   * an omitted flag had no catch at any of the three layers.
   *
   * Required means a new producer cannot compile without deciding. Callers
   * derive it from the Slack channel id (`channel.startsWith("D")`), the same
   * convention the Slack handlers use.
   */
  isDirectMessage: boolean;
  /** A zero-LLM fast-path turn. */
  isFastPath?: boolean;
}

export interface ExtractionOptions {
  /** Policy `extraction.skipOnFastPath`. */
  skipOnFastPath?: boolean;
}

/**
 * How a tool's successful outcome is remembered.
 *
 * Only tools that *change something* appear here. Read-only tools are absent
 * by design: remembering every lookup would flood episodic memory, making
 * recall both less relevant and more expensive — the precise cost risk the
 * recall budget exists to prevent. A tool not in this table produces no episode.
 */
interface ExtractionRule {
  kind: MemoryEpisodeKind;
  /** Importance seed; recall blends this with relevance and recency. */
  importance: number;
  /** Human-readable summary of what happened. */
  describe(call: TurnToolCall): string;
}

const RULES: Record<string, ExtractionRule> = {
  process_issue: {
    kind: "outcome",
    importance: 0.6,
    describe: (call) => `processed issue #${num(call.arguments.issueNumber)}`,
  },
  reprocess_issue: {
    kind: "outcome",
    importance: 0.6,
    describe: (call) => `reprocessed issue #${num(call.arguments.issueNumber)}`,
  },
  trigger_code_task: {
    kind: "assignment",
    importance: 0.75,
    describe: (call) =>
      `dispatched a code task for #${num(call.arguments.issueNumber)}${assignee(call.arguments)}`,
  },
  trigger_direct_fix: {
    kind: "assignment",
    importance: 0.75,
    describe: (call) =>
      `dispatched a direct fix for #${num(call.arguments.issueNumber)}${assignee(call.arguments)}`,
  },
  create_pull_request: {
    kind: "outcome",
    importance: 0.7,
    describe: (call) => `opened PR #${num(call.arguments.pullNumber)}`,
  },
  add_to_project_board: {
    kind: "outcome",
    importance: 0.5,
    describe: (call) => `added #${num(call.arguments.issueNumber)} to the project board`,
  },
  update_project_board_status: {
    kind: "outcome",
    importance: 0.5,
    describe: (call) =>
      `moved #${num(call.arguments.issueNumber)} to ${str(call.arguments.status) || "a new column"}`,
  },
  request_keep_open: {
    kind: "decision",
    importance: 0.7,
    describe: (call) =>
      `kept #${num(call.arguments.issueNumber)} open: ${str(call.arguments.reason) || "no reason given"}`,
  },
  cancel_pending_closure: {
    kind: "decision",
    importance: 0.7,
    describe: (call) => `cancelled the pending closure of #${num(call.arguments.issueNumber)}`,
  },
  record_correction: {
    // A human correcting Lexi is ground truth that contradicts something Lexi
    // believed — the single most valuable thing a turn can produce.
    kind: "fact",
    importance: 0.9,
    describe: (call) =>
      `correction on #${num(call.arguments.issueNumber)}: ${str(call.arguments.correction)}`,
  },
};

/**
 * Which entity a tool's episode hangs off. PR-shaped tools point at the PR;
 * everything else points at the issue it acted on.
 */
function resolveEntity(call: TurnToolCall): { entityType?: MemoryEntityType; entityId?: string } {
  const pull = num(call.arguments.pullNumber);
  if (pull) return { entityType: "pull_request", entityId: pull };

  const issue = num(call.arguments.issueNumber);
  if (issue) return { entityType: "issue", entityId: issue };

  return {};
}

/**
 * Turns a finished turn into the episodes worth keeping. Pure, synchronous,
 * and free.
 */
export function extractEpisodes(outcome: TurnOutcome, options: ExtractionOptions = {}): MemoryEpisodeInput[] {
  // A fast-path turn costs nothing by design. Attaching a memory
  // write to it would quietly make the free path not free.
  if (outcome.isFastPath && options.skipOnFastPath) return [];

  const episodes: MemoryEpisodeInput[] = [];

  for (const decision of outcome.decisions ?? []) {
    episodes.push(
      scopedEpisode(outcome, {
        kind: "decision",
        content: decision.statement,
        importance: 0.8,
        provenance: { actor: decision.decidedBy, source: turnSource(outcome) },
      }),
    );
  }

  for (const call of outcome.toolCalls ?? []) {
    // An attempt is not a fact. Only what actually happened is remembered.
    if (!call.ok) continue;

    const rule = RULES[call.name];
    if (!rule) continue;

    episodes.push(
      scopedEpisode(outcome, {
        kind: rule.kind,
        content: rule.describe(call),
        importance: rule.importance,
        ...resolveEntity(call),
        provenance: {
          tool: call.name,
          actor: outcome.actorUserId,
          source: turnSource(outcome),
        },
      }),
    );
  }

  return dedupe(episodes);
}

/**
 * Is this turn's content private to one person?
 *
 * The single source of truth for that question, because `scope` and
 * `provenance.source` must never disagree: the store's own DM check reads
 * provenance, so a turn stamped `scope: "user"` but `source: "channel"` would
 * be re-widened by the very layer meant to catch the mistake.
 *
 * Fails closed. Only an explicit `false` means "shared" — `undefined` reaching
 * here past the required type (an untyped caller, a JSON boundary, a `as any`)
 * is treated as private. Over-restricting hides a fact from a teammate, which
 * is recoverable; under-restricting discloses a DM to the workspace, which is
 * not.
 */
function isPrivateTurn(outcome: TurnOutcome): boolean {
  return outcome.isDirectMessage !== false;
}

/**
 * The provenance marker matching `isPrivateTurn`, in the vocabulary the store's
 * `isDmDerived` recognises. Derived from the same predicate so the two can only
 * ever agree.
 */
function turnSource(outcome: TurnOutcome): "dm" | "channel" {
  return isPrivateTurn(outcome) ? "dm" : "channel";
}

/**
 * Applies the visibility decision the *turn* knows about: content produced in
 * a DM belongs to the person in that DM.
 *
 * Both the scope and the provenance marker come from `isPrivateTurn`, so the
 * store's independent re-derivation reads a marker that actually agrees with
 * the scope rather than one stamped by the same defaulted ternary.
 */
function scopedEpisode(
  outcome: TurnOutcome,
  episode: Omit<MemoryEpisodeInput, "scope" | "threadKey">,
): MemoryEpisodeInput {
  const private_ = isPrivateTurn(outcome);
  return {
    ...episode,
    scope: private_ ? "user" : "org",
    ...(private_ ? { subjectUserId: outcome.actorUserId } : {}),
    threadKey: outcome.threadKey,
  };
}

/** A tool called twice with the same arguments happened once, memorably. */
function dedupe(episodes: MemoryEpisodeInput[]): MemoryEpisodeInput[] {
  const seen = new Set<string>();
  return episodes.filter((episode) => {
    const key = `${episode.kind}|${episode.entityType ?? ""}|${episode.entityId ?? ""}|${episode.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function num(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return "";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function assignee(args: Record<string, unknown>): string {
  const who = str(args.assignee) || str(args.assigneeGithub) || str(args.owner);
  return who ? ` (assigned to ${who})` : "";
}

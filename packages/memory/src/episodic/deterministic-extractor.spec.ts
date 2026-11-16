import { describe, it, expect } from "vitest";
import { extractEpisodes, type TurnOutcome } from "./deterministic-extractor";

/**
 * Deterministic episodic extraction.
 *
 * "Episodic-memory extraction from structured tool outcomes" is a worked
 * example of the deterministic-first rule: tool outcomes, approvals,
 * assignments and escalations are structured events, not inferences, so no
 * model is called to notice them.
 */

function outcome(overrides: Partial<TurnOutcome> = {}): TurnOutcome {
  return {
    threadKey: "C1:1.0",
    actorUserId: "U1",
    toolCalls: [],
    // Explicit, because the scope rule now fails closed. This helper used to
    // omit it and every test below inherited the old `undefined -> "org"`
    // default; a channel turn has to say so.
    isDirectMessage: false,
    ...overrides,
  };
}

describe("extractEpisodes — determinism", () => {
  it("is synchronous — it cannot be awaiting a model", () => {
    // The strongest available proof of "zero LLM calls": the function has no
    // async surface to make a network call through, and no client to make it
    // with. A future refactor that reaches for a model breaks this test.
    const result = extractEpisodes(
      outcome({ toolCalls: [{ name: "process_issue", arguments: { issueNumber: 101 }, ok: true }] }),
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("produces identical output for identical input", () => {
    const input = outcome({
      toolCalls: [{ name: "trigger_code_task", arguments: { issueNumber: 101, assignee: "dev1" }, ok: true }],
    });
    expect(extractEpisodes(input)).toEqual(extractEpisodes(input));
  });
});

describe("extractEpisodes — what is worth remembering", () => {
  it("records a successful governed write as an outcome", () => {
    const episodes = extractEpisodes(
      outcome({ toolCalls: [{ name: "process_issue", arguments: { issueNumber: 101 }, ok: true }] }),
    );
    expect(episodes).toHaveLength(1);
    expect(episodes[0].kind).toBe("outcome");
    expect(episodes[0].scope).toBe("org");
    expect(episodes[0].entityType).toBe("issue");
    expect(episodes[0].entityId).toBe("101");
  });

  it("ignores read-only tools entirely", () => {
    // Remembering every lookup would flood episodic memory and make recall
    // both worse and more expensive — the exact cost risk the recall budget exists to prevent.
    const episodes = extractEpisodes(
      outcome({
        toolCalls: [
          { name: "search_issues", arguments: { q: "deposit" }, ok: true },
          { name: "get_issue_context", arguments: { issueNumber: 101 }, ok: true },
          { name: "query_issues", arguments: {}, ok: true },
        ],
      }),
    );
    expect(episodes).toEqual([]);
  });

  it("ignores a failed tool call — an attempt is not a fact", () => {
    const episodes = extractEpisodes(
      outcome({ toolCalls: [{ name: "process_issue", arguments: { issueNumber: 101 }, ok: false }] }),
    );
    expect(episodes).toEqual([]);
  });

  it("classifies a dispatch as an assignment and captures the assignee", () => {
    const episodes = extractEpisodes(
      outcome({ toolCalls: [{ name: "trigger_code_task", arguments: { issueNumber: 101, assignee: "dev1" }, ok: true }] }),
    );
    expect(episodes[0].kind).toBe("assignment");
    expect(episodes[0].content).toContain("dev1");
  });

  it("classifies a keep-open request as a decision", () => {
    const episodes = extractEpisodes(
      outcome({ toolCalls: [{ name: "request_keep_open", arguments: { issueNumber: 101, reason: "still reproducing" }, ok: true }] }),
    );
    expect(episodes[0].kind).toBe("decision");
    expect(episodes[0].content).toContain("still reproducing");
  });

  it("treats a human correction as a high-importance fact", () => {
    // A human correcting Lexi is the most valuable thing in a turn: it is
    // ground truth that contradicts something Lexi believed.
    const episodes = extractEpisodes(
      outcome({
        toolCalls: [
          { name: "record_correction", arguments: { issueNumber: 101, correction: "root cause is the balance cache" }, ok: true },
        ],
      }),
    );
    expect(episodes[0].kind).toBe("fact");
    expect(episodes[0].importance).toBeGreaterThan(0.7);
    expect(episodes[0].content).toContain("balance cache");
  });

  it("records a PR as a pull_request entity, not an issue", () => {
    const episodes = extractEpisodes(
      outcome({ toolCalls: [{ name: "create_pull_request", arguments: { pullNumber: 42, issueNumber: 101 }, ok: true }] }),
    );
    expect(episodes[0].entityType).toBe("pull_request");
    expect(episodes[0].entityId).toBe("42");
  });

  it("carries thread, actor and tool provenance on every episode", () => {
    const episodes = extractEpisodes(
      outcome({ toolCalls: [{ name: "process_issue", arguments: { issueNumber: 101 }, ok: true }] }),
    );
    expect(episodes[0].threadKey).toBe("C1:1.0");
    expect(episodes[0].provenance).toMatchObject({ tool: "process_issue", actor: "U1" });
  });

  it("extracts explicit decisions stated on the turn", () => {
    const episodes = extractEpisodes(
      outcome({ decisions: [{ decidedBy: "U1", statement: "we agreed to ship behind a flag" }] }),
    );
    expect(episodes).toHaveLength(1);
    expect(episodes[0].kind).toBe("decision");
    expect(episodes[0].scope).toBe("org");
  });

  it("scopes everything from a DM to the actor", () => {
    // Policy `visibility.dmDerivedIsUserScoped`. The extractor marks
    // provenance; the store enforces the scope. Both, so neither is a single
    // point of failure.
    const episodes = extractEpisodes(
      outcome({
        isDirectMessage: true,
        toolCalls: [{ name: "process_issue", arguments: { issueNumber: 101 }, ok: true }],
      }),
    );
    expect(episodes[0].scope).toBe("user");
    expect(episodes[0].subjectUserId).toBe("U1");
    expect(episodes[0].provenance).toMatchObject({ source: "dm" });
  });

  /**
   * Regression guard. `isDirectMessage` used to be optional and the only
   * runtime producer never passed it, so `undefined` took the `: "org"` branch
   * and every DM-derived outcome was written to workspace-visible memory.
   *
   * The three-layer defence did not catch it: the store's `isDmDerived` reads
   * `provenance.source`, which the same defaulted ternary had already stamped
   * `"channel"`. Two of the three layers were reading one poisoned input.
   *
   * The type now makes omission a compile error, so this asserts the runtime
   * half — an omission that gets past the type (untyped caller, JSON boundary,
   * `as any`) must fail closed to private rather than open to the workspace.
   */
  it("fails closed to private when the channel type is missing entirely", () => {
    const undeclared = {
      threadKey: "C1:1.0",
      actorUserId: "U1",
      toolCalls: [{ name: "process_issue", arguments: { issueNumber: 101 }, ok: true }],
    } as unknown as TurnOutcome;

    const episodes = extractEpisodes(undeclared);

    expect(episodes).toHaveLength(1);
    expect(episodes[0].scope).toBe("user");
    expect(episodes[0].subjectUserId).toBe("U1");
    // Must agree with the scope, or the store re-widens what this narrowed.
    expect(episodes[0].provenance).toMatchObject({ source: "dm" });
  });

  it("keeps scope and provenance.source in agreement for every episode", () => {
    // These two disagreeing is the actual disclosure mechanism: the store
    // re-derives visibility from provenance, so `scope: "user"` paired with
    // `source: "channel"` would be widened back to org by the layer meant to
    // be the safety net.
    for (const isDirectMessage of [true, false]) {
      const episodes = extractEpisodes(
        outcome({
          isDirectMessage,
          decisions: [{ decidedBy: "U1", statement: "we agreed to ship behind a flag" }],
          toolCalls: [{ name: "process_issue", arguments: { issueNumber: 101 }, ok: true }],
        }),
      );

      expect(episodes.length).toBeGreaterThan(0);
      for (const episode of episodes) {
        const expected = isDirectMessage ? { scope: "user", source: "dm" } : { scope: "org", source: "channel" };
        expect(episode.scope).toBe(expected.scope);
        expect(episode.provenance).toMatchObject({ source: expected.source });
      }
    }
  });

  it("returns nothing for a turn that did nothing", () => {
    expect(extractEpisodes(outcome())).toEqual([]);
  });

  it("deduplicates identical repeated outcomes within one turn", () => {
    const episodes = extractEpisodes(
      outcome({
        toolCalls: [
          { name: "process_issue", arguments: { issueNumber: 101 }, ok: true },
          { name: "process_issue", arguments: { issueNumber: 101 }, ok: true },
        ],
      }),
    );
    expect(episodes).toHaveLength(1);
  });

  it("skips extraction on the fast path when the policy says so", () => {
    // Policy `extraction.skipOnFastPath`: a zero-LLM fast-path turn
    // must not acquire a memory write and stop being free.
    const episodes = extractEpisodes(
      outcome({ isFastPath: true, toolCalls: [{ name: "process_issue", arguments: { issueNumber: 101 }, ok: true }] }),
      { skipOnFastPath: true },
    );
    expect(episodes).toEqual([]);
  });
});

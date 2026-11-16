import { describe, it, expect } from "vitest";
import type { ThreadState, TurnDigest } from "@lexi/contracts";
import {
  classifyDigestProtection,
  partitionForCompaction,
  promoteProtected,
  withAttribution,
  UNATTRIBUTED,
} from "./protected-content";

/**
 * What compaction may not paraphrase.
 *
 * Two failure directions are tested, and they are not symmetric:
 *
 *  - A **false negative** hands an approval to a summariser. That is the whole
 *    reason this module exists, so most tests here are "this phrasing is
 *    recognised".
 *  - A **false positive** promotes ordinary chatter into `decisions`, which
 *    `renderThreadState` may not drop — so it crowds out the decisions that
 *    belong there and pushes the block into its shortening path. Cheaper than
 *    a false negative, but not free, hence the negative cases below.
 */

function digest(summary: string, index = 0): TurnDigest {
  return {
    turnId: `t${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 15) - index * 60_000).toISOString(),
    summary,
    entities: [],
    tokenCost: Math.ceil(summary.length / 4),
    superseded: false,
  };
}

function state(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    threadKey: "C1:1.0",
    entities: [],
    digests: [],
    openQuestions: [],
    decisions: [],
    tokenCost: 0,
    ...overrides,
  };
}

describe("classifyDigestProtection — authorization state", () => {
  it.each([
    "asked: ship it — did: U9 approved the direct fix for #101",
    "asked: can I force-push — did: request authorised by the release manager",
    "asked: proceed? — did: the change was denied by the reviewer",
    "asked: do it anyway — did: overrode the ownership gate",
    "asked: who signs this off — did: escalated to the platform team",
  ])("protects %j", (summary) => {
    expect(classifyDigestProtection(digest(summary))).toBe("authorization");
  });
});

describe("classifyDigestProtection — mission completion state", () => {
  it.each([
    "asked: is it out — did: PR #203 merged",
    "asked: fix the deposit bug — did: dispatched a direct fix for #101",
    "asked: open one — did: opened PR #203",
    "asked: undo it — did: reverted the cache change",
    "asked: actually it's Android — did: correction on #101: the platform is Android, not iOS",
  ])("protects %j", (summary) => {
    expect(classifyDigestProtection(digest(summary))).toBe("completion");
  });
});

describe("classifyDigestProtection — pending destructive decisions", () => {
  it.each([
    "asked: can we close it — did: awaiting approval from the issue owner",
    "asked: keep it open — did: kept #101 open: still reproducing on 1.14",
    "asked: never mind — did: cancelled the pending closure of #101",
    "asked: clean up — did: blocked on sign-off before we delete the branch",
  ])("protects %j", (summary) => {
    expect(classifyDigestProtection(digest(summary))).toBe("pending_destructive");
  });
});

describe("classifyDigestProtection — what it leaves alone", () => {
  it.each([
    "asked: what's the status of the deposit button — did: read the issue",
    "asked: how many open bugs are there — did: counted 12",
    "turn 4 with a moderate amount of detail in it",
    "asked: which platform is affected",
    "",
    "   ",
  ])("does not protect %j", (summary) => {
    expect(classifyDigestProtection(digest(summary))).toBeNull();
  });

  it("does not fire on the substring of an unrelated word", () => {
    // "approved" must not be matched inside "unapprovedly", and "merged" not
    // inside "submerged" — a bare substring test would promote both.
    expect(classifyDigestProtection(digest("asked: the submerged log line"))).toBeNull();
  });
});

describe("partitionForCompaction", () => {
  it("keeps protected digests out of the lossy half", () => {
    const digests = [
      digest("asked: status — did: read the issue", 0),
      digest("asked: ship it — did: U9 approved the direct fix", 1),
      digest("asked: anything else — did: nothing", 2),
    ];

    const { lossy, guarded } = partitionForCompaction(digests);

    expect(lossy.map((d) => d.turnId)).toEqual(["t0", "t2"]);
    expect(guarded).toHaveLength(1);
    expect(guarded[0].reason).toBe("authorization");
  });

  it("preserves newest-first order within each half", () => {
    // The buffer dates its summary digest from the oldest member of the lossy
    // half, which is only its tail if order survives partitioning.
    const digests = [digest("plain a", 0), digest("plain b", 1), digest("plain c", 2)];
    expect(partitionForCompaction(digests).lossy.map((d) => d.turnId)).toEqual(["t0", "t1", "t2"]);
  });
});

describe("promoteProtected", () => {
  it("routes settled facts to decisions and pending ones to open questions", () => {
    const guarded = partitionForCompaction([
      digest("(U0TEST09) approved the direct fix for #101", 0),
      digest("awaiting approval before we delete the branch", 1),
    ]).guarded;

    const { state: next, promoted } = promoteProtected(state(), guarded);

    expect(promoted).toBe(2);
    expect(next.decisions).toHaveLength(1);
    expect(next.decisions[0].statement).toBe("approved the direct fix for #101");
    expect(next.openQuestions).toEqual(["awaiting approval before we delete the branch"]);
  });

  it("attributes a promoted decision to the actor the producer recorded", () => {
    const guarded = partitionForCompaction([digest("(U0TEST09) approved the force-push")]).guarded;
    const { state: next } = promoteProtected(state(), guarded);

    expect(next.decisions[0].decidedBy).toBe("U0TEST09");
    // The prefix is consumed, not left in the rendered statement.
    expect(next.decisions[0].statement).toBe("approved the force-push");
  });

  it("marks an unattributed promotion as such rather than inventing an actor", () => {
    const guarded = partitionForCompaction([digest("approved the force-push")]).guarded;
    const { state: next } = promoteProtected(state(), guarded);

    expect(next.decisions[0].decidedBy).toBe(UNATTRIBUTED);
    expect(next.decisions[0].decidedBy).not.toMatch(/^U/);
  });

  it("dates a promoted decision to the turn it happened on, not to the compaction", () => {
    const source = digest("(U0TEST09) approved the direct fix", 5);
    const { state: next } = promoteProtected(state(), [{ digest: source, reason: "authorization" }]);
    expect(next.decisions[0].createdAt).toBe(source.createdAt);
  });

  it("is idempotent, so repeated compactions converge instead of accumulating", () => {
    const guarded = partitionForCompaction([digest("(U0TEST09) approved the direct fix for #101")]).guarded;

    const first = promoteProtected(state(), guarded);
    const second = promoteProtected(first.state, guarded);

    expect(first.promoted).toBe(1);
    expect(second.promoted).toBe(0);
    expect(second.state.decisions).toHaveLength(1);
  });

  it("dedupes against a decision the turn-end writer already recorded", () => {
    // The two producers must agree that this is one fact — differing case and
    // spacing are the realistic ways they disagree.
    const existing = state({
      decisions: [
        { id: "d1", createdAt: "2026-08-15T00:00:00.000Z", decidedBy: "U0TEST09", statement: "Approved  the direct fix" },
      ],
    });
    const guarded = partitionForCompaction([digest("(U0TEST09) approved the direct fix")]).guarded;

    const { promoted, state: next } = promoteProtected(existing, guarded);

    expect(promoted).toBe(0);
    expect(next.decisions).toHaveLength(1);
  });

  it("promotes oldest-first so the record reads chronologically", () => {
    // The digest buffer is newest-first; promoted entries must not be.
    const guarded = partitionForCompaction([
      digest("(U0TEST09) approved the second thing", 0),
      digest("(U0TEST09) approved the first thing", 1),
    ]).guarded;

    const { state: next } = promoteProtected(state(), guarded);
    expect(next.decisions.map((d) => d.statement)).toEqual([
      "approved the first thing",
      "approved the second thing",
    ]);
  });

  it("returns the original state untouched when there is nothing to promote", () => {
    const original = state();
    const result = promoteProtected(original, []);
    expect(result.state).toBe(original);
    expect(result.promoted).toBe(0);
  });
});

describe("withAttribution", () => {
  it("prefixes a real Slack id", () => {
    expect(withAttribution("U0TEST09", "approved the fix")).toBe("(U0TEST09) approved the fix");
  });

  it("leaves the summary alone for anything that is not a Slack id", () => {
    // A bot name or an email in this position would be read back as an actor
    // id by promotion, which is worse than no attribution at all.
    expect(withAttribution("lexi@example.com", "approved the fix")).toBe("approved the fix");
    expect(withAttribution(undefined, "approved the fix")).toBe("approved the fix");
  });

  it("round-trips through promotion", () => {
    const summary = withAttribution("U12345", "approved the direct fix");
    const { state: next } = promoteProtected(state(), [
      { digest: digest(summary), reason: "authorization" },
    ]);
    expect(next.decisions[0]).toMatchObject({ decidedBy: "U12345", statement: "approved the direct fix" });
  });
});

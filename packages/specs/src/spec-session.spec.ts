import { describe, it, expect } from "vitest";
import { COVERAGE_DIMENSIONS } from "./coverage-dimensions";
import { loadSpecPolicy } from "./load-spec-policy";
import {
  advanceSpecSession,
  applyAnswers,
  approveSession,
  deriveTaskBreakdown,
  draftSpec,
  requestChanges,
  startSpecSession,
  submitForReview,
  validateTaskBreakdown,
} from "./spec-session";

/**
 * The clarification loop end to end: a vague feature request produces
 * clarification rounds -> coverage complete -> a drafted spec -> human
 * approval -> child work items.
 *
 * The session object is pure state; persistence (`SpecSession`,
 * `SpecDocument`) is the caller's job. That keeps the loop testable without a
 * database and keeps the stop condition provably free of I/O.
 */

const POLICY = loadSpecPolicy();

function answerEverything() {
  return Object.fromEntries(
    COVERAGE_DIMENSIONS.map((dimension) => [dimension, { answer: `answer for ${dimension}`, confidence: 1 }]),
  );
}

describe("starting a session", () => {
  it("opens in DRAFTING with every dimension unknown", () => {
    const session = startSpecSession({
      threadKey: "C1:1.1",
      requestedBy: "U1",
      title: "Make deposits retry",
      targetRepoKey: "home_mobile",
    });

    expect(session.status).toBe("DRAFTING");
    expect(session.coverage.questionTurns).toBe(0);
    expect(Object.keys(session.coverage.dimensions)).toHaveLength(COVERAGE_DIMENSIONS.length);
  });

  it("seeds coverage from what the opening request already said", () => {
    // "Mine thread, corpus and code before asking the human anything":
    // re-asking something the user just told you is the fastest way to make a
    // clarification loop feel like an interrogation.
    const session = startSpecSession({
      threadKey: "C1:1.1",
      requestedBy: "U1",
      title: "Make deposits retry",
      targetRepoKey: "home_mobile",
      seed: { problem: { answer: "deposits fail silently", confidence: 0.9 } },
    });

    expect(session.coverage.dimensions.problem?.state).toBe("COVERED");
    expect(session.coverage.dimensions.problem?.evidence).toBe("thread");
  });

  it("keeps a real Slack permalink as an evidence link and drops \"thread\"", () => {
    const session = startSpecSession({
      threadKey: "C1:1.1",
      requestedBy: "U1",
      title: "Make deposits retry",
      evidenceLinks: [
        { href: "thread", label: "Slack thread" },
        { href: "https://acme.slack.com/archives/C1/p123", label: "Slack thread", kind: "slack_thread" },
      ],
    });

    expect(session.evidenceLinks).toEqual([
      { href: "https://acme.slack.com/archives/C1/p123", label: "Slack thread", kind: "slack_thread" },
    ]);
    expect(session.owners).toEqual([{ role: "requester", name: "U1", slackUserId: "U1" }]);
  });

  it("omits the evidence link when the caller has no permalink", () => {
    const session = startSpecSession({
      threadKey: "C1:1.1",
      requestedBy: "U1",
      title: "Make deposits retry",
      evidenceLinks: [{ href: "thread" }],
    });

    expect(session.evidenceLinks).toBeUndefined();
  });
});

describe("the clarification loop", () => {
  it("asks a batch while coverage is incomplete", () => {
    const session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "x" });
    const step = advanceSpecSession(session, POLICY);

    expect(step.kind).toBe("ask");
    if (step.kind !== "ask") throw new Error("expected ask");
    expect(step.batch.questions.length).toBeGreaterThanOrEqual(2);
    expect(step.batch.questions.length).toBeLessThanOrEqual(4);
  });

  it("counts a question turn each time answers come back", () => {
    let session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "x" });
    session = applyAnswers(session, { problem: { answer: "deposits fail", confidence: 1 } });

    expect(session.coverage.questionTurns).toBe(1);
    expect(session.coverage.dimensions.problem?.state).toBe("COVERED");
  });

  it("records a partial answer as PARTIAL rather than covered", () => {
    let session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "x" });
    session = applyAnswers(session, { scope: { answer: "not sure yet", confidence: 0.3 } });

    expect(session.coverage.dimensions.scope?.state).toBe("PARTIAL");
  });

  it("honours an explicit deferral from the user", () => {
    let session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "x" });
    session = applyAnswers(session, { risks: { defer: "accepted for v1" } });

    expect(session.coverage.dimensions.risks?.state).toBe("EXPLICITLY_DEFERRED");
  });

  it("becomes ready once every mandatory dimension is answered", () => {
    let session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "x" });
    session = applyAnswers(session, answerEverything());

    const step = advanceSpecSession(session, POLICY);

    expect(step.kind).toBe("draft");
    if (step.kind !== "draft") throw new Error("expected draft");
    expect(step.readiness.reason).toBe("coverage_complete");
  });

  it("drafts anyway at the question cap, carrying the gaps forward", () => {
    let session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "x" });
    for (let i = 0; i < POLICY.coverage.maxQuestionTurns; i += 1) {
      session = applyAnswers(session, {});
    }

    const step = advanceSpecSession(session, POLICY);

    expect(step.kind).toBe("draft");
    if (step.kind !== "draft") throw new Error("expected draft");
    expect(step.readiness.reason).toBe("question_turn_cap");
    expect(step.readiness.blockingOpenQuestions.length).toBeGreaterThan(0);
  });

  it("drafts on demand when the user says just draft it", () => {
    const session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "x" });
    const step = advanceSpecSession(session, POLICY, { userOverride: true });

    expect(step.kind).toBe("draft");
    if (step.kind !== "draft") throw new Error("expected draft");
    expect(step.readiness.reason).toBe("user_override");
  });

  it("never re-asks across turns", () => {
    let session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "x" });
    const askedTwice: string[] = [];
    const seen = new Set<string>();

    for (let turn = 0; turn < 4; turn += 1) {
      const step = advanceSpecSession(session, POLICY);
      if (step.kind !== "ask") break;

      for (const question of step.batch.questions) {
        if (seen.has(question.dimension)) askedTwice.push(question.dimension);
        seen.add(question.dimension);
      }

      session = applyAnswers(
        session,
        Object.fromEntries(
          step.batch.questions.map((q) => [q.dimension, { answer: `answer ${q.dimension}`, confidence: 1 }]),
        ),
      );
    }

    expect(askedTwice).toEqual([]);
  });
});

describe("drafting", () => {
  it("moves DRAFTING -> DRAFT_READY and renders the document", () => {
    let session = startSpecSession({
      threadKey: "C1:1.1",
      requestedBy: "U1",
      title: "Deposit retry",
      targetRepoKey: "home_mobile",
    });
    session = applyAnswers(session, answerEverything());

    const drafted = draftSpec(session, POLICY);

    expect(drafted.session.status).toBe("DRAFT_READY");
    expect(drafted.session.revision).toBe(1);
    expect(drafted.rendered.body).toContain("# Deposit retry");
    expect(drafted.rendered.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(drafted.changedSections).toEqual([]);
    expect(drafted.rendered.body).toContain("## Revision ledger");
    expect(drafted.rendered.body).toContain("**Specification version:** 1");
    expect(drafted.rendered.body).toContain("_None (first revision)._");
  });

  it("records changed sections on a subsequent revision against the previous render", () => {
    let session = startSpecSession({
      threadKey: "C1:1.1",
      requestedBy: "U1",
      title: "Deposit retry",
      targetRepoKey: "home_mobile",
    });
    session = applyAnswers(session, {
      ...answerEverything(),
      problem: { answer: "deposits fail", confidence: 1 },
    });
    const first = draftSpec(session, POLICY);

    session = applyAnswers(
      { ...first.session, status: "DRAFTING", revision: 2 },
      { problem: { answer: "deposits fail silently on retry", confidence: 1 } },
    );
    const second = draftSpec(session, POLICY, { previous: { rendered: first.rendered } });

    expect(second.changedSections.find((s) => s.id === "problem")).toEqual({
      id: "problem",
      heading: "Problem",
      kind: "changed",
    });
    expect(second.rendered.body).toContain("Problem (changed)");
    expect(second.changedSections.every((s) => s.id !== "revision_ledger")).toBe(true);
  });

  it("puts the answers into the document", () => {
    let session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "x", targetRepoKey: "home_mobile" });
    session = applyAnswers(session, { problem: { answer: "deposits fail silently", confidence: 1 } });

    const drafted = draftSpec(session, POLICY);

    expect(drafted.rendered.body).toContain("deposits fail silently");
  });

  it("carries blocking open questions into a forced draft", () => {
    const session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "x", targetRepoKey: "home_mobile" });
    const drafted = draftSpec(session, POLICY, { userOverride: true });

    expect(drafted.rendered.body).toContain("**BLOCKING**");
  });

  it("refuses to draft without a target repo — a spec has to have a home", () => {
    let session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "x" });
    session = applyAnswers(session, answerEverything());

    expect(() => draftSpec(session, POLICY)).toThrow(/target repo/i);
  });
});

describe("review and approval", () => {
  function readySession() {
    let session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "x", targetRepoKey: "home_mobile" });
    session = applyAnswers(session, answerEverything());
    return draftSpec(session, POLICY).session;
  }

  it("submits a draft for review", () => {
    expect(submitForReview(readySession()).status).toBe("IN_REVIEW");
  });

  it("approves a spec that is in review, recording who approved it", () => {
    const approved = approveSession(submitForReview(readySession()), "U2");

    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedBy).toBe("U2");
    expect(approved.approvedAt).toBeDefined();
  });

  it("refuses to approve a spec that was never submitted", () => {
    // The state machine, not a convention: skipping review is exactly the move
    // an eager caller makes when a spec looks obviously fine.
    expect(() => approveSession(readySession(), "U2")).toThrow(/Invalid spec transition/);
  });

  it("returns a changes-requested spec to drafting and bumps the revision", () => {
    const inReview = submitForReview(readySession());
    const changed = requestChanges(inReview, "U2", "needs a rollout plan");

    expect(changed.status).toBe("DRAFTING");
    expect(changed.revision).toBe(2);
  });

  it("keeps the coverage answers across a changes-requested round trip", () => {
    const inReview = submitForReview(readySession());
    const changed = requestChanges(inReview, "U2", "needs a rollout plan");

    expect(changed.coverage.dimensions.problem?.state).toBe("COVERED");
  });
});

describe("task breakdown", () => {
  it("derives one task per platform in scope", () => {
    let session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "Deposit retry", targetRepoKey: "home_mobile" });
    session = applyAnswers(session, answerEverything());

    const tasks = deriveTaskBreakdown(session, { codeRepoKeys: ["home_mobile", "home_web"] });

    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.codeRepoKey)).toEqual(["home_mobile", "home_web"]);
    expect(tasks[0].kind).toBe("feature");
  });

  it("titles tasks from the spec so a board row is readable on its own", () => {
    let session = startSpecSession({ threadKey: "C1:1.1", requestedBy: "U1", title: "Deposit retry", targetRepoKey: "home_mobile" });
    session = applyAnswers(session, answerEverything());

    const tasks = deriveTaskBreakdown(session, { codeRepoKeys: ["home_mobile"] });

    expect(tasks[0].title).toContain("Deposit retry");
  });

  it("rejects a task with no code repo — nothing can be dispatched from it", () => {
    const result = validateTaskBreakdown([{ title: "Do the thing", kind: "feature" }]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/codeRepoKey/);
  });

  it("rejects an untitled task", () => {
    const result = validateTaskBreakdown([{ title: "   ", kind: "chore", codeRepoKey: "home_web" }]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/title/);
  });

  it("rejects an empty breakdown rather than reporting success on nothing", () => {
    expect(validateTaskBreakdown([]).valid).toBe(false);
  });

  it("accepts a well-formed breakdown", () => {
    const result = validateTaskBreakdown([
      { title: "Add retry to the deposit client", kind: "feature", codeRepoKey: "home_mobile" },
    ]);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("end to end", () => {
  it("takes a vague request through clarification, draft, approval and tasks", () => {
    let session = startSpecSession({
      threadKey: "C1:1.1",
      requestedBy: "U1",
      title: "make deposits better",
      targetRepoKey: "home_mobile",
    });

    let rounds = 0;
    for (;;) {
      const step = advanceSpecSession(session, POLICY);
      if (step.kind === "draft") break;

      rounds += 1;
      session = applyAnswers(
        session,
        Object.fromEntries(
          step.batch.questions.map((q) => [q.dimension, { answer: `answer for ${q.dimension}`, confidence: 1 }]),
        ),
      );
    }

    // Clarification actually happened, and finished inside the cap.
    expect(rounds).toBeGreaterThan(0);
    expect(rounds).toBeLessThanOrEqual(POLICY.coverage.maxQuestionTurns);

    const drafted = draftSpec(session, POLICY);
    expect(drafted.session.status).toBe("DRAFT_READY");

    const approved = approveSession(submitForReview(drafted.session), "U2");
    expect(approved.status).toBe("APPROVED");

    const tasks = deriveTaskBreakdown(approved, { codeRepoKeys: ["home_mobile"] });
    expect(validateTaskBreakdown(tasks).valid).toBe(true);
    expect(tasks[0].specId).toBe(approved.specId);
  });
});

/**
 * Classification happens at draft time.
 *
 * The tier is a function of the coverage record, so `draftSpec` is the only
 * place it can be computed once and stamped into the document that gets
 * hashed. Computing it anywhere else would let the stored frontmatter and the
 * hashed body disagree about the tier of the same revision.
 */
describe("risk tier stamped at draft time", () => {
  function sessionAnswering(answers: Record<string, { answer: string; confidence: number }>) {
    const session = startSpecSession({
      threadKey: "C1:1.1",
      requestedBy: "U1",
      title: "A change",
      targetRepoKey: "home_mobile",
      now: new Date("2026-08-16T00:00:00.000Z"),
    });
    return applyAnswers(session, { ...answerEverything(), ...answers } as never);
  }

  it("classifies from coverage and stamps the tier into the frontmatter", () => {
    const session = sessionAnswering({
      problem: { answer: "Withdrawal to bank fails at the payout step.", confidence: 1 },
    });

    const drafted = draftSpec(session, POLICY);

    expect(drafted.riskTier).toBe("critical");
    expect(drafted.rendered.body).toContain("riskTier: critical");
  });

  it("leaves the tier absent when nothing classifies, so the gate defaults strictly", () => {
    const session = sessionAnswering({});

    const drafted = draftSpec(session, POLICY);

    expect(drafted.riskTier).toBeUndefined();
    expect(drafted.rendered.body).not.toContain("riskTier:");
  });

  it("renders identically on a redraft when the answers have not changed", () => {
    // The revision-dedup rule compares this hash. If classification were not a
    // pure function of coverage, an unchanged draft would bump the revision and
    // silently invalidate any pending approval message.
    const session = sessionAnswering({
      problem: { answer: "Add an OTP step to login.", confidence: 1 },
    });

    const first = draftSpec(session, POLICY);
    const second = draftSpec(session, POLICY);

    expect(second.rendered.contentHash).toBe(first.rendered.contentHash);
    expect(second.riskTier).toBe(first.riskTier);
  });
});

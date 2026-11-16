import { describe, it, expect } from "vitest";
import { createCoverageRecord, recordCoverage } from "./coverage";
import { startSpecSession, deriveTaskBreakdown, type SpecSessionState } from "./spec-session";
import { splitAcceptanceCriteria, toDispatchCandidate } from "./task-candidates";

/**
 * The shape `generate_task_breakdown` proposes.
 *
 * A candidate is only useful if it is a *valid `trigger_code_task` input* —
 * anything less is a suggestion the next step cannot act on. The interesting
 * half is therefore what this refuses to invent: a spec states outcomes, not
 * file paths, so `target` is usually absent, and a candidate with no target is
 * one no workflow can be dispatched against. Saying so is the point.
 */

function sessionWith(notes: Partial<Record<"acceptance_criteria" | "scope" | "dependencies", string>>) {
  let coverage = createCoverageRecord();
  for (const [dimension, text] of Object.entries(notes)) {
    coverage = recordCoverage(coverage, dimension as "scope", {
      state: "COVERED",
      confidence: 1,
      notes: text,
      evidence: "user",
    });
  }
  const session = startSpecSession({
    threadKey: "C1:1.1",
    requestedBy: "U1",
    title: "Retry failed deposits",
    targetRepoKey: "home_web",
  });
  return { ...session, coverage } as SpecSessionState;
}

const WEB = {
  key: "home_web",
  organization: "acme",
  repository: "web-app",
  slug: "acme/web-app",
  roles: ["code", "specs"] as const,
  platform: "web",
  team: "home",
};

describe("splitAcceptanceCriteria", () => {
  it("splits a bulleted list into one criterion per line", () => {
    expect(splitAcceptanceCriteria("- retries three times\n- surfaces the failure\n")).toEqual([
      "retries three times",
      "surfaces the failure",
    ]);
  });

  it("strips numbered and asterisk markers too", () => {
    expect(splitAcceptanceCriteria("1. first\n* second\n2) third")).toEqual(["first", "second", "third"]);
  });

  it("treats a single prose sentence as one criterion", () => {
    expect(splitAcceptanceCriteria("A failed deposit retries automatically.")).toEqual([
      "A failed deposit retries automatically.",
    ]);
  });

  it("returns nothing for empty or whitespace-only text", () => {
    expect(splitAcceptanceCriteria("")).toEqual([]);
    expect(splitAcceptanceCriteria("   \n  \n")).toEqual([]);
    expect(splitAcceptanceCriteria(undefined)).toEqual([]);
  });
});

describe("toDispatchCandidate", () => {
  it("carries the platform from the resolved repo, never a hard-coded union", () => {
    const session = sessionWith({ acceptance_criteria: "- retries three times" });
    const [derived] = deriveTaskBreakdown(session, { codeRepoKeys: ["home_web"] });

    const candidate = toDispatchCandidate(derived!, { session, repo: { ...WEB, roles: [...WEB.roles] } });

    expect(candidate.platform).toBe("web");
    expect(candidate.codeRepoKey).toBe("home_web");
    expect(candidate.specId).toBe(session.specId);
  });

  it("shapes acceptance criteria as addressable criteria, not bare strings", () => {
    const session = sessionWith({ acceptance_criteria: "- retries three times\n- surfaces the failure" });
    const [derived] = deriveTaskBreakdown(session, { codeRepoKeys: ["home_web"] });

    const candidate = toDispatchCandidate(derived!, { session, repo: { ...WEB, roles: [...WEB.roles] } });

    // The text and its reading order are what a dispatch consumes; the id is
    // what a test or an evidence index later cites. Both have to survive the
    // trip, so this asserts the whole shape rather than just the prose.
    expect(candidate.acceptanceCriteria.map((c) => c.text)).toEqual([
      "retries three times",
      "surfaces the failure",
    ]);
    expect(candidate.acceptanceCriteria.map((c) => c.ordinal)).toEqual([1, 2]);
    for (const criterion of candidate.acceptanceCriteria) {
      expect(criterion.id).toMatch(/^AC-[0-9a-f]{8}$/);
    }
  });

  /**
   * The honest half. `trigger_code_task` requires a concrete target precisely
   * so a "remove one file" request cannot become a sprawling PR; a spec states
   * outcomes, so it usually cannot supply one. Inventing a plausible file path
   * here would defeat the tool's only scope control.
   */
  it("leaves target absent when the spec names no concrete thing to change", () => {
    const session = sessionWith({ acceptance_criteria: "- retries three times" });
    const [derived] = deriveTaskBreakdown(session, { codeRepoKeys: ["home_web"] });

    const candidate = toDispatchCandidate(derived!, { session, repo: { ...WEB, roles: [...WEB.roles] } });

    expect(candidate.target).toBeUndefined();
  });

  it("uses the scope dimension as the target when the requester gave one", () => {
    const session = sessionWith({
      acceptance_criteria: "- retries three times",
      scope: "src/deposits/retry-policy.ts",
    });
    const [derived] = deriveTaskBreakdown(session, { codeRepoKeys: ["home_web"] });

    const candidate = toDispatchCandidate(derived!, { session, repo: { ...WEB, roles: [...WEB.roles] } });

    expect(candidate.target).toBe("src/deposits/retry-policy.ts");
  });

  /**
   * `dependsOn` is what the requester stated, verbatim — never an inferred
   * ordering. A dependency graph nobody wrote down is a schedule nobody agreed
   * to, and it would be indistinguishable from a real one on a board.
   */
  it("carries stated dependencies verbatim and infers none", () => {
    const session = sessionWith({
      acceptance_criteria: "- retries three times",
      dependencies: "- payments API v2 must ship first",
    });
    const [derived] = deriveTaskBreakdown(session, { codeRepoKeys: ["home_web"] });

    const candidate = toDispatchCandidate(derived!, { session, repo: { ...WEB, roles: [...WEB.roles] } });

    expect(candidate.dependsOn).toEqual(["payments API v2 must ship first"]);
  });

  it("reports no dependencies rather than an empty-string one", () => {
    const session = sessionWith({ acceptance_criteria: "- retries three times" });
    const [derived] = deriveTaskBreakdown(session, { codeRepoKeys: ["home_web"] });

    const candidate = toDispatchCandidate(derived!, { session, repo: { ...WEB, roles: [...WEB.roles] } });

    expect(candidate.dependsOn).toEqual([]);
  });
});

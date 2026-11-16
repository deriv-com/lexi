import { describe, it, expect } from "vitest";
import { parseMemoryPolicy, DEFAULT_MEMORY_POLICY_PATH } from "./load-memory-policy";
import { estimateTokens } from "./token-estimate";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Contract tests for the memory policy loader.
 *
 * The policy holds budgets, retention, extraction toggles and visibility
 * rules. Its shape is a contract, so these tests pin the shape
 * the rest of the subsystem reads, and assert the real repo file parses.
 */
describe("memory policy", () => {
  const realPolicy = readFileSync(
    resolve(__dirname, "../../../examples/config/memory-policy.yaml"),
    "utf-8",
  );

  it("parses the repo's config/memory-policy.yaml", () => {
    const policy = parseMemoryPolicy(realPolicy);
    expect(policy.version).toBe("1.0.0");
    // 4000 rather than the schema default of 1500, so the investigation
    // recall profile's token ask stops being clamped back to the ordinary
    // turn's budget. These assertions deliberately track the real file rather
    // than the schema defaults, which is why a policy edit lands here: the
    // point is that a budget cannot be changed without a test noticing.
    expect(policy.budgets.maxMemoryTokens).toBe(4000);
    // NOT scaled with the raise — the extra room is for episodic recall, not
    // for one thread's own history. See the comment in the policy file.
    expect(policy.budgets.maxThreadStateTokens).toBe(800);
    expect(policy.budgets.maxDigestsBeforeCompaction).toBe(20);
  });

  it("enables the file-side memory gate so MEMORY_ENABLED can actually recall", () => {
    const policy = parseMemoryPolicy(realPolicy);
    expect(policy.enabled).toBe(true);
  });

  it("points at the repo config by default", () => {
    expect(DEFAULT_MEMORY_POLICY_PATH).toContain("memory-policy.yaml");
  });

  it("classifies preference as user-scoped and decisions as org-scoped", () => {
    const policy = parseMemoryPolicy(realPolicy);
    expect(policy.visibility.userKinds).toContain("preference");
    expect(policy.visibility.orgKinds).toContain("decision");
    expect(policy.visibility.orgKinds).not.toContain("preference");
  });

  it("keeps deterministic extraction on and LLM free-text extraction off", () => {
    // Deterministic-first is a hard rule; episodic extraction from
    // structured tool outcomes is a named example of it.
    const policy = parseMemoryPolicy(realPolicy);
    expect(policy.extraction.deterministic).toBe(true);
    expect(policy.extraction.llmFreeText).toBe(false);
    expect(policy.extraction.skipOnFastPath).toBe(true);
  });

  it("rejects a policy with a non-positive token budget", () => {
    expect(() =>
      parseMemoryPolicy(`
version: "1.0.0"
enabled: false
budgets:
  maxMemoryTokens: 0
`),
    ).toThrow(/Invalid memory policy/);
  });

  it("rejects a policy that declares a spend cap — rationing is forbidden", () => {
    expect(() =>
      parseMemoryPolicy(`
version: "1.0.0"
enabled: false
budgets:
  maxMemoryTokens: 1500
  dailyLimitUsd: 5
`),
    ).toThrow(/Invalid memory policy/);
  });
});

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("grows monotonically with content length", () => {
    const short = estimateTokens("hello");
    const long = estimateTokens("hello world this is a much longer string of text");
    expect(long).toBeGreaterThan(short);
  });

  it("never under-reports — budget enforcement depends on this being an upper bound", () => {
    // ~4 chars per token is the standard approximation; rounding up means the
    // budget is conservative rather than optimistic.
    expect(estimateTokens("a".repeat(400))).toBeGreaterThanOrEqual(100);
  });
});

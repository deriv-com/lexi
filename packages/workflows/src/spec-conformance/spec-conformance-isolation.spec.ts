import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SpecConformanceService } from "./spec-conformance.service";
import type { BuiltArtefact, SpecConformanceJudge } from "./spec-conformance.types";

/**
 * Isolation is a correctness property, not hygiene.
 *
 * The failure this whole service exists to catch is the implementation and its
 * tests encoding the SAME misreading of the spec. If the checker can reach the
 * assumptions that produced the wrong implementation — the builder's session,
 * recalled memory, the dispatch conversation — it reproduces the misreading and
 * confirms it. Two independent readings is the mechanism; shared context
 * collapses them into one.
 *
 * So it is asserted structurally: what the service can REACH, not a comment
 * asking future callers to be careful.
 */

const SRC_DIR = __dirname;
const read = (file: string) => readFileSync(join(SRC_DIR, file), "utf8");

const IMPLEMENTATION_FILES = [
  "spec-conformance.service.ts",
  "spec-conformance-policy.ts",
  "spec-conformance-report.ts",
  "spec-conformance.types.ts",
];

const ARTEFACT: BuiltArtefact = {
  pullRequests: ["acme/app#412"],
  changedFiles: ["src/withdrawal/amount.tsx"],
  diffSummary: "two-step withdrawal",
};

// ---------------------------------------------------------------------------
// Structural: what the module can reach
// ---------------------------------------------------------------------------

describe("spec conformance — structural isolation", () => {
  it.each(IMPLEMENTATION_FILES)("%s imports no memory subsystem", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/from\s+["']@lexi\/memory["']/);
    expect(source).not.toMatch(/MemoryPort|MemoryFacade|RecallQuery|MemoryPack/);
  });

  it.each(IMPLEMENTATION_FILES)("%s imports no agent session or conversation", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/AgentConversation|agent-conversation|ThreadState|threadState/);
    expect(source).not.toMatch(/from\s+["']@lexi\/server["']/);
    expect(source).not.toMatch(/from\s+["']@lexi\/specs["']/);
  });

  it.each(IMPLEMENTATION_FILES)("%s pulls no builder or dispatch context", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/builderSession|dispatchConversation|recall\(|priorTurns/);
  });

  it("depends on exactly four collaborators, none of which carry builder context", () => {
    // A constructor that cannot be handed memory or a session cannot consult
    // one. This is the enforcement; the import scans above are the backstop.
    const source = read("spec-conformance.service.ts");
    const deps = source.match(/export interface SpecConformanceDeps \{([\s\S]*?)\n\}/);

    expect(deps, "SpecConformanceDeps must be declared").not.toBeNull();
    const fields = [...deps![1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);

    expect(fields.sort()).toEqual(["judge", "options", "provenance", "specRevisions"]);
  });

  it("gives the judge only the approved spec body and the projected artefact", async () => {
    let received: unknown = null;
    const judge: SpecConformanceJudge = {
      async compare(input) {
        received = input;
        return { points: [{ requirement: "r", status: "satisfied" }] };
      },
    };

    const contaminated = {
      ...ARTEFACT,
      builderSessionId: "sess_123",
      recalledMemory: ["the builder assumed two steps"],
      dispatchConversation: [{ role: "user", content: "just do the two-step flow" }],
    } as unknown as BuiltArtefact;

    await new SpecConformanceService({
      provenance: {
        async loadSpecProvenance() {
          return {
            specId: "spec_1",
            revision: 1,
            contentHash: "whatever",
            approvedAt: "2026-08-15T09:00:00.000Z",
            approvedBy: "U0TEST01",
          };
        },
      },
      specRevisions: { async loadApprovedSpecBody() { return "SPEC BODY"; } },
      judge,
      options: { enabled: true, governanceChannelId: "C0TEST01" },
    }).verify("wi_1", contaminated);

    expect(Object.keys(received as object).sort()).toEqual(["approvedSpecBody", "artefact"]);

    const serialised = JSON.stringify(received);
    expect(serialised).not.toContain("sess_123");
    expect(serialised).not.toContain("the builder assumed two steps");
    expect(serialised).not.toContain("just do the two-step flow");
  });
});

// ---------------------------------------------------------------------------
// Structural: it cannot block
// ---------------------------------------------------------------------------

describe("spec conformance — no blocking path exists", () => {
  const WRITE_CALLS = [
    /closeIssue/,
    /closePullRequest/,
    /requestChanges/,
    /createCheckRun/,
    /createCommitStatus/,
    /setCommitStatus/,
    /mergeBlocked/,
    /blockDeploy/,
    /failCheck/,
    /dismissReview/,
    /addLabel/,
    /removeLabel/,
    /updateIssue/,
    /octokit/i,
  ];

  it.each(IMPLEMENTATION_FILES)("%s makes no write or gating call", (file) => {
    const source = read(file);
    for (const pattern of WRITE_CALLS) {
      expect(source, `${file} must not reference ${pattern}`).not.toMatch(pattern);
    }
  });

  it.each(IMPLEMENTATION_FILES)("%s imports no github or write-capable client", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/from\s+["']@lexi\/github["']/);
    expect(source).not.toMatch(/from\s+["']@lexi\/slack["']/);
    expect(source).not.toMatch(/from\s+["']@lexi\/database["']/);
  });

  it("verify() resolves rather than throwing, for every verdict", async () => {
    // A throw is a blocking path by another name: a caller in a merge or
    // deploy step would surface it as a failure.
    const judges: SpecConformanceJudge[] = [
      { async compare() { return { points: [{ requirement: "r", status: "satisfied" }] }; } },
      { async compare() { return { points: [{ requirement: "r", status: "diverged", evidence: ["p"] }] }; } },
      { async compare() { return { points: [{ requirement: "r", status: "extra", evidence: ["p"] }] }; } },
      {
        async compare() {
          return { points: [{ requirement: "r", status: "missing", evidence: ["not in changed files / tests"] }] };
        },
      },
      { async compare() { return { points: [] }; } },
      { async compare() { throw new Error("gateway 400"); } },
    ];

    for (const judge of judges) {
      const service = new SpecConformanceService({
        provenance: {
          async loadSpecProvenance() {
            return {
              specId: "spec_1",
              revision: 1,
              contentHash: "nope",
              approvedAt: "2026-08-15T09:00:00.000Z",
              approvedBy: "U0TEST01",
            };
          },
        },
        specRevisions: { async loadApprovedSpecBody() { return "SPEC BODY"; } },
        judge,
        options: { enabled: true, governanceChannelId: "C0TEST01" },
      });

      await expect(service.verify("wi_1", ARTEFACT)).resolves.toBeTruthy();
    }
  });
});

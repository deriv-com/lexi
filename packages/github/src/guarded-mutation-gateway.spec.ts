import { describe, it, expect, vi } from "vitest";
import {
  GuardedMutationGateway,
  type MutationGuardEvaluator,
  type IssueStateResolver,
  type GuardIssueState,
  type GuardDecision,
} from "./guarded-mutation-gateway";
import type { GitHubProvider } from "./github-provider.interface";

// ---- Mock factories ----

function mockInnerProvider(): GitHubProvider {
  return {
    listBugHuntIssues: vi.fn(async () => []),
    listIssues: vi.fn(async () => []),
    listIssuesUpdatedSince: vi.fn(async () => []),
    listReleases: vi.fn(async () => []),
    getIssue: vi.fn(async () => ({} as any)),
    getPullRequest: vi.fn(async () => ({} as any)),
    listComments: vi.fn(async () => []),
    addComment: vi.fn(async () => ({ id: 1, authorLogin: "bot", body: "test", createdAt: new Date().toISOString() })),
    listTimeline: vi.fn(async () => []),
    listLinkedPullRequests: vi.fn(async () => []),
    createIssue: vi.fn(async () => ({} as any)),
    setLabels: vi.fn(async () => ["bug"]),
    addLabels: vi.fn(async () => ["bug"]),
    removeLabels: vi.fn(async () => {}),
    assignUsers: vi.fn(async () => ["dev"]),
    closeIssue: vi.fn(async () => ({} as any)),
    reopenIssue: vi.fn(async () => ({} as any)),
    closePullRequest: vi.fn(async () => ({} as any)),
    reopenPullRequest: vi.fn(async () => ({} as any)),
    updatePullRequest: vi.fn(async () => ({} as any)),
    dispatchWorkflow: vi.fn(async () => undefined),
    findDispatchedRun: vi.fn(async () => null),
    searchCode: vi.fn(async () => []),
    getFileContents: vi.fn(async () => null),
    getTree: vi.fn(async () => ({ entries: [], truncated: false })),
    getBlob: vi.fn(async () => null),
    listWorkflowRunArtifacts: vi.fn(async () => []),
    downloadWorkflowRunArtifact: vi.fn(async () => Buffer.alloc(0)),
    listWorkflowRunJobs: vi.fn(async () => []),
    downloadWorkflowJobLogs: vi.fn(async () => ""),
    cancelWorkflowRun: vi.fn(async () => undefined),
    getPullRequestFiles: vi.fn(async () => []),
    createPullRequest: vi.fn(async () => ({} as any)),
  };
}

function unprotectedState(overrides: Partial<GuardIssueState> = {}): GuardIssueState {
  return {
    labels: ["bug"],
    priority: "P3",
    severity: "S3",
    hasRecentHumanActivity: false,
    hasOpenLinkedPR: false,
    isExplicitlyAssigned: false,
    hasActiveEngineeringWork: false,
    state: "open",
    ...overrides,
  };
}

function createResolver(state: GuardIssueState | null = unprotectedState()): IssueStateResolver {
  return { resolveCurrentState: vi.fn(async () => state) };
}

function createFailingResolver(error: string): IssueStateResolver {
  return { resolveCurrentState: vi.fn(async () => { throw new Error(error); }) };
}

/** Real guard using evaluateMutationGuard from governance */
function createRealGuard(): MutationGuardEvaluator {
  // @lexi/governance depends on this package, so a static import would make the build cyclic.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { evaluateMutationGuard } = require("@lexi/governance");
  return { evaluate: (input: any) => evaluateMutationGuard(input) };
}

function createGateway(
  opts: {
    writesEnabled?: boolean;
    resolver?: IssueStateResolver;
    guard?: MutationGuardEvaluator;
    actorId?: string;
    actorIsHuman?: boolean;
  } = {},
) {
  const inner = mockInnerProvider();
  const gateway = new GuardedMutationGateway(
    inner,
    { writesEnabled: opts.writesEnabled ?? true, dryRun: false },
    opts.guard ?? createRealGuard(),
    opts.resolver ?? createResolver(),
    { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    { actorId: opts.actorId ?? "system", actorIsHuman: opts.actorIsHuman ?? false },
  );
  return { gateway, inner };
}

// ---- 14 Certification Tests ----

describe("GuardedMutationGateway — Phase 1.1 enforcement certification", () => {
  // Case 1: Security-labelled issue cannot be closed
  it("case 1: security-labelled issue cannot be closed", async () => {
    const { gateway, inner } = createGateway({
      resolver: createResolver(unprotectedState({ labels: ["bug", "security"] })),
    });

    await expect(gateway.closeIssue("org", "repo", 100, "not_planned")).rejects.toThrow("Write gate blocked");
    expect(inner.closeIssue).not.toHaveBeenCalled();
    expect(gateway.auditLog.some((e) => e.action.includes("close") && !e.wouldExecute)).toBe(true);
  });

  // Case 2: P0/P1 cannot enter automated closure
  it("case 2: P0/P1 issue blocked from automated closure", async () => {
    const { gateway, inner } = createGateway({
      resolver: createResolver(unprotectedState({ priority: "P1" })),
    });

    await expect(gateway.closeIssue("org", "repo", 200)).rejects.toThrow();
    expect(inner.closeIssue).not.toHaveBeenCalled();
  });

  // Case 3: Recent human comment blocks destructive mutation
  it("case 3: recent human activity blocks closure", async () => {
    const { gateway, inner } = createGateway({
      resolver: createResolver(unprotectedState({ hasRecentHumanActivity: true })),
    });

    await expect(gateway.closeIssue("org", "repo", 300)).rejects.toThrow();
    expect(inner.closeIssue).not.toHaveBeenCalled();
  });

  // Case 4: keep-open label added after preview blocks execution
  it("case 4: keep-open label blocks closure (stale approval scenario)", async () => {
    const { gateway, inner } = createGateway({
      resolver: createResolver(unprotectedState({ labels: ["bug", "keep-open"] })),
    });

    await expect(gateway.closeIssue("org", "repo", 400)).rejects.toThrow();
    expect(inner.closeIssue).not.toHaveBeenCalled();
    const audit = gateway.auditLog.find((e) => e.issueNumber === 400);
    expect(audit?.guardDecision?.matchedRules.some((r) => r.toLowerCase().includes("hold") || r.toLowerCase().includes("keep-open"))).toBe(true);
  });

  // Case 5: Open linked PR blocks closure
  it("case 5: open linked PR blocks closure", async () => {
    const { gateway, inner } = createGateway({
      resolver: createResolver(unprotectedState({ hasOpenLinkedPR: true })),
    });

    await expect(gateway.closeIssue("org", "repo", 500)).rejects.toThrow();
    expect(inner.closeIssue).not.toHaveBeenCalled();
  });

  // Case 6: Human-set priority cannot be lowered (human-gated action by automation)
  it("case 6: priority.lower action blocked for automation", async () => {
    const { gateway } = createGateway();
    // priority.lower is human_gated — automation cannot execute it
    const result = await gateway.runWrite("priority.lower", async (p) => "lowered", 600, "org", "repo");
    expect(result.executed).toBe(false);
  });

  // Case 7: Unknown action is human-gated
  it("case 7: unknown action defaults to human-gated and is blocked for automation", async () => {
    const { gateway } = createGateway();
    const result = await gateway.runWrite("unknown.dangerous.thing", async (p) => "did it", 700, "org", "repo");
    expect(result.executed).toBe(false);
    expect(result.reason).toContain("human");
  });

  // Case 8: GitHub current-state lookup failure blocks mutation (fail-closed)
  it("case 8: state resolution failure blocks mutation", async () => {
    const { gateway, inner } = createGateway({
      resolver: createFailingResolver("Connection timeout"),
    });

    await expect(gateway.closeIssue("org", "repo", 800)).rejects.toThrow();
    expect(inner.closeIssue).not.toHaveBeenCalled();
    const audit = gateway.auditLog.find((e) => e.issueNumber === 800);
    expect(audit?.reason).toContain("Failed to resolve");
  });

  // Case 9: Issue not found in DB blocks mutation (fail-closed)
  it("case 9: unknown issue (null state) blocks mutation", async () => {
    const { gateway, inner } = createGateway({
      resolver: createResolver(null),
    });

    await expect(gateway.closeIssue("org", "repo", 900)).rejects.toThrow();
    expect(inner.closeIssue).not.toHaveBeenCalled();
    const audit = gateway.auditLog.find((e) => e.issueNumber === 900);
    expect(audit?.reason).toContain("not found");
  });

  // Case 10: Write gate blocks an otherwise-permitted action
  it("case 10: write gate blocks even when policy allows", async () => {
    const { gateway, inner } = createGateway({ writesEnabled: false });

    await expect(gateway.closeIssue("org", "repo", 1000)).rejects.toThrow();
    expect(inner.closeIssue).not.toHaveBeenCalled();
  });

  // Case 11: Prohibited action cannot be overridden even by human
  it("case 11: prohibited action blocked even for human actor", async () => {
    const { gateway } = createGateway({ actorIsHuman: true });
    const result = await gateway.runWrite("security.mutate", async (p) => "mutated", 1100, "org", "repo");
    expect(result.executed).toBe(false);
    expect(result.reason).toContain("prohibited");
  });

  // Case 12: Unprotected issue with writes enabled — mutation succeeds
  it("case 12: unprotected issue with writes enabled allows closure", async () => {
    const { gateway, inner } = createGateway();

    await gateway.closeIssue("org", "repo", 1200);
    expect(inner.closeIssue).toHaveBeenCalledWith("org", "repo", 1200, undefined);
    const audit = gateway.auditLog.find((e) => e.issueNumber === 1200);
    expect(audit?.reason).toBe("executed");
  });

  // Case 13: Constructive action (comment) passes through with lighter guard
  it("case 13: constructive action (comment) passes even on protected issue", async () => {
    const { gateway, inner } = createGateway({
      resolver: createResolver(unprotectedState({ labels: ["security"], priority: "P0" })),
    });

    // Comments are constructive — should pass through
    await gateway.addComment("org", "repo", 1300, "This is a status update.");
    expect(inner.addComment).toHaveBeenCalled();
  });

  // Case 14: Every blocked and executed attempt is auditable
  it("case 14: audit log records all decisions (blocked and executed)", async () => {
    const { gateway } = createGateway();

    // Execute one that succeeds
    await gateway.addLabels("org", "repo", 1400, ["triaged"]);
    // Execute one that fails (security)
    const securityResolver = createResolver(unprotectedState({ labels: ["security"] }));
    const { gateway: gw2 } = createGateway({ resolver: securityResolver });
    try { await gw2.closeIssue("org", "repo", 1401); } catch {}

    // First gateway has a success audit
    expect(gateway.auditLog.length).toBeGreaterThanOrEqual(1);
    expect(gateway.auditLog.some((e) => e.reason === "executed")).toBe(true);

    // Second gateway has a blocked audit
    expect(gw2.auditLog.length).toBeGreaterThanOrEqual(1);
    expect(gw2.auditLog.some((e) => !e.wouldExecute && e.guardDecision?.allowed === false)).toBe(true);
    expect(gw2.auditLog[0].guardDecision?.policyVersion).toBeDefined();
    expect(gw2.auditLog[0].currentState).toBeDefined();
  });
});

describe("GuardedMutationGateway — pull request read/write methods", () => {
  it("passes getFileContents and getPullRequestFiles through untouched (reads, not mutations)", async () => {
    const { gateway, inner } = createGateway();
    (inner.getFileContents as ReturnType<typeof vi.fn>).mockResolvedValue("export const a = 1;\n");
    (inner.getPullRequestFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
    ]);

    await expect(gateway.getFileContents("org", "repo", "src/a.ts")).resolves.toBe("export const a = 1;\n");
    await expect(gateway.getPullRequestFiles("org", "repo", 55)).resolves.toHaveLength(1);

    expect(inner.getFileContents).toHaveBeenCalledWith("org", "repo", "src/a.ts", undefined);
    expect(inner.getPullRequestFiles).toHaveBeenCalledWith("org", "repo", 55);
    // Reads bypass the guard entirely, so they must leave no audit trail.
    expect(gateway.auditLog).toHaveLength(0);
  });

  it("passes getTree/getBlob and artifact reads through untouched", async () => {
    const { gateway, inner } = createGateway();
    const tree = { entries: [{ path: "src/a.ts", type: "blob" as const, size: 12, sha: "abc" }], truncated: false };
    (inner.getTree as ReturnType<typeof vi.fn>).mockResolvedValue(tree);
    (inner.getBlob as ReturnType<typeof vi.fn>).mockResolvedValue("export const a = 1;\n");
    (inner.listWorkflowRunArtifacts as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 9, name: "lexi-evidence", sizeInBytes: 40, expired: false },
    ]);
    const zip = Buffer.from("PK");
    (inner.downloadWorkflowRunArtifact as ReturnType<typeof vi.fn>).mockResolvedValue(zip);

    await expect(gateway.getTree("org", "repo", "src", "main")).resolves.toEqual(tree);
    await expect(gateway.getBlob("org", "repo", "abc")).resolves.toBe("export const a = 1;\n");
    await expect(gateway.listWorkflowRunArtifacts("org", "repo", 55)).resolves.toHaveLength(1);
    await expect(gateway.downloadWorkflowRunArtifact("org", "repo", 9)).resolves.toEqual(zip);

    expect(inner.getTree).toHaveBeenCalledWith("org", "repo", "src", "main");
    // The 4th argument is the optional per-call decode cap, forwarded as
    // given: the gateway must not silently drop it, or a caller asking for a
    // large document would get the conservative default back.
    expect(inner.getBlob).toHaveBeenCalledWith("org", "repo", "abc", undefined);
    expect(inner.listWorkflowRunArtifacts).toHaveBeenCalledWith("org", "repo", 55);
    expect(inner.downloadWorkflowRunArtifact).toHaveBeenCalledWith("org", "repo", 9);
    expect(gateway.auditLog).toHaveLength(0);
  });

  it("passes createPullRequest to the inner provider without running the issue guard", async () => {
    // A resolver that would explode if the issue-centric guard path were used:
    // opening a PR has no issue number, so it must never be consulted.
    const resolver = createFailingResolver("resolver must not be called for createPullRequest");
    const { gateway, inner } = createGateway({ resolver });
    (inner.createPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 12,
      state: "open",
      merged: false,
      mergedAt: null,
      url: "https://github.com/org/repo/pull/12",
      draft: true,
    });

    const options = { title: "Fix crash", head: "fix/crash", base: "main", draft: true };
    const result = await gateway.createPullRequest("org", "repo", options);

    expect(inner.createPullRequest).toHaveBeenCalledWith("org", "repo", options);
    expect(result.draft).toBe(true);
    expect(resolver.resolveCurrentState).not.toHaveBeenCalled();
    expect(gateway.auditLog).toHaveLength(0);
  });

  it("passes mergePullRequest to the inner provider without running the issue guard", async () => {
    const resolver = createFailingResolver("resolver must not be called for mergePullRequest");
    const { gateway, inner } = createGateway({ resolver });
    const merge = vi.fn().mockResolvedValue({ merged: true, sha: "abc", message: "ok" });
    (inner as unknown as { mergePullRequest: unknown }).mergePullRequest = merge;

    const result = await gateway.mergePullRequest("org", "repo", 7, { sha: "abc" });

    expect(merge).toHaveBeenCalledWith("org", "repo", 7, { sha: "abc" });
    expect(result.merged).toBe(true);
    expect(resolver.resolveCurrentState).not.toHaveBeenCalled();
  });
});

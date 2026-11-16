import { describe, expect, it, vi } from "vitest";
import { parseAgentFixLog, parseRebaseLog, readAgentFixArtifact, readRunResult } from "./run-result";
import type { GithubDispatchClient } from "../github/github-client";
import { buildZip } from "../testing/zip-builder";

const SHIPPED_LOG = [
  "2026-01-01T00:00:00.0000000Z ##[group]Run if [ -s /tmp/announcement.txt ]; then",
  '2026-01-01T00:00:00.0000000Z   echo "===== AGENT_FIX_RESULT: SHIPPED ====="',
  "2026-01-01T00:00:00.0000000Z ##[endgroup]",
  "2026-01-01T00:00:01.0000000Z ===== AGENT_FIX_RESULT: SHIPPED =====",
  "2026-01-01T00:00:01.0000000Z Fixed the checkout button. PR: https://github.com/acme/web/pull/34",
  "2026-01-01T00:00:01.0000000Z ===== END_AGENT_FIX_RESULT =====",
].join("\n");

describe("parseAgentFixLog", () => {
  it("reads the fenced block and ignores the echoed script", () => {
    expect(parseAgentFixLog(SHIPPED_LOG)).toEqual({ status: "shipped", text: "Fixed the checkout button. PR: https://github.com/acme/web/pull/34" });
  });

  it("reads a hand-back, and returns null without a block", () => {
    expect(parseAgentFixLog("===== AGENT_FIX_RESULT: HANDBACK =====\nNeeds a person\n===== END_AGENT_FIX_RESULT =====")?.status).toBe("handback");
    expect(parseAgentFixLog('  echo "===== AGENT_FIX_RESULT: SHIPPED ====="\n')).toBeNull();
  });
});

describe("parseRebaseLog", () => {
  it("reads the result line and the conflicting paths", () => {
    const log = [
      '  echo "REBASE_RESULT: ${RESULT}"',
      "Rebase of lexi/x onto main stopped on a conflict in:",
      "  - src/a.ts",
      "  - src/b.ts",
      "REBASE_RESULT: CONFLICT",
    ].join("\n");
    expect(parseRebaseLog(log)).toEqual({ result: "CONFLICT", conflicts: ["src/a.ts", "src/b.ts"] });
  });

  it("ignores the echoed script line", () => {
    expect(parseRebaseLog('echo "REBASE_RESULT: ${RESULT}"')).toBeNull();
    expect(parseRebaseLog("REBASE_RESULT: REBASED")).toEqual({ result: "REBASED", conflicts: [] });
  });
});

function client(overrides: Partial<GithubDispatchClient> = {}): GithubDispatchClient {
  return {
    dispatchWorkflow: vi.fn(),
    findDispatchedRun: vi.fn(async () => null),
    listWorkflowRunJobs: vi.fn(async () => [{ jobId: 1, name: "fix", status: "completed", conclusion: "success", htmlUrl: "", startedAt: null, completedAt: null }]),
    downloadWorkflowJobLogs: vi.fn(async () => "nothing useful"),
    listWorkflowRunArtifacts: vi.fn(async () => []),
    downloadWorkflowRunArtifact: vi.fn(async () => Buffer.alloc(0)),
    ...overrides,
  };
}

describe("readAgentFixArtifact", () => {
  it("prefers the hand-back and only reads this run's result artifact", async () => {
    const result = buildZip([
      { name: "announcement.txt", content: "Shipped" },
      { name: "handback.txt", content: "Needs a person" },
    ]);
    const github = client({
      listWorkflowRunArtifacts: vi.fn(async () => [
        { id: 1, name: "agent-fix-visuals-55", sizeInBytes: 1, expired: false },
        { id: 2, name: "agent-fix-999", sizeInBytes: 1, expired: false },
        { id: 3, name: "agent-fix-55", sizeInBytes: 1, expired: false },
      ]),
      downloadWorkflowRunArtifact: vi.fn(async () => result),
    });
    expect(await readAgentFixArtifact(github, "acme", "web", 55)).toEqual({ status: "handback", text: "Needs a person" });
    expect(github.downloadWorkflowRunArtifact).toHaveBeenCalledTimes(1);
    expect(github.downloadWorkflowRunArtifact).toHaveBeenCalledWith("acme", "web", 3);
  });

  it("returns null for a corrupt artifact", async () => {
    const github = client({
      listWorkflowRunArtifacts: vi.fn(async () => [{ id: 3, name: "agent-fix-55", sizeInBytes: 1, expired: false }]),
      downloadWorkflowRunArtifact: vi.fn(async () => Buffer.from("garbage")),
    });
    expect(await readAgentFixArtifact(github, "acme", "web", 55)).toBeNull();
  });
});

describe("readRunResult", () => {
  it("reports a running run as in progress", async () => {
    const github = client({ getWorkflowRun: vi.fn(async () => ({ runId: 55, runUrl: "", status: "in_progress", conclusion: null })) });
    expect(await readRunResult(github, "acme", "web", 55)).toEqual({ state: "in_progress", status: "in_progress" });
  });

  it("reads a result from the log", async () => {
    const github = client({ downloadWorkflowJobLogs: vi.fn(async () => SHIPPED_LOG) });
    expect(await readRunResult(github, "acme", "web", 55)).toMatchObject({ state: "agent_fix", source: "log", outcome: { status: "shipped" } });
  });

  it("falls back to the artifact when the log is unavailable", async () => {
    const github = client({
      downloadWorkflowJobLogs: vi.fn(async () => { throw new Error("404"); }),
      listWorkflowRunArtifacts: vi.fn(async () => [{ id: 3, name: "agent-fix-55", sizeInBytes: 1, expired: false }]),
      downloadWorkflowRunArtifact: vi.fn(async () => buildZip([{ name: "announcement.txt", content: "Shipped PR #34" }])),
    });
    expect(await readRunResult(github, "acme", "web", 55)).toMatchObject({ state: "agent_fix", source: "artifact", outcome: { text: "Shipped PR #34" } });
  });

  it("reads a rebase result", async () => {
    const github = client({ downloadWorkflowJobLogs: vi.fn(async () => "REBASE_RESULT: ALREADY_CURRENT") });
    expect(await readRunResult(github, "acme", "web", 55)).toMatchObject({ state: "rebase", outcome: { result: "ALREADY_CURRENT" } });
  });

  it("reports a finished run with no result as no_result", async () => {
    expect(await readRunResult(client(), "acme", "web", 55)).toEqual({ state: "no_result", conclusion: null });
  });
});

import type { GithubDispatchClient } from "../github/github-client";
import { unzipMatching } from "./zip";

/**
 * Reads what an agent-fix or rebase-branch run concluded.
 *
 * The agent-fix workflow publishes exactly one result, two ways:
 *   - in the job log, fenced:
 *       ===== AGENT_FIX_RESULT: SHIPPED =====   (or HANDBACK)
 *       <text>
 *       ===== END_AGENT_FIX_RESULT =====
 *   - as `announcement.txt` (shipped) or `handback.txt` in the
 *     `agent-fix-<run_id>` artifact, which survives a log that never uploaded.
 * The rebase workflow prints one line, `REBASE_RESULT: <RESULT>`.
 *
 * GitHub's log for a step also echoes the step's script, so the matchers
 * require each marker to be the whole line: the script's
 * `echo "===== AGENT_FIX_RESULT: ... ====="` never matches.
 */

export type AgentFixOutcome = { status: "shipped" | "handback"; text: string };
export type RebaseResult = "REBASED" | "ALREADY_CURRENT" | "CONFLICT" | "HANDBACK";
export type RebaseOutcome = { result: RebaseResult; conflicts: string[] };

const AGENT_FIX_BLOCK =
  /^[ \t]*=====[ \t]*AGENT_FIX_RESULT:[ \t]*(SHIPPED|HANDBACK)[ \t]*=====[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*=====[ \t]*END_AGENT_FIX_RESULT[ \t]*=====[ \t]*$/gm;
const REBASE_LINE = /^[ \t]*REBASE_RESULT:[ \t]*(REBASED|ALREADY_CURRENT|CONFLICT|HANDBACK)[ \t]*$/gm;
const RESULT_ARTIFACT = /^agent-fix-(\d+)$/;
const RESULT_FILE = /(?:^|\/)(announcement|handback)\.txt$/i;
/** A real result is a few kilobytes; anything far larger is not one. */
const MAX_RESULT_CHARS = 256 * 1024;

/** Strips the RFC 3339 timestamp GitHub prefixes to every log line. */
export function stripLogTimestamps(log: string): string {
  return log.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /gm, "");
}

/** The last fenced agent-fix result in a job log, or null. */
export function parseAgentFixLog(log: string): AgentFixOutcome | null {
  let last: AgentFixOutcome | null = null;
  for (const match of stripLogTimestamps(log).matchAll(AGENT_FIX_BLOCK)) {
    const text = match[2].trim();
    if (text) last = { status: match[1] === "SHIPPED" ? "shipped" : "handback", text };
  }
  return last;
}

/** The last `REBASE_RESULT:` line in a job log, with any conflicting paths it listed, or null. */
export function parseRebaseLog(log: string): RebaseOutcome | null {
  const clean = stripLogTimestamps(log);
  let result: RebaseResult | null = null;
  for (const match of clean.matchAll(REBASE_LINE)) result = match[1] as RebaseResult;
  if (!result) return null;
  const conflicts: string[] = [];
  if (result === "CONFLICT") {
    const section = /stopped on a conflict in:\r?\n((?:[ \t]+- .+\r?\n?)+)/.exec(clean);
    for (const line of section?.[1].split(/\r?\n/) ?? []) {
      const path = line.replace(/^[ \t]+- /, "").trim();
      if (path) conflicts.push(path);
    }
  }
  return { result, conflicts };
}

/**
 * Reads the agent-fix result from the run's `agent-fix-<run_id>` artifact.
 * A hand-back wins when both files are present, matching the workflow, which
 * publishes the hand-back in that case.
 */
export async function readAgentFixArtifact(
  github: Pick<GithubDispatchClient, "listWorkflowRunArtifacts" | "downloadWorkflowRunArtifact">,
  owner: string,
  repo: string,
  runId: number,
): Promise<AgentFixOutcome | null> {
  const artifacts = await github.listWorkflowRunArtifacts(owner, repo, runId).catch(() => []);
  let announcement = "";
  let handback = "";
  for (const artifact of artifacts) {
    const match = RESULT_ARTIFACT.exec(artifact.name);
    if (artifact.expired || !match || Number(match[1]) !== runId) continue;
    let files;
    try {
      files = unzipMatching(await github.downloadWorkflowRunArtifact(owner, repo, artifact.id), (name) => RESULT_FILE.test(name), {
        maxEntryBytes: MAX_RESULT_CHARS * 4,
      });
    } catch {
      continue;
    }
    for (const file of files) {
      const text = decodeResultText(file.data);
      if (!text) continue;
      const base = file.name.split("/").pop()?.toLowerCase();
      if (base === "announcement.txt" && !announcement) announcement = text;
      if (base === "handback.txt" && !handback) handback = text;
    }
  }
  if (handback) return { status: "handback", text: handback };
  if (announcement) return { status: "shipped", text: announcement };
  return null;
}

export type RunResult =
  | { state: "in_progress"; status: string }
  | { state: "agent_fix"; outcome: AgentFixOutcome; source: "log" | "artifact"; conclusion: string | null }
  | { state: "rebase"; outcome: RebaseOutcome; conclusion: string | null }
  | { state: "no_result"; conclusion: string | null };

/**
 * What a completed run concluded. Reads job logs first, then the result
 * artifact. A run that has not finished is `in_progress`; a finished run with
 * no result anywhere is `no_result`, which means something broke before the
 * workflow could publish, not that the work succeeded.
 */
export async function readRunResult(github: GithubDispatchClient, owner: string, repo: string, runId: number): Promise<RunResult> {
  let conclusion: string | null = null;
  if (typeof github.getWorkflowRun === "function") {
    const run = await github.getWorkflowRun(owner, repo, runId);
    if (run && run.status !== "completed") return { state: "in_progress", status: run.status };
    conclusion = run?.conclusion ?? null;
  }
  const jobs = await github.listWorkflowRunJobs(owner, repo, runId);
  if (typeof github.getWorkflowRun !== "function" && jobs.some((job) => job.status !== "completed")) {
    return { state: "in_progress", status: "in_progress" };
  }
  let rebase: RebaseOutcome | null = null;
  for (const job of jobs) {
    let log: string;
    try {
      log = await github.downloadWorkflowJobLogs(owner, repo, job.jobId);
    } catch {
      continue;
    }
    const fix = parseAgentFixLog(log);
    if (fix) return { state: "agent_fix", outcome: fix, source: "log", conclusion };
    rebase = parseRebaseLog(log) ?? rebase;
  }
  if (rebase) return { state: "rebase", outcome: rebase, conclusion };
  const fromArtifact = await readAgentFixArtifact(github, owner, repo, runId);
  if (fromArtifact) return { state: "agent_fix", outcome: fromArtifact, source: "artifact", conclusion };
  return { state: "no_result", conclusion };
}

function decodeResultText(data: Buffer): string | null {
  if (data.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
  const trimmed = text.trim();
  return trimmed && trimmed.length <= MAX_RESULT_CHARS ? trimmed : null;
}

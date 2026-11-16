import type { AgentTool, ToolModule, ToolResult } from "@lexi/agent";
import { assertSafeBranchName, correlateDispatchedRun, dispatchSearchFloor, type CorrelateDispatchedRunOptions } from "@lexi/github";
import { readPositiveInt, readString } from "../shared/args";
import { REPOSITORY_PROPERTY, asRepoScope, repoResource, unknownRepoMessage, type RepoScope, type RepoTarget, type StaticRepoEntry } from "../shared/repo-scope";
import { errorMessage, executed, governedWrite, jsonResult, readError, redactProviderError, refused } from "../shared/result";
import { defineTool } from "../shared/schema";
import { parseRunUrl, type GithubDispatchClient } from "../github/github-client";
import { readRunResult } from "./run-result";

export const AGENT_FIX_MODULE_NAME = "agent-fix";
export const DISPATCH_AGENT_FIX_PERMISSION = "code_task.trigger";
export const REBASE_BRANCH_PERMISSION = "branch.rebase";

export interface AgentFixModuleDeps {
  /** Pass the `GitHubMutationGateway`, so the writes-enabled / dry-run switch applies. */
  github: GithubDispatchClient;
  /** Repositories that carry the caller workflows. Anything else is refused. */
  repositories: RepoScope | ReadonlyArray<string | StaticRepoEntry>;
  /** The caller workflow for agent-fix in each target repository. Default `agent-fix.yml`. */
  agentFixWorkflow?: string;
  /** The caller workflow for rebasing. Default `rebase-branch.yml`. */
  rebaseWorkflow?: string;
  /**
   * The ref the workflows are dispatched on. Default: the repository's default
   * branch (from the scope, else asked of GitHub). A dispatch never goes out
   * without an explicit ref.
   */
  workflowRef?: string;
  /** Branches `rebase_branch` may touch must start with one of these. Default `["lexi/"]`. */
  branchPrefixes?: readonly string[];
  /** How the requester is named to the workflow. Default: the chat user id. */
  requesterName?: (actorId: string) => string;
  /** Retry settings for finding the run a dispatch created. */
  correlate?: CorrelateDispatchedRunOptions;
}

/** Briefs longer than this are refused, not truncated: GitHub caps all inputs together at 64 KB. */
export const MAX_BRIEF_CHARS = 50_000;

/**
 * Branches a rebase must never touch, because rewriting them rewrites history
 * everyone else builds on. The workflow enforces its own list too; this copy
 * exists so the refusal arrives as a sentence now instead of a red run later.
 */
const PROTECTED_BRANCH = /^(main|master|develop|development|trunk|qa|staging|production|release)$|^release[/-]/i;

/**
 * Starts the agent-fix and rebase-branch workflows in a target repository and
 * reads back what they concluded.
 *
 * Both dispatches go to a thin caller workflow in the target repository (see
 * `examples/workflows/`), always on an explicit ref. A dispatch returns before
 * the run exists, so the tool looks for the run briefly and otherwise says the
 * result can be read later with `get_agent_run_result`.
 */
export function createAgentFixToolModule(deps: AgentFixModuleDeps): ToolModule {
  const scope = asRepoScope(deps.repositories);
  const { github } = deps;
  const agentFixWorkflow = deps.agentFixWorkflow ?? "agent-fix.yml";
  const rebaseWorkflow = deps.rebaseWorkflow ?? "rebase-branch.yml";
  const branchPrefixes = deps.branchPrefixes ?? ["lexi/"];

  async function refOf(target: RepoTarget): Promise<string | null> {
    if (deps.workflowRef) return deps.workflowRef;
    if (target.defaultBranch) return target.defaultBranch;
    if (typeof github.getDefaultBranch !== "function") return null;
    return github.getDefaultBranch(target.owner, target.repo).catch(() => null);
  }

  async function dispatch(target: RepoTarget, workflow: string, inputs: Record<string, string>, what: string): Promise<ToolResult> {
    const ref = await refOf(target);
    if (!ref) return refused(`Could not determine which ref to dispatch ${workflow} on for ${target.slug}, so nothing was dispatched.`);
    const dispatchedAt = new Date();
    return governedWrite(
      `dispatching ${workflow} on ${target.slug}`,
      () => github.dispatchWorkflow(target.owner, target.repo, workflow, ref, inputs),
      async () => {
        const run = await correlateDispatchedRun(
          github.findDispatchedRun.bind(github),
          target.owner,
          target.repo,
          workflow,
          dispatchSearchFloor(dispatchedAt),
          deps.correlate,
        );
        return executed(
          `Dispatched ${what} on ${target.slug} (${workflow} at ${ref}). ` +
            (run
              ? `Run ${run.runId}: ${run.runUrl}. Read its result later with get_agent_run_result.`
              : "The run is not visible yet; it usually appears within a minute. Do not wait for it in this turn."),
          run ? String(run.runId) : undefined,
        );
      },
    );
  }

  const tools: AgentTool[] = [
    {
      mutating: true,
      requiredPermission: DISPATCH_AGENT_FIX_PERMISSION,
      resource: (args) => repoResource(scope, args.repository),
      definition: defineTool(
        "dispatch_agent_fix",
        "Hand a bug or small code task to the coding agent in the target repository. It investigates, files or " +
          "reuses an issue, opens a pull request, waits for CI and reports back. Pass the request verbatim, with the " +
          "thread replies that matter. To continue earlier work, pass resume_pr_number or resume_issue_number.",
        {
          repository: REPOSITORY_PROPERTY(scope),
          brief: { type: "string", description: `The bug report or task, verbatim. At most ${MAX_BRIEF_CHARS} characters.` },
          scope_hint: { type: "string", description: "Optional path hint, e.g. src/checkout. Verified, not trusted." },
          resume_issue_number: { type: "integer", description: "Existing issue to continue instead of filing a new one." },
          resume_pr_number: { type: "integer", description: "Existing pull request to continue instead of opening a new one." },
        },
        ["repository", "brief"],
      ),
      invoke: async (args, ctx) => {
        const target = scope.resolve(args.repository);
        if (!target) return refused(`${unknownRepoMessage(args.repository, scope)} Nothing was dispatched.`);
        const brief = readString(args, "brief");
        if (!brief) return refused("brief must be non-empty. Nothing was dispatched.");
        if (brief.length > MAX_BRIEF_CHARS) {
          return refused(`The brief is ${brief.length} characters; the limit is ${MAX_BRIEF_CHARS}. Shorten it (link long logs instead of pasting them). Nothing was dispatched.`);
        }
        const inputs: Record<string, string> = {
          brief,
          requester: deps.requesterName ? deps.requesterName(ctx.actorId) : ctx.actorId,
          thread_ref: `${ctx.conversation.channel}:${ctx.conversation.threadTs}`,
        };
        const scopeHint = readString(args, "scope_hint");
        if (scopeHint) inputs.scope_hint = scopeHint;
        for (const key of ["resume_issue_number", "resume_pr_number"] as const) {
          if (args[key] === undefined) continue;
          const value = readPositiveInt(args, key);
          if (!value) return refused(`${key} must be a positive integer. Nothing was dispatched.`);
          inputs[key] = String(value);
        }
        return dispatch(target, agentFixWorkflow, inputs, "the coding agent");
      },
    },
    {
      mutating: true,
      requiredPermission: REBASE_BRANCH_PERMISSION,
      resource: (args) => repoResource(scope, args.repository),
      definition: defineTool(
        "rebase_branch",
        "Rebase one agent branch onto its base and force-push it with a lease, or report a conflict without " +
          `pushing. Only branches starting with ${branchPrefixes.join(" or ") || "(any prefix)"}; never a shared ` +
          "branch. A conflict is an answer, not a failure: resolving it is a code change for dispatch_agent_fix.",
        {
          repository: REPOSITORY_PROPERTY(scope),
          branch: { type: "string", description: "The branch to rebase." },
          onto: { type: "string", description: "The base branch. Omit for the default branch." },
        },
        ["repository", "branch"],
      ),
      invoke: async (args) => {
        const target = scope.resolve(args.repository);
        if (!target) return refused(`${unknownRepoMessage(args.repository, scope)} Nothing was dispatched.`);
        let branch: string;
        let onto = "";
        try {
          branch = assertSafeBranchName(readString(args, "branch"), "branch");
          if (readString(args, "onto")) onto = assertSafeBranchName(readString(args, "onto"), "onto");
        } catch (error) {
          return refused(`${errorMessage(error)} Nothing was dispatched.`);
        }
        if (PROTECTED_BRANCH.test(branch) || branch === target.defaultBranch) {
          return refused(`${branch} is a shared branch; rebasing it would rewrite history others build on. Nothing was dispatched.`);
        }
        if (branchPrefixes.length && !branchPrefixes.some((prefix) => branch.startsWith(prefix))) {
          return refused(`Only branches starting with ${branchPrefixes.join(" or ")} can be rebased; "${branch}" does not. Nothing was dispatched.`);
        }
        if (onto === branch) return refused("A branch cannot be rebased onto itself. Nothing was dispatched.");
        return dispatch(target, rebaseWorkflow, { branch, onto }, `a rebase of ${branch}${onto ? ` onto ${onto}` : ""}`);
      },
    },
    {
      resource: (args) => repoResource(scope, readString(args, "url") ? parseRunUrl(readString(args, "url"))?.slug : args.repository),
      definition: defineTool(
        "get_agent_run_result",
        "Read what an agent-fix or rebase run concluded: shipped (with its announcement), handed back (with what a " +
          "person needs to do), rebased, already current, or conflict (with the conflicting files). A run still " +
          "going reports in_progress; read it once per turn, since re-reading does not wait.",
        {
          url: { type: "string", description: "The run URL. Preferred." },
          repository: REPOSITORY_PROPERTY(scope),
          run_id: { type: "integer" },
        },
      ),
      invoke: async (args, ctx) => {
        const url = readString(args, "url");
        const parsed = url ? parseRunUrl(url) : null;
        if (url && !parsed) return readError(`"${url}" is not a GitHub Actions run URL.`);
        const target = scope.resolve(parsed ? parsed.slug : args.repository);
        if (!target) return readError(unknownRepoMessage(parsed ? parsed.slug : args.repository, scope));
        const runId = parsed?.runId ?? readPositiveInt(args, "run_id");
        if (!runId) return readError("Pass a run url, or repository and run_id.");
        try {
          const result = await readRunResult(github, target.owner, target.repo, runId);
          return jsonResult({ repository: target.slug, runId, ...describeRunResult(result) }, ctx.maxResultChars);
        } catch (error) {
          return readError(`Could not read run ${runId} on ${target.slug}: ${redactProviderError(errorMessage(error))}`);
        }
      },
    },
  ];

  return {
    name: AGENT_FIX_MODULE_NAME,
    tools,
    intentClasses: ["bug_intake", "code_task", "issue_query", "delivery"],
    promptSections: [
      {
        stable: true,
        text:
          "AGENT FIX. dispatch_agent_fix hands work to the coding agent and returns once the run is queued, not when " +
          "it finishes; say that it has started, never that it is fixed. Report a run's outcome only from " +
          "get_agent_run_result. A hand-back is the agent asking for a person: relay what it needs.",
      },
    ],
  };
}

function describeRunResult(result: Awaited<ReturnType<typeof readRunResult>>): Record<string, unknown> {
  switch (result.state) {
    case "in_progress":
      return { status: "in_progress", runStatus: result.status };
    case "agent_fix":
      return { status: result.outcome.status, text: result.outcome.text, source: result.source, conclusion: result.conclusion };
    case "rebase":
      return {
        status: result.outcome.result.toLowerCase(),
        ...(result.outcome.conflicts.length ? { conflicts: result.outcome.conflicts } : {}),
        conclusion: result.conclusion,
      };
    case "no_result":
      return {
        status: "no_result",
        conclusion: result.conclusion,
        note: "The run finished without publishing a result, so something failed before it could report. That is not a success.",
      };
  }
}

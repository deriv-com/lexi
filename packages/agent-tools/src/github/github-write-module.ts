import type { AgentTool, ToolCallContext, ToolModule, ToolResult } from "@lexi/agent";
import { assertSafeBranchName } from "@lexi/github";
import { readBoolean, readEnum, readPositiveInt, readString, readStringArray } from "../shared/args";
import {
  REPOSITORY_PROPERTY,
  asRepoScope,
  repoResource,
  unknownRepoMessage,
  type RepoScope,
  type RepoTarget,
  type StaticRepoEntry,
} from "../shared/repo-scope";
import { errorMessage, executed, governedWrite, redactProviderError, refused, writeGateReason, writesDisabled } from "../shared/result";
import { defineTool } from "../shared/schema";
import type { GithubWriteClient } from "./github-client";
import { composePullRequestBody, hasClosingReference, PULL_REQUEST_TEMPLATE_PATHS } from "./pull-request-body";

export const GITHUB_WRITE_MODULE_NAME = "github-write";

/** The permission each write tool requires. Every name exists in the example authorization config. */
export const GITHUB_WRITE_PERMISSIONS = {
  comment_on_issue: "issue.comment",
  add_labels: "issue.update",
  remove_labels: "issue.update",
  close_issue: "issue.close",
  // Whoever may close may undo it: the reopen travels with the close.
  reopen_issue: "issue.close",
  create_branch: "branch.create",
  create_pull_request: "pr.create",
  merge_pull_request: "pr.merge",
  close_pull_request: "pr.close",
  reopen_pull_request: "pr.close",
} as const;

export interface GithubWriteModuleDeps {
  /** Pass the `GitHubMutationGateway`, so the writes-enabled / dry-run switch applies. */
  github: GithubWriteClient;
  /** The repositories these tools may write to. Anything else is refused. */
  repositories: RepoScope | ReadonlyArray<string | StaticRepoEntry>;
  /**
   * Labels the agent may add or remove: exact names (case-insensitive) or
   * patterns. The label tools are offered only when this is non-empty.
   */
  labelAllowlist?: ReadonlyArray<string | RegExp>;
  /**
   * Prefixes a branch the agent creates must start with. Defaults to
   * `["lexi/"]`, matching the agent-fix workflow's default. An empty list
   * allows any legal branch name.
   */
  branchPrefixes?: readonly string[];
  /**
   * Allow `merge_pull_request` to merge into the repository's default branch.
   * Off by default: the agent lands work through review, and merging into the
   * default branch is a person's call unless an operator decides otherwise.
   */
  allowMergeIntoDefaultBranch?: boolean;
  /** Name used in the notices the tools post. Default "Lexi". */
  agentName?: string;
}

/** GitHub's own ceiling on a comment or PR body. */
const MAX_BODY_CHARS = 65_000;

/**
 * Governed GitHub writes: comments, labels, issue close/reopen, branches and
 * pull requests.
 *
 * Every tool here is `mutating` and declares the permission it needs; the
 * registry authorizes the person asking before `invoke` runs. What remains
 * here is what authorization cannot answer: is the target in scope, are the
 * arguments sane, and does GitHub's current state allow the action. Every
 * refusal is decided from a fresh read, never from what the model says the
 * state is, and every result says whether anything actually changed.
 */
export function createGithubWriteToolModule(deps: GithubWriteModuleDeps): ToolModule {
  const scope = asRepoScope(deps.repositories);
  const { github } = deps;
  const agentName = deps.agentName ?? "Lexi";
  const branchPrefixes = deps.branchPrefixes ?? ["lexi/"];
  const labelAllowlist = deps.labelAllowlist ?? [];

  const write = (
    name: keyof typeof GITHUB_WRITE_PERMISSIONS,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    run: (target: RepoTarget, args: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolResult>,
  ): AgentTool => ({
    definition: defineTool(name, description, { repository: REPOSITORY_PROPERTY(scope), ...properties }, ["repository", ...required]),
    mutating: true,
    requiredPermission: GITHUB_WRITE_PERMISSIONS[name],
    resource: (args) => repoResource(scope, args.repository, args.number),
    invoke: async (args, ctx) => {
      const target = scope.resolve(args.repository);
      if (!target) return refused(`${unknownRepoMessage(args.repository, scope)} Nothing was changed.`);
      return run(target, args, ctx);
    },
  });

  const numberProperty = (what: string) => ({ number: { type: "integer", description: `The ${what} number.` } });

  const tools: AgentTool[] = [
    write(
      "comment_on_issue",
      "Post a comment on an issue or pull request. Use it to record something on the ticket, not to reply in chat.",
      { ...numberProperty("issue or pull request"), body: { type: "string", description: "The comment, in GitHub Markdown." } },
      ["number", "body"],
      async (target, args) => {
        const number = readPositiveInt(args, "number");
        const body = readString(args, "body");
        if (!number) return refused("number must be a positive integer. Nothing was posted.");
        if (!body) return refused("body must be non-empty. Nothing was posted.");
        if (body.length > MAX_BODY_CHARS) return refused(`body is ${body.length} characters; GitHub accepts at most ${MAX_BODY_CHARS}. Nothing was posted.`);
        return governedWrite(
          `commenting on ${target.slug}#${number}`,
          () => github.addComment(target.owner, target.repo, number, body),
          (comment) => executed(`Commented on ${target.slug}#${number}.`, String(comment.id)),
        );
      },
    ),
  ];

  if (labelAllowlist.length > 0) {
    const allowed = (label: string) =>
      labelAllowlist.some((rule) => (typeof rule === "string" ? rule.toLowerCase() === label.toLowerCase() : rule.test(label)));
    const describeAllowlist = labelAllowlist.map((rule) => (typeof rule === "string" ? rule : rule.source)).join(", ");
    const labelsProperty = {
      labels: { type: "array", items: { type: "string" }, description: `Labels. Only these are permitted: ${describeAllowlist}.` },
    };
    const checkLabels = (args: Record<string, unknown>): { labels: string[] } | { refusal: ToolResult } => {
      const labels = readStringArray(args, "labels");
      if (labels.length === 0) return { refusal: refused("labels must name at least one label. Nothing was changed.") };
      const rejected = labels.filter((label) => !allowed(label));
      if (rejected.length > 0) {
        return {
          refusal: refused(
            `Not on this deployment's label allowlist: ${rejected.join(", ")}. Permitted: ${describeAllowlist}. Nothing was changed.`,
          ),
        };
      }
      return { labels };
    };
    tools.push(
      write(
        "add_labels",
        "Add labels to an issue or pull request. Only labels on the deployment's allowlist can be added.",
        { ...numberProperty("issue or pull request"), ...labelsProperty },
        ["number", "labels"],
        async (target, args) => {
          const number = readPositiveInt(args, "number");
          if (!number) return refused("number must be a positive integer. Nothing was changed.");
          const checked = checkLabels(args);
          if ("refusal" in checked) return checked.refusal;
          return governedWrite(
            `labelling ${target.slug}#${number}`,
            () => github.addLabels(target.owner, target.repo, number, checked.labels),
            (now) => executed(`Added ${checked.labels.join(", ")} to ${target.slug}#${number}. Labels now: ${now.join(", ") || "(none)"}.`),
          );
        },
      ),
      write(
        "remove_labels",
        "Remove labels from an issue or pull request. Only labels on the deployment's allowlist can be removed.",
        { ...numberProperty("issue or pull request"), ...labelsProperty },
        ["number", "labels"],
        async (target, args) => {
          const number = readPositiveInt(args, "number");
          if (!number) return refused("number must be a positive integer. Nothing was changed.");
          const checked = checkLabels(args);
          if ("refusal" in checked) return checked.refusal;
          return governedWrite(
            `removing labels from ${target.slug}#${number}`,
            () => github.removeLabels(target.owner, target.repo, number, checked.labels),
            () => executed(`Removed ${checked.labels.join(", ")} from ${target.slug}#${number}.`),
          );
        },
      ),
    );
  }

  tools.push(
    write(
      "close_issue",
      "Close an issue, after posting the reason on it. state_reason says whether it was resolved (completed) or will " +
        "not be done (not_planned). If the reason cannot be posted the issue stays open.",
      {
        ...numberProperty("issue"),
        reason: { type: "string", description: "Why it is being closed. Posted on the issue." },
        state_reason: { type: "string", enum: ["completed", "not_planned"] },
      },
      ["number", "reason", "state_reason"],
      async (target, args) => {
        const number = readPositiveInt(args, "number");
        const reason = readString(args, "reason");
        const stateReason = readEnum(args, "state_reason", ["completed", "not_planned"] as const);
        if (!number) return refused("number must be a positive integer. Nothing was changed.");
        if (!reason) return refused("A non-empty reason is required; it is posted on the issue. Nothing was changed.");
        if (!stateReason) return refused('state_reason must be "completed" or "not_planned". Nothing was changed.');

        const read = await freshRead(() => github.getIssue(target.owner, target.repo, number), `${target.slug}#${number}`);
        if ("refusal" in read) return read.refusal;
        if (read.value.state === "closed") {
          return refused(`${target.slug}#${number} is already closed, so there is nothing to do. Nothing was changed and no comment was posted.`);
        }

        const notice = `Closing this issue (${stateReason === "completed" ? "completed" : "not planned"}).\n\n**Reason:** ${reason}\n\n_Closed via ${agentName} at a person's request. It can be reopened._`;
        try {
          await github.addComment(target.owner, target.repo, number, notice);
        } catch (error) {
          const gate = writeGateReason(error);
          if (gate) return writesDisabled(`closing ${target.slug}#${number}`, gate);
          return refused(
            `Could not post the closing reason on ${target.slug}#${number} (${redactProviderError(errorMessage(error))}), so the issue was left OPEN.`,
          );
        }
        try {
          await github.closeIssue(target.owner, target.repo, number, stateReason);
        } catch (error) {
          return refused(
            `The reason was posted on ${target.slug}#${number} but closing it failed (${redactProviderError(errorMessage(error))}), so the issue is still open. Mention that the comment now says it is being closed.`,
          );
        }
        return executed(`Closed ${target.slug}#${number} as ${stateReason} after posting the reason: "${reason}".`, String(number));
      },
    ),
    write(
      "reopen_issue",
      "Reopen a closed issue.",
      numberProperty("issue"),
      ["number"],
      async (target, args) => {
        const number = readPositiveInt(args, "number");
        if (!number) return refused("number must be a positive integer. Nothing was changed.");
        const read = await freshRead(() => github.getIssue(target.owner, target.repo, number), `${target.slug}#${number}`);
        if ("refusal" in read) return read.refusal;
        if (read.value.state === "open") return refused(`${target.slug}#${number} is already open. Nothing was changed.`);
        return governedWrite(
          `reopening ${target.slug}#${number}`,
          () => github.reopenIssue(target.owner, target.repo, number),
          () => executed(`Reopened ${target.slug}#${number}.`, String(number)),
        );
      },
    ),
    write(
      "create_branch",
      `Create a branch from an existing branch (default: the repository's default branch).` +
        (branchPrefixes.length ? ` The name must start with ${branchPrefixes.join(" or ")}.` : ""),
      {
        name: { type: "string", description: "The new branch name." },
        from: { type: "string", description: "Existing branch to start from. Omit for the default branch." },
      },
      ["name"],
      async (target, args) => {
        if (typeof github.createBranch !== "function") {
          return refused("This deployment's GitHub provider cannot create branches. Nothing was changed.");
        }
        let name: string;
        try {
          name = assertSafeBranchName(readString(args, "name"), "name");
        } catch (error) {
          return refused(`${errorMessage(error)} Nothing was changed.`);
        }
        if (branchPrefixes.length && !branchPrefixes.some((prefix) => name.startsWith(prefix))) {
          return refused(`Branch names must start with ${branchPrefixes.join(" or ")}; "${name}" does not. Nothing was changed.`);
        }
        const from = readString(args, "from") || (await defaultBranchOf(target));
        if (!from) return refused(`Could not determine ${target.slug}'s default branch; pass from explicitly. Nothing was changed.`);
        const createBranch = github.createBranch.bind(github);
        return governedWrite(
          `creating ${target.slug}:${name}`,
          () => createBranch(target.owner, target.repo, { name, from }),
          (branch) => executed(`Created branch ${branch.name} on ${target.slug} from ${from} at ${branch.sha.slice(0, 12)}.`, branch.name),
        );
      },
    ),
    write(
      "create_pull_request",
      "Open a pull request from an existing branch. The body is fitted to the repository's PR template when it has " +
        "one, and `Fixes #N` is appended when issue_number is given. Opens as a draft unless draft is false.",
      {
        title: { type: "string" },
        head: { type: "string", description: "The branch with the changes. It must already exist." },
        base: { type: "string", description: "The branch to merge into. Omit for the default branch." },
        body: { type: "string", description: "What changed and why, in GitHub Markdown." },
        issue_number: { type: "integer", description: "An issue in the same repository this PR fixes." },
        draft: { type: "boolean", description: "Default true." },
      },
      ["title", "head"],
      async (target, args) => {
        const title = readString(args, "title");
        const head = readString(args, "head");
        if (!title || !head) return refused("title and head are required. Nothing was opened.");
        const base = readString(args, "base") || (await defaultBranchOf(target));
        if (!base) return refused(`Could not determine ${target.slug}'s default branch; pass base explicitly. Nothing was opened.`);
        if (head === base) return refused(`head and base are both "${head}"; a pull request cannot merge a branch into itself. Nothing was opened.`);
        const issueNumber = args.issue_number === undefined ? undefined : readPositiveInt(args, "issue_number");
        if (args.issue_number !== undefined && !issueNumber) return refused("issue_number must be a positive integer. Nothing was opened.");

        const shaped = composePullRequestBody(readString(args, "body"), await readTemplate(target));
        const body = issueNumber && !hasClosingReference(shaped, issueNumber) ? [shaped, `Fixes #${issueNumber}`].filter(Boolean).join("\n\n") : shaped;
        if (body.length > MAX_BODY_CHARS) return refused(`The body is ${body.length} characters; GitHub accepts at most ${MAX_BODY_CHARS}. Nothing was opened.`);
        return governedWrite(
          `opening a pull request on ${target.slug} (${head} -> ${base})`,
          () => github.createPullRequest(target.owner, target.repo, { title, head, base, body: body || undefined, draft: readBoolean(args, "draft") !== false }),
          (pr) => executed(`Opened ${pr.draft ? "draft " : ""}pull request #${pr.number} on ${target.slug} (${head} -> ${base}): ${pr.url}`, String(pr.number)),
        );
      },
    ),
    write(
      "merge_pull_request",
      "Merge an open pull request into its base branch. Refuses a draft, a PR with conflicts, failing or pending " +
        "checks, or changes requested, and" +
        (deps.allowMergeIntoDefaultBranch ? "" : " any PR whose base is the repository's default branch, and") +
        " decides all of that from GitHub's current state, not from what you believe it is.",
      numberProperty("pull request"),
      ["number"],
      async (target, args) => {
        if (typeof github.mergePullRequest !== "function") {
          return refused("This deployment's GitHub provider cannot merge pull requests. Nothing was merged.");
        }
        const number = readPositiveInt(args, "number");
        if (!number) return refused("number must be a positive integer. Nothing was merged.");
        const label = `${target.slug}#${number}`;
        const read = await freshRead(() => github.getPullRequest(target.owner, target.repo, number), label);
        if ("refusal" in read) return read.refusal;
        const pr = read.value;
        if (pr.merged || pr.mergedAt) return refused(`${label} is already merged. Nothing was changed.`);
        if (pr.state === "closed") return refused(`${label} is closed. Reopen it first if it should be merged. Nothing was merged.`);
        if (pr.draft) return refused(`${label} is a draft; a person has to mark it ready for review first. Nothing was merged.`);
        if (pr.mergeable === false) return refused(`${label} has merge conflicts with its base. Nothing was merged.`);

        if (!deps.allowMergeIntoDefaultBranch) {
          const defaultBranch = await defaultBranchOf(target);
          if (!defaultBranch || !pr.baseRef) {
            return refused(`Could not confirm that ${label} does not target the default branch, so nothing was merged.`);
          }
          if (pr.baseRef === defaultBranch) {
            return refused(
              `${label} targets ${defaultBranch}, the default branch. Merging into the default branch is left to a person in this deployment. Nothing was merged.`,
            );
          }
        }

        if (typeof github.getReviewStatus !== "function") {
          return refused(`The checks on ${label} cannot be read by this provider, and a merge needs them. Nothing was merged.`);
        }
        let status;
        try {
          status = await github.getReviewStatus(target.owner, target.repo, number);
        } catch (error) {
          return refused(`Could not read the checks on ${label} (${redactProviderError(errorMessage(error))}). Nothing was merged.`);
        }
        if (!status || status.checksRead === false) {
          return refused(`The checks on ${label} could not be read, which is not the same as passing. Nothing was merged.`);
        }
        const unfinished = status.checks.filter((c) => c.status !== "completed").map((c) => c.name);
        const failing = status.checks
          .filter((c) => c.status === "completed" && !["success", "neutral", "skipped"].includes(c.conclusion ?? ""))
          .map((c) => `${c.name} (${c.conclusion ?? "unknown"})`);
        if (failing.length) return refused(`${label} has failing checks: ${failing.join(", ")}. Nothing was merged.`);
        if (unfinished.length) return refused(`${label} still has checks running: ${unfinished.join(", ")}. Nothing was merged.`);
        const changesRequested = latestReviewStates(status.reviews).filter(([, state]) => state === "CHANGES_REQUESTED").map(([who]) => who);
        if (changesRequested.length) return refused(`${changesRequested.join(", ")} requested changes on ${label}. Nothing was merged.`);

        const merge = github.mergePullRequest.bind(github);
        return governedWrite(
          `merging ${label}`,
          () => merge(target.owner, target.repo, number, pr.headSha ? { sha: pr.headSha } : {}),
          (result) =>
            result.merged
              ? executed(`Merged ${label} into ${pr.baseRef}${result.sha ? ` as ${result.sha.slice(0, 12)}` : ""}.`, result.sha ?? String(number))
              : refused(`GitHub did not merge ${label}: ${result.message}. Nothing was merged.`),
        );
      },
    ),
    write(
      "close_pull_request",
      "Close a pull request without merging it, after posting the reason on it. Refuses a merged PR. If the reason " +
        "cannot be posted the PR stays open. The branch and its commits are untouched, so it can be reopened.",
      { ...numberProperty("pull request"), reason: { type: "string", description: "Why. Posted on the PR for whoever opened it." } },
      ["number", "reason"],
      async (target, args) => {
        const number = readPositiveInt(args, "number");
        const reason = readString(args, "reason");
        if (!number) return refused("number must be a positive integer. Nothing was changed.");
        if (!reason) return refused("A non-empty reason is required; it is posted on the pull request. Nothing was changed.");
        const label = `${target.slug}#${number}`;
        const read = await freshRead(() => github.getPullRequest(target.owner, target.repo, number), label);
        if ("refusal" in read) return read.refusal;
        const pr = read.value;
        if (pr.merged || pr.mergedAt) {
          return refused(`${label} was merged and cannot be closed; its work is already in the base branch. Reverting it is a new pull request. Nothing was changed.`);
        }
        if (pr.state === "closed") return refused(`${label} is already closed, so there is nothing to do. Nothing was changed.`);

        try {
          await github.addComment(
            target.owner,
            target.repo,
            number,
            `Closing this pull request without merging.\n\n**Reason:** ${reason}\n\n_Closed via ${agentName} at a person's request. The branch and its commits are untouched, so it can be reopened._`,
          );
        } catch (error) {
          const gate = writeGateReason(error);
          if (gate) return writesDisabled(`closing ${label}`, gate);
          return refused(`Could not post the closing reason on ${label} (${redactProviderError(errorMessage(error))}), so the pull request was left OPEN.`);
        }
        try {
          await github.closePullRequest(target.owner, target.repo, number);
        } catch (error) {
          return refused(
            `The reason was posted on ${label} but closing it failed (${redactProviderError(errorMessage(error))}), so it is still open. Mention that the comment now says it is being closed.`,
          );
        }
        return executed(`Closed ${label} without merging after posting the reason: "${reason}". It can be reopened while its branch exists.`, String(number));
      },
    ),
    write(
      "reopen_pull_request",
      "Reopen a closed, unmerged pull request. Refuses a merged PR, and one whose head branch has been deleted.",
      numberProperty("pull request"),
      ["number"],
      async (target, args) => {
        const number = readPositiveInt(args, "number");
        if (!number) return refused("number must be a positive integer. Nothing was changed.");
        const label = `${target.slug}#${number}`;
        const read = await freshRead(() => github.getPullRequest(target.owner, target.repo, number), label);
        if ("refusal" in read) return read.refusal;
        const pr = read.value;
        if (pr.merged || pr.mergedAt) return refused(`${label} was merged and cannot be reopened. Nothing was changed.`);
        if (pr.state === "open") return refused(`${label} is already open. Nothing was changed.`);
        if (pr.headRef && typeof github.branchExists === "function") {
          // A probe that cannot answer does not block the recovery; GitHub's
          // own rejection is the backstop.
          const exists = await github.branchExists(target.owner, target.repo, pr.headRef).catch(() => null);
          if (exists === false) {
            return refused(`${label} cannot be reopened because its head branch "${pr.headRef}" no longer exists. Restoring it needs the branch or a new pull request. Nothing was changed.`);
          }
        }
        return governedWrite(
          `reopening ${label}`,
          () => github.reopenPullRequest(target.owner, target.repo, number),
          () => executed(`Reopened ${label}. Its commits are unchanged.`, String(number)),
        );
      },
    ),
  );

  async function defaultBranchOf(target: RepoTarget): Promise<string | null> {
    if (target.defaultBranch) return target.defaultBranch;
    if (typeof github.getDefaultBranch !== "function") return null;
    return github.getDefaultBranch(target.owner, target.repo).catch(() => null);
  }

  async function readTemplate(target: RepoTarget): Promise<string | null> {
    for (const path of PULL_REQUEST_TEMPLATE_PATHS) {
      const content = await github.getFileContents(target.owner, target.repo, path).catch(() => null);
      if (content) return content;
    }
    return null;
  }

  return {
    name: GITHUB_WRITE_MODULE_NAME,
    tools,
    promptSections: [
      {
        stable: true,
        text:
          "GITHUB WRITES. These tools change GitHub. Use them only when the person asked for that change. Each " +
          "result says whether it was carried out: report a refusal or a dry run as exactly that, never as done.",
      },
    ],
  };
}

async function freshRead<T>(read: () => Promise<T>, label: string): Promise<{ value: T } | { refusal: ToolResult }> {
  try {
    return { value: await read() };
  } catch (error) {
    return {
      refusal: refused(
        `Could not read ${label} (${redactProviderError(errorMessage(error))}), so nothing was changed. It may not exist or may not be visible to this installation.`,
      ),
    };
  }
}

function latestReviewStates(reviews: Array<{ reviewer: string; state: string; submittedAt: Date }>): Array<[string, string]> {
  const latest = new Map<string, string>();
  for (const review of [...reviews].sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime())) {
    if (review.state !== "COMMENTED" && review.state !== "PENDING") latest.set(review.reviewer, review.state);
  }
  return [...latest.entries()];
}


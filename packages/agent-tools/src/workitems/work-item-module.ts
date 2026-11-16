import type { AgentTool, ToolModule } from "@lexi/agent";
import type { GitHubProvider } from "@lexi/github";
import { readString, readStringArray } from "../shared/args";
import { REPOSITORY_PROPERTY, registryRepoScope, repoResource, unknownRepoMessage, type RepoRegistryLike } from "../shared/repo-scope";
import { executed, governedWrite, jsonResult, refused } from "../shared/result";
import { defineTool } from "../shared/schema";

export const WORK_ITEM_MODULE_NAME = "work-items";
export const CREATE_ISSUE_PERMISSION = "work_item.create";

export interface WorkItemModuleDeps {
  /** The role-aware registry from `@lexi/workitems` (`loadRepoRegistry`). */
  registry: RepoRegistryLike;
  /** Pass the `GitHubMutationGateway`, so the writes-enabled / dry-run switch applies. */
  github: Pick<GitHubProvider, "createIssue">;
  /** Labels `create_issue` may apply: exact names (case-insensitive) or patterns. Empty means none. */
  labelAllowlist?: ReadonlyArray<string | RegExp>;
}

const MAX_BODY_CHARS = 65_000;

/**
 * Work-item tools over the repository registry: list the registered
 * repositories and their roles, and file an issue into a repository whose
 * role accepts issues. Only repositories with the `issues` role, and never a
 * placeholder, can receive one.
 */
export function createWorkItemToolModule(deps: WorkItemModuleDeps): ToolModule {
  const { registry, github } = deps;
  const issueScope = registryRepoScope(registry, "issues");
  const labelAllowlist = deps.labelAllowlist ?? [];
  const allowed = (label: string) =>
    labelAllowlist.some((rule) => (typeof rule === "string" ? rule.toLowerCase() === label.toLowerCase() : rule.test(label)));

  const tools: AgentTool[] = [
    {
      definition: defineTool(
        "list_repositories",
        "List the repositories this deployment knows: key, owner/repo, platform, team and roles (issues, code, " +
          "specs). Use it to pick a repository rather than guessing one.",
        {},
      ),
      invoke: async (_args, ctx) =>
        jsonResult(
          registry.listRepos().map((repo) => ({
            key: repo.key,
            repository: repo.slug,
            platform: repo.platform ?? null,
            team: repo.team ?? null,
            roles: repo.roles,
            defaultBranch: repo.defaultBranch ?? null,
          })),
          ctx.maxResultChars,
        ),
    },
    {
      mutating: true,
      requiredPermission: CREATE_ISSUE_PERMISSION,
      resource: (args) => repoResource(issueScope, args.repository),
      definition: defineTool(
        "create_issue",
        "File a new issue in a repository that accepts issues. Search for an existing issue first so you do not " +
          "file a duplicate." +
          (labelAllowlist.length ? "" : " Labels cannot be applied in this deployment."),
        {
          repository: { ...REPOSITORY_PROPERTY(issueScope), description: `Registry key or owner/repo. One of: ${issueScope.describe()}.` },
          title: { type: "string" },
          body: { type: "string", description: "What, where, and how to reproduce, in GitHub Markdown." },
          labels: { type: "array", items: { type: "string" } },
        },
        ["repository", "title", "body"],
      ),
      invoke: async (args) => {
        const target = issueScope.resolve(args.repository);
        if (!target) return refused(`${unknownRepoMessage(args.repository, issueScope)} No issue was created.`);
        const title = readString(args, "title");
        const body = readString(args, "body");
        if (!title) return refused("title is required. No issue was created.");
        if (body.length > MAX_BODY_CHARS) return refused(`body is ${body.length} characters; GitHub accepts at most ${MAX_BODY_CHARS}. No issue was created.`);
        const labels = readStringArray(args, "labels");
        const rejected = labels.filter((label) => !allowed(label));
        if (rejected.length) return refused(`These labels are not permitted here: ${rejected.join(", ")}. No issue was created.`);
        return governedWrite(
          `filing an issue in ${target.slug}`,
          () => github.createIssue(target.owner, target.repo, title, body, labels.length ? labels : undefined),
          (issue) => executed(`Filed ${target.slug}#${issue.githubNumber}: ${issue.url}`, String(issue.githubNumber)),
        );
      },
    },
  ];

  return {
    name: WORK_ITEM_MODULE_NAME,
    tools,
    promptSections: [
      {
        stable: true,
        text: "WORK ITEMS. Use list_repositories to pick a repository by its registered key. Before create_issue, search for an existing issue so you do not file a duplicate.",
      },
    ],
  };
}

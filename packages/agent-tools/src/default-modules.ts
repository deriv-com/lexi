import type { ToolModule } from "@lexi/agent";
import type { KnowledgeSearchPort } from "@lexi/memory";
import type { SlackProvider } from "@lexi/slack";
import type { CorrelateDispatchedRunOptions } from "@lexi/github";
import { createAgentFixToolModule } from "./agent-fix/agent-fix-module";
import type { GithubDispatchClient, GithubReadClient, GithubWriteClient } from "./github/github-client";
import { createGithubReadToolModule } from "./github/github-read-module";
import { createGithubWriteToolModule } from "./github/github-write-module";
import { createMemoryToolModule, type MemoryToolsPort } from "./memory/memory-module";
import { asRepoScope, registryRepoScope, type RepoRegistryLike, type RepoScope, type StaticRepoEntry } from "./shared/repo-scope";
import { createSlackToolModule, type SlackThreadReader } from "./slack/slack-module";
import { createSpecToolModule, type SpecToolExecutor } from "./specs/spec-module";
import { createWorkItemToolModule } from "./workitems/work-item-module";

/** Everything a basic deployment can hand over. Every field is optional. */
export interface DefaultToolModuleDeps {
  /** The `GitHubMutationGateway` (or anything with the same shape). */
  github?: GithubReadClient & GithubWriteClient & GithubDispatchClient;
  /** The repositories the GitHub tools work with. Takes precedence over `registry`. */
  repositories?: RepoScope | ReadonlyArray<string | StaticRepoEntry>;
  /**
   * The repository registry from `@lexi/workitems`. Without `repositories`,
   * reads cover every registered repository and writes and dispatch cover
   * those with the `code` role (placeholders excluded). It also enables the
   * work-item tools.
   */
  registry?: RepoRegistryLike;
  slackReader?: SlackThreadReader;
  /** Pass `@lexi/slack`'s `SlackMutationGateway`. */
  slackPoster?: SlackProvider;
  channelAllowlist?: readonly string[];
  memory?: MemoryToolsPort;
  knowledge?: KnowledgeSearchPort;
  specExecutor?: SpecToolExecutor;
  options?: {
    /** Set false to leave the GitHub write tools out. */
    githubWrites?: boolean;
    /** Set false to leave the agent-fix tools out. */
    agentFix?: boolean;
    /**
     * Gates every read-only tool that declares no permission of its own, so a
     * person the policy does not list can read nothing through the agent.
     */
    readPermission?: string;
    labelAllowlist?: ReadonlyArray<string | RegExp>;
    branchPrefixes?: readonly string[];
    allowMergeIntoDefaultBranch?: boolean;
    agentName?: string;
    workflowRef?: string;
    agentFixWorkflow?: string;
    rebaseWorkflow?: string;
    correlate?: CorrelateDispatchedRunOptions;
  };
}

/**
 * The tool modules a basic deployment registers, built from whatever it has.
 * A module whose dependency is absent is left out rather than registered in a
 * state where every call fails.
 */
export function createDefaultToolModules(deps: DefaultToolModuleDeps): ToolModule[] {
  const options = deps.options ?? {};
  const modules: ToolModule[] = [];

  const explicit = deps.repositories ? asRepoScope(deps.repositories) : undefined;
  const readScope = explicit ?? (deps.registry ? registryRepoScope(deps.registry) : undefined);
  const writeScope = explicit ?? (deps.registry ? registryRepoScope(deps.registry, "code") : undefined);

  if (deps.github && readScope) {
    modules.push(createGithubReadToolModule({ github: deps.github, repositories: readScope, readPermission: options.readPermission }));
  }
  if (deps.github && writeScope && options.githubWrites !== false) {
    modules.push(
      createGithubWriteToolModule({
        github: deps.github,
        repositories: writeScope,
        labelAllowlist: options.labelAllowlist,
        branchPrefixes: options.branchPrefixes,
        allowMergeIntoDefaultBranch: options.allowMergeIntoDefaultBranch,
        agentName: options.agentName,
      }),
    );
  }
  if (deps.github && writeScope && options.agentFix !== false) {
    modules.push(
      createAgentFixToolModule({
        github: deps.github,
        repositories: writeScope,
        branchPrefixes: options.branchPrefixes,
        workflowRef: options.workflowRef,
        agentFixWorkflow: options.agentFixWorkflow,
        rebaseWorkflow: options.rebaseWorkflow,
        correlate: options.correlate,
      }),
    );
  }
  if (deps.github && deps.registry) {
    modules.push(createWorkItemToolModule({ registry: deps.registry, github: deps.github, labelAllowlist: options.labelAllowlist }));
  }
  if (deps.slackReader || deps.slackPoster) {
    modules.push(createSlackToolModule({ reader: deps.slackReader, poster: deps.slackPoster, channelAllowlist: deps.channelAllowlist }));
  }
  if (deps.memory) {
    modules.push(createMemoryToolModule({ memory: deps.memory, knowledge: deps.knowledge, ...(readScope ? { repositories: readScope } : {}) }));
  }
  if (deps.specExecutor) {
    modules.push(
      createSpecToolModule({
        executor: deps.specExecutor,
        repositories: explicit ?? (deps.registry ? registryRepoScope(deps.registry, "specs") : undefined),
      }),
    );
  }
  return options.readPermission ? modules.map((module) => governReads(module, options.readPermission as string)) : modules;
}

/** Gives every read-only, ungoverned tool in the module the read permission. */
function governReads(module: ToolModule, permission: string): ToolModule {
  return {
    ...module,
    tools: module.tools.map((tool) => (tool.mutating || tool.requiredPermission ? tool : { ...tool, requiredPermission: permission })),
  };
}

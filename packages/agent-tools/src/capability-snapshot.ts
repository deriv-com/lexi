import path from "node:path";
import { ToolRegistry, type ToolModule } from "@lexi/agent";
import { classifiedActions, loadGrantablePermissions, type CapabilitySnapshot } from "@lexi/governance";
import { createDefaultToolModules, type DefaultToolModuleDeps } from "./default-modules";
import type { RepoRegistryLike } from "./shared/repo-scope";

/**
 * An object whose every method throws. The snapshot only constructs the tool
 * modules to read their names and permissions; nothing is ever invoked, and if
 * something were, it should fail loudly rather than reach a real service.
 */
function inert<T>(label: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        // Not a thenable, so nothing mistakes the stub for a promise.
        if (prop === "then" || typeof prop === "symbol") return undefined;
        return () => {
          throw new Error(`${label}.${String(prop)} called while building the capability matrix`);
        };
      },
    },
  ) as T;
}

const NO_REPOS: RepoRegistryLike = { listRepos: () => [], reposWithRole: () => [] };

/** Every module the default set can build, each with a dependency that is never called. */
export function allDefaultToolModules(options: DefaultToolModuleDeps["options"] = {}): ToolModule[] {
  const deps: DefaultToolModuleDeps = {
    github: inert("github"),
    repositories: ["acme/web"],
    registry: NO_REPOS,
    slackReader: inert("slackReader"),
    slackPoster: inert("slackPoster"),
    memory: inert("memory"),
    knowledge: inert("knowledge"),
    specExecutor: inert("specExecutor"),
    options,
  };
  return createDefaultToolModules(deps);
}

/** The example policy shipped with the repository, relative to this package. */
export const EXAMPLE_AUTHORIZATION_PATH = path.resolve(__dirname, "../../../examples/config/authorization.yaml");

/**
 * The snapshot `docs/capability-matrix.md` is rendered from: every default
 * tool module, registered through the real `ToolRegistry` (so a duplicate name
 * or a mutating tool without a permission throws here, as it would at boot),
 * plus the action classes and what the policy's roles can hold.
 */
export function buildCapabilitySnapshot(
  options: { modules?: ToolModule[]; authorizationPath?: string; authorizationSource?: string } = {},
): CapabilitySnapshot {
  const modules = options.modules ?? allDefaultToolModules();
  const registry = new ToolRegistry();
  for (const module of modules) registry.register(module);

  const authorizationPath = options.authorizationPath ?? EXAMPLE_AUTHORIZATION_PATH;
  return {
    modules: modules.map((module) => ({
      name: module.name,
      intentClasses: [...(module.intentClasses ?? [])],
      tools: module.tools.map((tool) => ({
        name: tool.definition.name,
        mutating: tool.mutating === true,
        ...(tool.requiredPermission ? { requiredPermission: tool.requiredPermission } : {}),
      })),
    })),
    actionClasses: classifiedActions(),
    grantablePermissions: loadGrantablePermissions(authorizationPath),
    authorizationSource: options.authorizationSource ?? "examples/config/authorization.yaml",
  };
}

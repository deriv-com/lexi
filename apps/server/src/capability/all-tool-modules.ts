import type { ToolModule } from "@lexi/agent";
import { allDefaultToolModules } from "@lexi/agent-tools";
import { AppBuildService, createAppBuildToolModule } from "@lexi/app-build";
import { createProgrammeToolModule } from "@lexi/programme";
import { ACTIONS_READ_PERMISSION, READ_PERMISSION } from "../wiring/runtime-wiring";

/**
 * Every tool module this server can register, for the capability matrix.
 *
 * The opt-in modules (app-build, programme) are built as if switched on, so
 * the matrix shows what a deployment that enables them grants. Reads carry
 * the same permissions the server gives them. Their
 * dependencies throw if called; building a module never calls them.
 */
export function allToolModules(): ToolModule[] {
  const appBuild = new AppBuildService({ github: inert("github"), store: inert("store") });
  return [
    ...allDefaultToolModules({ readPermission: READ_PERMISSION }),
    createAppBuildToolModule({ service: appBuild, repositories: ["acme/web"], readPermission: ACTIONS_READ_PERMISSION }),
    createProgrammeToolModule({ build: inert("build"), programmeEnabled: true, allowedRepoKeys: ["web"] }),
  ];
}

function inert<T>(label: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        return () => {
          throw new Error(`${label}.${String(prop)} called while building the capability matrix`);
        };
      },
    },
  ) as T;
}

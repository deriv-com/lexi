/**
 * Capability matrix rendering.
 *
 * The capability matrix is what a security reviewer reads to decide what the
 * agent can do, so it is generated from the live tool registry rather than
 * maintained by hand, and a test fails when the committed document differs
 * from what the registry would render.
 *
 * This package only renders. The tools themselves live in `@lexi/agent-tools`,
 * which depends on this package, so the snapshot is built there (by
 * instantiating the real tool modules) and handed in as plain records. Nothing
 * here imports a tool, which keeps the dependency pointing one way.
 */

import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import {
  classifyAction,
  getActionsByClass,
  type ActionClass,
  type ActionClassification,
} from "../blast-radius/action-classification";
import { authorizationConfigSchema, type AuthorizationConfig } from "../authorization/authorization.schema";
import { AuthorizationService } from "../authorization/authorization.service";
import { governanceConfigPath } from "../config/config-dir";

/** One tool as the matrix sees it: never its schema, only what governs it. */
export interface CapabilityToolRecord {
  name: string;
  /** Changes something outside the agent. */
  mutating: boolean;
  /** The permission the acting person needs, when the tool is governed. */
  requiredPermission?: string;
}

/** One tool module: a group of tools offered together. */
export interface CapabilityModuleRecord {
  name: string;
  /** Request classes the module is offered for. Empty means it is offered for every request. */
  intentClasses: string[];
  tools: CapabilityToolRecord[];
}

export interface CapabilitySnapshot {
  modules: CapabilityModuleRecord[];
  actionClasses: ActionClassification[];
  /** Every permission some role in the authorization policy can hold. */
  grantablePermissions: string[];
  /** Where the policy was read from, as shown in the document. */
  authorizationSource: string;
}

/** Every classified action, sorted by name. */
export function classifiedActions(): ActionClassification[] {
  const classes: ActionClass[] = ["constructive", "delayed_reversible", "human_gated", "prohibited"];
  return classes
    .flatMap((cls) => getActionsByClass(cls))
    .map((entry) => classifyAction(entry.action))
    .sort((a, b) => a.action.localeCompare(b.action));
}

/** Every permission any role in `config` can hold, inheritance included. */
export function grantablePermissions(config: AuthorizationConfig): string[] {
  const all = new Set<string>();
  for (const role of Object.keys(config.roles)) {
    const service = new AuthorizationService({ ...config, users: { U0PROBE1: { roles: [role] } } });
    for (const permission of service.getEffectivePermissions("U0PROBE1")) all.add(permission);
  }
  return [...all].sort();
}

/** Reads an authorization policy file and returns what its roles can hold. */
export function loadGrantablePermissions(authorizationPath: string = governanceConfigPath("authorization.yaml")): string[] {
  return grantablePermissions(authorizationConfigSchema.parse(loadYaml(readFileSync(authorizationPath, "utf8"))));
}

/**
 * What is wrong with a snapshot, as human-readable lines. Empty means nothing.
 *
 * Catches the failures a reviewer cannot see from the table alone: a tool name
 * declared twice, a mutating tool with no permission, and a permission no role
 * can hold, which means the tool is offered to the model while every call to
 * it is denied.
 */
export function capabilityProblems(snapshot: CapabilitySnapshot): string[] {
  const grantable = new Set(snapshot.grantablePermissions);
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const module of snapshot.modules) {
    for (const tool of module.tools) {
      const previous = seen.get(tool.name);
      if (previous) problems.push(`${tool.name} is declared by both ${previous} and ${module.name}`);
      seen.set(tool.name, module.name);
      if (tool.mutating && !tool.requiredPermission) problems.push(`${tool.name} changes things but declares no permission`);
      if (tool.requiredPermission && !grantable.has(tool.requiredPermission)) {
        problems.push(`${tool.name} needs ${tool.requiredPermission}, which no role in ${snapshot.authorizationSource} grants`);
      }
    }
  }
  return problems;
}

/** Whole days stay `Nd`. Anything shorter is hours, so 20h does not render as 0.833d. */
export function formatGracePeriod(ms: number): string {
  if (ms === 0) return "—";
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  if (ms % day === 0) return `${ms / day}d`;
  return `${ms / hour}h`;
}

/** The whole of `docs/capability-matrix.md`. Deterministic: the same snapshot renders the same bytes. */
export function renderCapabilityMatrix(snapshot: CapabilitySnapshot): string {
  const tools = snapshot.modules.flatMap((m) => m.tools.map((t) => ({ ...t, module: m.name })));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const mutating = tools.filter((t) => t.mutating).sort(byName);
  const others = tools.filter((t) => !t.mutating).sort(byName);

  const lines: string[] = [
    "# Capability matrix",
    "",
    "<!-- Generated. Do not edit by hand: change the tools or the policy and run",
    "     `npm run docs:capability-matrix`. A spec fails when this file is stale. -->",
    "",
    "Everything the agent can do is a tool in a tool module. This page lists every tool the",
    "default modules register, whether it changes anything, and the permission the person",
    "asking must hold. The tool registry checks that permission before the tool runs, against",
    "the person who asked rather than anything the model says, and refuses when it cannot decide.",
    "",
    `**${snapshot.modules.length} modules, ${tools.length} tools: ${mutating.length} change something outside the agent, ${others.length} do not.**`,
    "",
    `Permissions are checked against \`${snapshot.authorizationSource}\`.`,
    "",
    "## Modules",
    "",
    "| Module | Offered for | Tools | Changing |",
    "|--------|-------------|-------|----------|",
  ];
  for (const module of snapshot.modules) {
    const offered = module.intentClasses.length ? module.intentClasses.map((c) => `\`${c}\``).join(", ") : "every request";
    lines.push(`| \`${module.name}\` | ${offered} | ${module.tools.length} | ${module.tools.filter((t) => t.mutating).length} |`);
  }

  lines.push("", "## Tools that change something outside the agent", "", "| Tool | Module | Required permission |", "|------|--------|---------------------|");
  for (const tool of mutating) {
    lines.push(`| \`${tool.name}\` | \`${tool.module}\` | \`${tool.requiredPermission ?? "none"}\` |`);
  }

  lines.push(
    "",
    "## Tools that change nothing outside the agent",
    "",
    "These read, or write only to the agent's own memory. A permission here still gates the call.",
    "",
    "| Tool | Module | Required permission |",
    "|------|--------|---------------------|",
  );
  for (const tool of others) {
    lines.push(`| \`${tool.name}\` | \`${tool.module}\` | ${tool.requiredPermission ? `\`${tool.requiredPermission}\`` : "—"} |`);
  }

  lines.push(
    "",
    "## Action classes",
    "",
    "Every mutation carries an action class that decides how it is executed. An action the",
    "classifier does not know is treated as `human_gated`.",
    "",
    "| Action | Class | Confirmation | Grace period |",
    "|--------|-------|--------------|--------------|",
  );
  for (const action of snapshot.actionClasses) {
    lines.push(
      `| \`${action.action}\` | ${action.actionClass} | ${action.requiresConfirmation ? "required" : "—"} | ${formatGracePeriod(action.gracePeriodMs)} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

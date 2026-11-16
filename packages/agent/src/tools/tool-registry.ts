import { notify, type AgentObserver } from "../observer";
import type { AgentTool, PromptSection, ToolCallContext, ToolDefinition, ToolModule, ToolResult } from "./agent-tool";
import { DENY_ALL, type Authorizer } from "./authorizer";

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ToolRegistryOptions {
  /** Decides governed actions. Defaults to denying all of them. */
  authorizer?: Authorizer;
  observer?: AgentObserver;
}

/**
 * Looks tools up by name, authorizes, then dispatches.
 *
 * The rules, all fail-closed:
 * - A tool the registry does not know is refused; the model invented it.
 * - A tool with `requiredPermission` runs only when the authorizer says yes.
 *   A thrown error, a rejection or a malformed verdict counts as no, and so
 *   does a `resource()` that throws.
 * - A mutating tool without `requiredPermission` cannot be registered.
 * - A tool that throws becomes an error result; nothing escapes the registry.
 */
export class ToolRegistry {
  private readonly modules: ToolModule[] = [];
  private readonly tools = new Map<string, AgentTool>();
  private readonly authorizer: Authorizer;
  private readonly observer?: AgentObserver;

  constructor(options: ToolRegistryOptions = {}) {
    this.authorizer = options.authorizer ?? DENY_ALL;
    this.observer = options.observer;
  }

  /** Adds a module. Throws on an invalid tool or a duplicate name. */
  register(module: ToolModule): this {
    for (const tool of module.tools) {
      const name = tool.definition?.name;
      if (!name || !TOOL_NAME.test(name)) {
        throw new Error(`Module "${module.name}" has a tool with an invalid name: ${JSON.stringify(name)}`);
      }
      if (this.tools.has(name)) {
        throw new Error(`Tool "${name}" is registered twice (second time by module "${module.name}")`);
      }
      if (tool.mutating && !tool.requiredPermission) {
        throw new Error(`Mutating tool "${name}" must declare requiredPermission`);
      }
    }
    for (const tool of module.tools) this.tools.set(tool.definition.name, tool);
    this.modules.push(module);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /**
   * The schemas to send for one request. With an intent class, only core
   * modules and modules that declare that class; `"unknown"` or no class
   * sends everything, because subsetting must never remove a capability.
   */
  definitions(intentClass?: string): ToolDefinition[] {
    return this.selectModules(intentClass).flatMap((m) => m.tools.map((t) => t.definition));
  }

  /** The prompt sections of the modules selected for this request, in order. */
  promptSections(intentClass?: string): PromptSection[] {
    return this.selectModules(intentClass).flatMap((m) => m.promptSections ?? []);
  }

  async invoke(name: string, args: unknown, ctx: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const input = isPlainObject(args) ? args : {};
    const finish = (result: ToolResult, refused?: "unknown_tool" | "unauthorized" | "invalid_tool"): ToolResult => {
      notify(this.observer, "onToolCall", { name, args: input, ctx, result, durationMs: Date.now() - started, refused });
      return result;
    };

    const tool = this.tools.get(name);
    if (!tool) {
      return finish({ isError: true, content: `There is no tool named "${name}". Use only the tools you were given.` }, "unknown_tool");
    }
    if (!isPlainObject(args)) {
      return finish({ isError: true, content: `Tool "${name}" needs its arguments as a JSON object.` }, "invalid_tool");
    }

    if (tool.requiredPermission) {
      const verdict = await this.authorize(tool, input, ctx);
      if (!verdict.allowed) {
        return finish(
          {
            isError: true,
            content: `Not authorized: ${verdict.reason}`,
            outcome: { authorized: false, executed: false, blocked: true, reason: verdict.reason },
          },
          "unauthorized",
        );
      }
    }

    try {
      const result = await tool.invoke(input, ctx);
      if (!result || (typeof result.content !== "string" && !Array.isArray(result.content))) {
        return finish({ isError: true, content: `Tool "${name}" returned no result.` });
      }
      return finish(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finish({
        isError: true,
        content: `Tool "${name}" failed: ${message}`,
        ...(tool.mutating
          ? { outcome: { authorized: true, executed: false, blocked: false, reason: `failed: ${message}` } }
          : {}),
      });
    }
  }

  private async authorize(
    tool: AgentTool,
    args: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<{ allowed: boolean; reason: string }> {
    try {
      if (!ctx.actorId) return { allowed: false, reason: "the request has no identifiable person behind it" };
      const resource = await tool.resource?.(args, ctx);
      const verdict = await this.authorizer.authorize({
        actorId: ctx.actorId,
        action: tool.requiredPermission as string,
        ...(resource ? { resource } : {}),
      });
      if (!verdict || verdict.allowed !== true) {
        return { allowed: false, reason: verdict?.reason || "the authorizer did not allow it" };
      }
      return { allowed: true, reason: verdict.reason };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { allowed: false, reason: `authorization could not be checked (${message})` };
    }
  }

  private selectModules(intentClass?: string): ToolModule[] {
    if (!intentClass || intentClass === "unknown") return this.modules;
    return this.modules.filter((m) => !m.intentClasses?.length || m.intentClasses.includes(intentClass));
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

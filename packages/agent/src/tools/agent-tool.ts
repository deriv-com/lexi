/**
 * The tool contract every agent capability implements.
 *
 * A tool is a schema the model sees plus an `invoke` the registry calls. The
 * model never sees `requiredPermission`: authorization is enforced by the
 * registry at invoke time, against the identity of the person who asked, not
 * against anything the model says about them.
 */

/** The schema sent to the model (Anthropic `input_schema` shape). */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ToolImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** What a tool hands back to the model: text, or text and images. */
export type ToolResultContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: ToolImageMediaType; data: string } }
    >;

/**
 * The outcome of a governed (mutating) action. The agent must report this
 * honestly: never say something was done when `executed` is false.
 */
export interface GovernedOutcome {
  authorized: boolean;
  executed: boolean;
  blocked: boolean;
  reason: string;
  /** Identifier of the audit record, when the deployment keeps one. */
  auditId?: string;
}

export interface ToolResult {
  content: ToolResultContent;
  /** The call failed. The model sees the content and may try something else. */
  isError?: boolean;
  /** Present for mutating tools; the registry fills it in when it refuses one. */
  outcome?: GovernedOutcome;
}

/** Where the request came from. Opaque to the runtime; tools may read it. */
export interface ConversationRef {
  /** Chat channel (or other surface) identifier. */
  channel: string;
  /** Thread identifier within the channel. */
  threadTs: string;
}

/** Per-call context the registry passes to `invoke`. */
export interface ToolCallContext {
  /** The person the agent is acting for. Authorization is checked against this. */
  actorId: string;
  conversation: ConversationRef;
  /**
   * Upper bound, in characters, for this result. Tools that can return a lot
   * (file contents, logs, search results) should truncate to it and say so,
   * rather than let the loop drop the whole result.
   */
  maxResultChars: number;
  /** Aborted when the turn is cancelled or runs out of time. */
  signal?: AbortSignal;
}

/** The resource an action targets, for scoped authorization. */
export interface AuthorizationResource {
  repository?: string;
  issueNumber?: number;
  team?: string;
  assignee?: string;
  /**
   * The call touches only what belongs to the caller: their own personal
   * memory, or the conversation they asked in. A team- or repository-scoped
   * grant covers such a call; it covers nothing else that names no team or
   * repository. Set it only where that is true, never as a way to make a
   * scoped grant pass.
   */
  callerOnly?: boolean;
}

export interface AgentTool<Args extends Record<string, unknown> = Record<string, unknown>> {
  definition: ToolDefinition;
  /**
   * The permission the actor needs. Required for every mutating tool; the
   * registry refuses to register a mutating tool without one.
   */
  requiredPermission?: string;
  /** Changes something outside the agent (an issue, a branch, a message). */
  mutating?: boolean;
  /**
   * The resource the call targets, for scoped authorization. May be async
   * when the target has to be looked up (a programme's repository). The
   * registry always passes the call context. A tool
   * without it, or one that returns nothing, is authorized with no resource:
   * unscoped grants still allow it, team- or repository-scoped grants do not.
   * A throw counts as a denial.
   */
  resource?(
    args: Args,
    ctx?: ToolCallContext,
  ): AuthorizationResource | undefined | Promise<AuthorizationResource | undefined>;
  invoke(args: Args, ctx: ToolCallContext): Promise<ToolResult>;
}

/** A system-prompt section a module contributes alongside its tools. */
export interface PromptSection {
  /** Stable sections can sit in the cached prompt prefix. */
  stable: boolean;
  text: string;
}

/**
 * One area's contribution to the agent: its tools and the prompt text that
 * explains them. An empty or absent `intentClasses` means the module is core
 * and is offered for every request.
 */
export interface ToolModule {
  name: string;
  tools: AgentTool[];
  intentClasses?: string[];
  promptSections?: PromptSection[];
}

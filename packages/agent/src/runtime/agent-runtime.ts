import type { LlmCompletion, LlmContentBlock, LlmMessage, LlmPort, LlmSystemSegment } from "../llm/types";
import { resolveModelForIntent, type ModelRouting } from "../llm/model-routing";
import { notify, type AgentObserver } from "../observer";
import { composePromptSections, composeSystemSegments, type DynamicPromptSection } from "../prompt/compose";
import { defaultSystemPrompt } from "../prompt/default-system-prompt";
import type { GovernedOutcome, PromptSection, ToolCallContext, ToolResultContent } from "../tools/agent-tool";
import type { ToolRegistry } from "../tools/tool-registry";
import type { AgentTurnRunner, TurnInput, TurnOutcome, TurnResult, TurnToolCall } from "../turn";
import { createContextBudget, fitToolResult, isBudgetExhausted, MIN_USEFUL_RESULT_CHARS, nextResultCap } from "./context-budget";
import { RepeatGuard } from "./repeat-guard";

export interface AgentLoopLimits {
  /** Model calls allowed in one turn. */
  maxIterations: number;
  /** Wall-clock budget for one turn, in milliseconds. */
  wallClockMs: number;
  /** Largest single tool result shown to the model, in characters. */
  maxToolResultChars: number;
  /** Total tool-result characters one turn may accumulate. */
  maxTurnToolChars: number;
  /** Identical repeats (same call, same result) tolerated before tool use is stopped. */
  maxRepeatedToolCalls: number;
  /** Tools exempt from repeat detection, for reads that are expected to be polled. */
  repeatExemptTools?: string[];
}

/**
 * Backstops, not budgets. They exist to end a turn that is stuck, and are set
 * high enough that a legitimate multi-step investigation does not hit them.
 * Keep the result caps well inside the model's context window: past it, a
 * truncation problem becomes a failed request.
 */
export const DEFAULT_AGENT_LOOP_LIMITS: AgentLoopLimits = {
  maxIterations: 40,
  wallClockMs: 10 * 60_000,
  maxToolResultChars: 50_000,
  maxTurnToolChars: 400_000,
  maxRepeatedToolCalls: 4,
};

export interface AgentPromptConfig {
  /** Defaults to "Lexi". Only used by the default system prompt. */
  agentName?: string;
  /** Replaces the default system prompt entirely. */
  systemPrompt?: string;
  /** Extra sections, appended after the tool modules' own sections. */
  sections?: Array<PromptSection | DynamicPromptSection>;
  /** Called when a dynamic section throws; the section is skipped either way. */
  onSectionError?: (sectionId: string, error: unknown) => void;
}

export interface AgentRuntimeOptions {
  llm: LlmPort;
  registry: ToolRegistry;
  prompt?: AgentPromptConfig;
  limits?: Partial<AgentLoopLimits>;
  observer?: AgentObserver;
  /** Optional per-intent model choice. Omit to always use the client's model. */
  modelRouting?: ModelRouting;
  /** Injectable for tests. Defaults to `Date.now`. */
  clock?: () => number;
}

type EarlyStop = Exclude<TurnOutcome, "answered">;

interface ExecutedAction {
  name: string;
  reason?: string;
}

interface TurnState {
  input: TurnInput;
  startedAt: number;
  iterations: number;
  toolCalls: TurnToolCall[];
  executed: ExecutedAction[];
}

const EMPTY_REPLY_NUDGE =
  "Your previous reply was empty. Reply to the user now: answer from what you already have, or say plainly what is stopping you.";

const MAX_LISTED_ACTIONS = 10;

/**
 * The tool-calling loop.
 *
 * Each iteration sends the transcript to the model, runs any tool calls it
 * makes through the registry, and appends the results. Identity always comes
 * from the turn input, never from model output, so the model cannot act as
 * someone else by saying so.
 *
 * Every way a turn can end produces non-empty text, and every early stop lists
 * the actions that had already executed. A user who is told "I ran out of time"
 * must also be told what did happen, or they retry and repeat it.
 */
export class AgentRuntime implements AgentTurnRunner {
  private readonly limits: AgentLoopLimits;
  private readonly clock: () => number;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.limits = { ...DEFAULT_AGENT_LOOP_LIMITS, ...stripUndefined(options.limits ?? {}) };
    this.clock = options.clock ?? Date.now;
  }

  async runTurn(input: TurnInput, runOptions: { signal?: AbortSignal } = {}): Promise<TurnResult> {
    const state: TurnState = { input, startedAt: this.clock(), iterations: 0, toolCalls: [], executed: [] };
    const deadline = state.startedAt + this.limits.wallClockMs;
    const outer = runOptions.signal;

    // One controller aborts in-flight model and tool calls, whether the caller
    // cancelled or the deadline passed. The clock is still checked before every
    // call, because a tool that ignores its signal can outlive the timer.
    const controller = new AbortController();
    const onAbort = () => controller.abort(outer?.reason);
    if (outer?.aborted) controller.abort(outer.reason);
    else outer?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("turn deadline")), Math.max(0, deadline - this.clock()));
    (timer as { unref?: () => void }).unref?.();

    const stopCheck = (): EarlyStop | undefined => {
      if (outer?.aborted) return "cancelled";
      if (this.clock() >= deadline || controller.signal.aborted) return "timeout";
      return undefined;
    };

    try {
      return await this.loop(state, controller.signal, stopCheck);
    } catch (error) {
      // Nothing above should throw, but a turn must still end with text.
      return this.end(state, "llm_error", this.stoppedText("llm_error", state, describeError(error)));
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }

  private async loop(state: TurnState, signal: AbortSignal, stopCheck: () => EarlyStop | undefined): Promise<TurnResult> {
    const { input } = state;
    const { registry } = this.options;
    const messages = buildMessages(input);
    const system = this.buildSystem(input);
    const tools = registry.definitions(input.intentClass);
    const model = resolveModelForIntent(this.options.modelRouting, input.intentClass);
    const guard = new RepeatGuard({
      maxRepeats: this.limits.maxRepeatedToolCalls,
      exemptTools: this.limits.repeatExemptTools,
    });
    const budget = createContextBudget(this.limits.maxToolResultChars, this.limits.maxTurnToolChars);
    let forceFinal: string | undefined;
    let nudgedAfterEmpty = false;

    for (;;) {
      const stop = stopCheck();
      if (stop) return this.stopped(stop, state);
      if (state.iterations >= this.limits.maxIterations) return this.stopped("max_iterations", state);
      state.iterations += 1;

      const completion = await this.callModel(messages, system, tools, model, forceFinal, signal);
      if (completion instanceof Error) {
        return this.stopped(stopCheck() ?? "llm_error", state, describeError(completion));
      }

      if (completion.stopReason === "refusal") {
        const explanation = completion.text.trim();
        return this.stopped("refused", state, explanation || undefined);
      }

      // Once tool use has been stopped, any call the model still makes is
      // ignored: the request told it to answer from what it has.
      const toolUses = forceFinal ? [] : completion.toolUses;

      if (toolUses.length === 0) {
        const text = completion.text.trim();
        if (text) {
          const cutOff = completion.stopReason === "max_tokens";
          return this.end(state, "answered", cutOff ? `${text}\n\n(This reply was cut off at the output length limit.)` : text);
        }
        if (completion.stopReason === "max_tokens") {
          return this.stopped("llm_error", state, "the model used its whole output allowance without writing an answer");
        }
        if (forceFinal) {
          return this.stopped("llm_error", state, `tool use was stopped (${forceFinal}) and the model then returned no answer`);
        }
        if (!nudgedAfterEmpty) {
          nudgedAfterEmpty = true;
          appendUserText(messages, EMPTY_REPLY_NUDGE);
          continue;
        }
        return this.stopped("llm_error", state, "the model returned an empty reply twice");
      }

      messages.push(completion.message);
      const results: LlmContentBlock[] = [];
      // A reply cut off at the length limit may end inside a tool call's
      // arguments. Running a write on half its arguments is worse than not
      // running it, so nothing from such a reply is executed.
      const cutOff = completion.stopReason === "max_tokens";

      for (const use of toolUses) {
        const midStop = stopCheck();
        if (midStop) return this.stopped(midStop, state);

        const tool = registry.get(use.name);
        const mutating = tool?.mutating === true;

        if (cutOff) {
          results.push(toolResult(use.id, "Not run: your reply was cut off at the output length limit, so these arguments may be incomplete. Make the call again.", true));
          state.toolCalls.push({ name: use.name, isError: true, ...(mutating ? { executed: false } : {}) });
          continue;
        }

        const before = guard.beforeCall(use.name, use.input, mutating);
        if (before.action === "skip") {
          results.push(toolResult(use.id, before.content));
          state.toolCalls.push({ name: use.name, isError: false, executed: false });
          if (before.forceFinal) forceFinal ??= before.forceFinal;
          continue;
        }

        const ctx: ToolCallContext = {
          actorId: input.actorId,
          conversation: input.conversation,
          maxResultChars: Math.max(MIN_USEFUL_RESULT_CHARS, nextResultCap(budget)),
          signal,
        };
        const result = await registry.invoke(use.name, use.input, ctx);
        const governed = mutating || result.outcome !== undefined;
        const executed = result.outcome ? result.outcome.executed : mutating && result.isError !== true;
        state.toolCalls.push({ name: use.name, isError: result.isError === true, ...(governed ? { executed } : {}) });
        if (governed && executed) state.executed.push({ name: use.name, reason: result.outcome?.reason });

        const fitted = fitToolResult(result.content, budget);
        results.push(toolResult(use.id, withOutcome(fitted.content, result.outcome), result.isError === true));

        const after = guard.afterCall(use.name, use.input, mutating, { content: result.content, isError: result.isError, executed });
        if (after.action === "force_final") forceFinal ??= after.reason;
        if (!forceFinal && isBudgetExhausted(budget)) {
          forceFinal = "this turn's tool-result budget is spent, so further results could not be shown";
        }
      }

      if (forceFinal) {
        results.push({
          type: "text",
          text:
            `Tool use is stopped for the rest of this turn: ${forceFinal} ` +
            `Answer now from what you already have, and say plainly what you could not find out.`,
        });
      }
      messages.push({ role: "user", content: results });
    }
  }

  private async callModel(
    messages: LlmMessage[],
    system: LlmSystemSegment[],
    tools: ReturnType<ToolRegistry["definitions"]>,
    model: string | undefined,
    forceFinal: string | undefined,
    signal: AbortSignal,
  ): Promise<LlmCompletion | Error> {
    const started = this.clock();
    try {
      const completion = await this.options.llm.complete(messages, tools, {
        ...(model ? { model } : {}),
        system,
        toolChoice: forceFinal ? "none" : "auto",
        signal,
      });
      notify(this.options.observer, "onLlmCall", {
        model: model ?? this.options.llm.model,
        durationMs: this.clock() - started,
        stopReason: completion.stopReason,
        usage: completion.usage
          ? {
              promptTokens: completion.usage.promptTokens,
              completionTokens: completion.usage.completionTokens,
              cachedInputTokens: completion.usage.cachedInputTokens,
              cacheCreationInputTokens: completion.usage.cacheCreationInputTokens,
            }
          : null,
      });
      return completion;
    } catch (error) {
      notify(this.options.observer, "onLlmCall", {
        model: model ?? this.options.llm.model,
        durationMs: this.clock() - started,
        stopReason: null,
        usage: null,
      });
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  private buildSystem(input: TurnInput): LlmSystemSegment[] {
    const prompt = this.options.prompt ?? {};
    const base = prompt.systemPrompt ?? defaultSystemPrompt(prompt.agentName);
    const fixed: PromptSection[] = [];
    const dynamic: DynamicPromptSection[] = [];
    for (const section of prompt.sections ?? []) {
      if ("render" in section) dynamic.push(section);
      else fixed.push(section);
    }
    const ctx = { actorId: input.actorId, conversation: input.conversation, intentClass: input.intentClass };
    return composeSystemSegments(base, [
      ...this.options.registry.promptSections(input.intentClass),
      ...fixed,
      ...composePromptSections(dynamic, ctx, prompt.onSectionError),
    ]);
  }

  private stopped(outcome: EarlyStop, state: TurnState, detail?: string): TurnResult {
    return this.end(state, outcome, this.stoppedText(outcome, state, detail));
  }

  private end(state: TurnState, outcome: TurnOutcome, text: string): TurnResult {
    const durationMs = this.clock() - state.startedAt;
    notify(this.options.observer, "onTurnEnd", {
      conversation: state.input.conversation,
      outcome,
      iterations: state.iterations,
      durationMs,
    });
    return {
      outcome,
      text: text.trim() || "I could not produce a reply to this request.",
      iterations: state.iterations,
      toolCalls: state.toolCalls,
      durationMs,
    };
  }

  /** The runtime's own message for a turn that did not end in an answer. */
  private stoppedText(outcome: EarlyStop, state: TurnState, detail?: string): string {
    const lines: string[] = [headline(outcome, this.limits, detail)];
    if (outcome === "refused" && detail) lines.push("", `The model's explanation: ${detail}`);

    if (state.executed.length > 0) {
      const count = state.executed.length;
      lines.push(
        "",
        `${count === 1 ? "This action" : "These actions"} already ran and ${count === 1 ? "was" : "were"} not undone:`,
      );
      for (const action of state.executed.slice(0, MAX_LISTED_ACTIONS)) {
        lines.push(`- ${action.name}${action.reason ? ` (${action.reason})` : ""}`);
      }
      const hidden = count - MAX_LISTED_ACTIONS;
      if (hidden > 0) lines.push(`- and ${hidden} more not listed here`);
      lines.push("", "Check them before asking again: repeating the request would repeat them.");
    } else if (state.toolCalls.length > 0) {
      const lookups = state.toolCalls.length;
      lines.push("", `No action that changes anything had run. ${lookups} tool call${lookups === 1 ? "" : "s"} completed before the stop.`);
    } else {
      lines.push("", "No tools had run.");
    }
    return lines.join("\n");
  }
}

function headline(outcome: EarlyStop, limits: AgentLoopLimits, detail?: string): string {
  switch (outcome) {
    case "timeout":
      return `I ran out of time on this request (the limit is ${formatDuration(limits.wallClockMs)}) before I could finish.`;
    case "max_iterations":
      return `I reached the limit of ${limits.maxIterations} steps for one request before I could finish.`;
    case "cancelled":
      return "This request was cancelled before I finished.";
    case "refused":
      return "The model declined to answer this request.";
    case "llm_error":
      return `I could not finish this request: ${detail ?? "the language model call failed"}.`;
  }
}

function formatDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`;
  return `${Math.round(ms / 1000)} seconds`;
}

/**
 * Describes a failed model call without echoing the provider's response body,
 * which can carry request identifiers or prompt fragments into a chat channel.
 */
function describeError(error: unknown): string {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") return `the language model request failed (HTTP ${status})`;
  if (error instanceof Error && error.name === "AbortError") return "the language model request was aborted";
  return "the language model request failed";
}

function toolResult(id: string, content: ToolResultContent, isError = false): LlmContentBlock {
  return { type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) };
}

/**
 * Restates a governed outcome next to the tool's own text, so the model reads
 * whether the action executed from the registry rather than inferring it from
 * prose. Added after trimming, so it is never truncated away.
 */
function withOutcome(content: ToolResultContent, outcome: GovernedOutcome | undefined): ToolResultContent {
  if (!outcome) return content;
  const line =
    `[Governed outcome: authorized=${outcome.authorized}, executed=${outcome.executed}, blocked=${outcome.blocked}. ` +
    `Reason: ${outcome.reason || "none given"}]`;
  if (typeof content === "string") return `${content}\n${line}`;
  return [...content, { type: "text", text: line }];
}

/** Builds the transcript: history, then the new message with any attachments. */
export function buildMessages(input: TurnInput): LlmMessage[] {
  const out: LlmMessage[] = [];
  const history = input.history ?? [];
  const labelled = history.some((message) => message.role === "user" && message.authorId);

  for (const message of history) {
    const text = message.text.trim();
    if (!text) continue;
    const shown = message.role === "user" && message.authorId ? `[from ${message.authorId}] ${text}` : text;
    pushMerged(out, message.role, [{ type: "text", text: shown }]);
  }

  const current: LlmContentBlock[] = (input.attachments ?? []).map((attachment) => ({
    type: "image",
    source: { type: "base64", media_type: attachment.mediaType, data: attachment.data },
  }));
  const text = input.text.trim() || (current.length > 0 ? "(image attached, no text)" : "(empty message)");
  current.push({ type: "text", text: labelled ? `[from ${input.actorId}] ${text}` : text });
  pushMerged(out, "user", current);

  // The provider expects the transcript to open with a user turn.
  if (out[0]?.role === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: "(Earlier messages in this conversation follow.)" }] });
  }
  return out;
}

function pushMerged(messages: LlmMessage[], role: "user" | "assistant", blocks: LlmContentBlock[]): void {
  const last = messages[messages.length - 1];
  if (last && last.role === role && Array.isArray(last.content)) {
    last.content.push(...blocks);
    return;
  }
  messages.push({ role, content: [...blocks] } as LlmMessage);
}

function appendUserText(messages: LlmMessage[], text: string): void {
  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    last.content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
    last.content.push({ type: "text", text });
    return;
  }
  messages.push({ role: "user", content: [{ type: "text", text }] });
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

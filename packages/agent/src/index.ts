export * from "./tools/agent-tool";
export * from "./tools/authorizer";
export { ToolRegistry, type ToolRegistryOptions } from "./tools/tool-registry";
export { notify, type AgentObserver } from "./observer";
export * from "./turn";

export * from "./llm/types";
export { normalizeAnthropicBaseUrl, normalizeOpenAiCompatBaseUrl } from "./llm/base-url";
export {
  AnthropicLlmClient,
  ANTHROPIC_MAX_CACHE_BREAKPOINTS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  countCacheBreakpoints,
  type LlmCachingOptions,
  type LlmClientOptions,
} from "./llm/anthropic-client";
export { OpenAiCompatLlmClient, toChatMessages } from "./llm/openai-compat-client";
export { createLlmClient, isClaudeModel, type LlmFactoryOptions } from "./llm/llm-factory";
export { PiiMaskingLlmClient } from "./llm/pii-masking-client";
export { resolveModelForIntent, type ModelRouting } from "./llm/model-routing";
export {
  ScriptedLlm,
  completionOf,
  textCompletion,
  toolCallCompletion,
  type ScriptedRequest,
  type ScriptedStep,
} from "./llm/test-double";

export { DEFAULT_AGENT_NAME, defaultSystemPrompt } from "./prompt/default-system-prompt";
export {
  composePromptSections,
  composeSystemSegments,
  renderSystemPrompt,
  type DynamicPromptSection,
  type PromptContext,
} from "./prompt/compose";

export {
  AgentRuntime,
  DEFAULT_AGENT_LOOP_LIMITS,
  buildMessages,
  type AgentLoopLimits,
  type AgentPromptConfig,
  type AgentRuntimeOptions,
} from "./runtime/agent-runtime";
export {
  compactByPriority,
  contentChars,
  createContextBudget,
  fitToolResult,
  isBudgetExhausted,
  nextResultCap,
  MIN_USEFUL_RESULT_CHARS,
  type ContextBudget,
  type FittedResult,
} from "./runtime/context-budget";
export {
  RepeatGuard,
  hashValue,
  type AfterCallDecision,
  type BeforeCallDecision,
  type RepeatGuardOptions,
} from "./runtime/repeat-guard";

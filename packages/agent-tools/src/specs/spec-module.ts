import type { AgentTool, ConversationRef, ToolModule, ToolResult } from "@lexi/agent";
import type { CoverageDimension } from "@lexi/contracts";
import { COVERAGE_DIMENSIONS, isCoverageDimension } from "@lexi/specs";
import { readBoolean, readString, readStringArray } from "../shared/args";
import { repoResource, unknownRepoMessage, type RepoScope } from "../shared/repo-scope";
import { errorMessage, executed, jsonResult, readError, redactProviderError, refused } from "../shared/result";
import { defineTool } from "../shared/schema";

export const SPEC_MODULE_NAME = "spec";

/** Each spec tool's permission. Every name exists in the example authorization config. */
export const SPEC_TOOL_PERMISSIONS = {
  start_spec_session: "spec.create",
  update_spec_draft: "spec.revise",
  submit_spec_for_review: "spec.submit_review",
  // Read-only, but it is the preview half of create_spec_tasks: the same authority, one step earlier.
  generate_task_breakdown: "work_item.create",
  create_spec_tasks: "work_item.create",
} as const;

/**
 * Spec actions that exist but are never offered to the model. Approval and
 * retirement are human acts taken in the chat surface. Withholding the schema
 * is stronger than refusing the call: a tool the model cannot see is one it
 * cannot be talked into attempting.
 */
export const HUMAN_ONLY_SPEC_ACTIONS = ["approve_spec", "request_changes_after_approval", "supersede_spec", "discard_spec"] as const;

export interface SpecAnswer {
  dimension: CoverageDimension;
  answer?: string;
  confidence?: number;
  deferReason?: string;
}

export interface SpecTaskInput {
  title: string;
  kind: "feature" | "chore";
  repository: string;
  notes?: string;
}

/** Who asked and where, passed to every executor call. */
export interface SpecToolCall {
  actorId: string;
  conversation: ConversationRef;
}

/** What the executor reports. `executed` is false for every refusal. */
export interface SpecToolOutcome {
  executed: boolean;
  reason: string;
  /** Structured detail for the model: a spec id, open questions, proposed tasks. */
  data?: unknown;
  auditId?: string;
}

/**
 * The spec pipeline, as the tools see it. The deployment implements this over
 * its spec store, using `@lexi/specs` for every decision (coverage, readiness,
 * rendering, lifecycle). The tools validate arguments and relay outcomes; they
 * decide nothing about readiness or approval themselves.
 */
export interface SpecToolExecutor {
  startSession(input: { title: string; requestedBy: string; targetRepository?: string; seedAnswers: SpecAnswer[] }, call: SpecToolCall): Promise<SpecToolOutcome>;
  updateDraft(input: { specId: string; answers: SpecAnswer[]; userRequestedDraft: boolean }, call: SpecToolCall): Promise<SpecToolOutcome>;
  submitForReview(input: { specId: string; reviewerHint?: string }, call: SpecToolCall): Promise<SpecToolOutcome>;
  generateTaskBreakdown(input: { specId: string; repositories: string[] }, call: SpecToolCall): Promise<SpecToolOutcome>;
  createSpecTasks(input: { specId: string; tasks: SpecTaskInput[] }, call: SpecToolCall): Promise<SpecToolOutcome>;
}

export interface SpecModuleDeps {
  executor: SpecToolExecutor;
  /** Repositories a spec may target. When set, a repository outside it is refused. */
  repositories?: RepoScope;
}

/**
 * The spec pipeline's tool surface: open a clarification session, record
 * answers against the coverage checklist, submit for review, and break an
 * approved spec into work items. There is deliberately no approval tool.
 */
export function createSpecToolModule(deps: SpecModuleDeps): ToolModule {
  const { executor, repositories } = deps;
  const dimensionEnum = [...COVERAGE_DIMENSIONS];
  const answerSchema = (required: string[]) => ({
    type: "object",
    properties: {
      dimension: { type: "string", enum: dimensionEnum },
      answer: { type: "string", description: "In the requester's own words where possible." },
      confidence: { type: "number", description: "0..1. Below the policy threshold the dimension stays open; use that honestly for a half-answer." },
      deferReason: { type: "string", description: "Only when the requester said this dimension is out of scope, with their reason." },
    },
    required,
    additionalProperties: false,
  });

  const run = async (
    name: keyof typeof SPEC_TOOL_PERMISSIONS,
    call: () => Promise<SpecToolOutcome>,
    mutating: boolean,
    maxChars: number,
  ): Promise<ToolResult> => {
    let outcome: SpecToolOutcome;
    try {
      outcome = await call();
    } catch (error) {
      const message = `${name} failed: ${redactProviderError(errorMessage(error))}. Nothing was changed.`;
      return mutating ? refused(message) : readError(message);
    }
    const detail = outcome.data === undefined ? outcome.reason : `${outcome.reason}\n\n${JSON.stringify(outcome.data, null, 2)}`;
    if (!mutating) return outcome.executed ? jsonResult({ reason: outcome.reason, data: outcome.data }, maxChars) : readError(detail);
    return outcome.executed ? executed(detail.slice(0, maxChars), outcome.auditId) : refused(detail.slice(0, maxChars));
  };

  const tools: AgentTool[] = [
    {
      mutating: true,
      requiredPermission: SPEC_TOOL_PERMISSIONS.start_spec_session,
      resource: (args) => (repositories ? repoResource(repositories, args.targetRepository) : undefined),
      definition: defineTool(
        "start_spec_session",
        "Open a clarification session for a feature or change request that is not a bug. A vague request is the " +
          "normal starting point. You then work through the coverage checklist with the requester and the session " +
          "drafts a spec. Not for bug reports.",
        {
          title: { type: "string", description: "What is being asked for, as a product change." },
          requestedBy: { type: "string", description: "Chat user id of whoever is asking, if not the person talking to you. Attribution only." },
          targetRepository: { type: "string", description: `Repository the spec governs.${repositories ? ` One of: ${repositories.describe()}.` : ""} Omit if unclear and ask.` },
          seedAnswers: { type: "array", description: "Dimensions the opening request already answered, so they are not asked again.", items: answerSchema(["dimension", "answer", "confidence"]) },
        },
        ["title"],
      ),
      invoke: async (args, ctx) => {
        const title = readString(args, "title");
        if (!title) return refused("title is required. No session was opened.");
        const targetRepository = readString(args, "targetRepository") || undefined;
        if (targetRepository && repositories && !repositories.resolve(targetRepository)) {
          return refused(`${unknownRepoMessage(targetRepository, repositories)} No session was opened.`);
        }
        const answers = readAnswers(args.seedAnswers);
        if ("error" in answers) return refused(`${answers.error} No session was opened.`);
        const requestedBy = readString(args, "requestedBy") || ctx.actorId;
        return run("start_spec_session", () => executor.startSession({ title, requestedBy, targetRepository, seedAnswers: answers.value }, callOf(ctx)), true, ctx.maxResultChars);
      },
    },
    {
      mutating: true,
      requiredPermission: SPEC_TOOL_PERMISSIONS.update_spec_draft,
      definition: defineTool(
        "update_spec_draft",
        "Record the requester's answers against the coverage checklist of an open spec session, once per reply. The " +
          "session decides whether to ask again or draft; that decision is not yours.",
        {
          specId: { type: "string" },
          answers: { type: "array", items: answerSchema(["dimension"]) },
          userRequestedDraft: { type: "boolean", description: "True only when the requester explicitly asked you to stop clarifying and draft now." },
        },
        ["specId", "answers"],
      ),
      invoke: async (args, ctx) => {
        const specId = readString(args, "specId");
        if (!specId) return refused("specId is required. Nothing was recorded.");
        const answers = readAnswers(args.answers);
        if ("error" in answers) return refused(`${answers.error} Nothing was recorded.`);
        return run(
          "update_spec_draft",
          () => executor.updateDraft({ specId, answers: answers.value, userRequestedDraft: readBoolean(args, "userRequestedDraft") === true }, callOf(ctx)),
          true,
          ctx.maxResultChars,
        );
      },
    },
    {
      mutating: true,
      requiredPermission: SPEC_TOOL_PERMISSIONS.submit_spec_for_review,
      definition: defineTool(
        "submit_spec_for_review",
        "Move a drafted spec into review and announce it for a human decision. This does not approve anything and " +
          "cannot: approval is a person's action, and you have no tool for it.",
        { specId: { type: "string" }, reviewerHint: { type: "string", description: "Optional chat user id best placed to review. Advisory only." } },
        ["specId"],
      ),
      invoke: async (args, ctx) => {
        const specId = readString(args, "specId");
        if (!specId) return refused("specId is required. Nothing was submitted.");
        const reviewerHint = readString(args, "reviewerHint") || undefined;
        return run("submit_spec_for_review", () => executor.submitForReview({ specId, reviewerHint }, callOf(ctx)), true, ctx.maxResultChars);
      },
    },
    {
      requiredPermission: SPEC_TOOL_PERMISSIONS.generate_task_breakdown,
      definition: defineTool(
        "generate_task_breakdown",
        "Propose the work items an approved spec breaks down into, without creating anything, so the requester can " +
          "correct them first. Use before create_spec_tasks.",
        { specId: { type: "string" }, repositories: { type: "array", items: { type: "string" }, description: "Repositories the work lands in." } },
        ["specId", "repositories"],
      ),
      invoke: async (args, ctx) => {
        const specId = readString(args, "specId");
        const repos = readStringArray(args, "repositories");
        if (!specId || repos.length === 0) return readError("specId and at least one repository are required.");
        const unknown = repositories ? repos.filter((r) => !repositories.resolve(r)) : [];
        if (unknown.length && repositories) return readError(unknownRepoMessage(unknown[0], repositories));
        return run("generate_task_breakdown", () => executor.generateTaskBreakdown({ specId, repositories: repos }, callOf(ctx)), false, ctx.maxResultChars);
      },
    },
    {
      mutating: true,
      requiredPermission: SPEC_TOOL_PERMISSIONS.create_spec_tasks,
      definition: defineTool(
        "create_spec_tasks",
        "Create work items for an approved spec, after generate_task_breakdown. Refuses an unapproved spec; that is " +
          "a governance rule, not something to work around.",
        {
          specId: { type: "string" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                kind: { type: "string", enum: ["feature", "chore"] },
                repository: { type: "string" },
                notes: { type: "string" },
              },
              required: ["title", "kind", "repository"],
              additionalProperties: false,
            },
          },
        },
        ["specId", "tasks"],
      ),
      invoke: async (args, ctx) => {
        const specId = readString(args, "specId");
        if (!specId) return refused("specId is required. Nothing was created.");
        const tasks = readTasks(args.tasks);
        if ("error" in tasks) return refused(`${tasks.error} Nothing was created.`);
        const unknown = repositories ? tasks.value.filter((t) => !repositories.resolve(t.repository)) : [];
        if (unknown.length && repositories) return refused(`${unknownRepoMessage(unknown[0].repository, repositories)} Nothing was created.`);
        return run("create_spec_tasks", () => executor.createSpecTasks({ specId, tasks: tasks.value }, callOf(ctx)), true, ctx.maxResultChars);
      },
    },
  ];

  return {
    name: SPEC_MODULE_NAME,
    tools,
    intentClasses: ["spec", "work_item"],
    promptSections: [
      {
        stable: true,
        text:
          "SPECS. A feature request starts a spec session; a bug does not. Mine the thread for answers before asking, " +
          "record each reply with update_spec_draft, and let the session decide when to draft. Approval is a " +
          "person's action: you cannot approve a spec, and you should say so if asked.",
      },
    ],
  };
}

function callOf(ctx: { actorId: string; conversation: ConversationRef }): SpecToolCall {
  return { actorId: ctx.actorId, conversation: ctx.conversation };
}

function readAnswers(value: unknown): { value: SpecAnswer[] } | { error: string } {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value)) return { error: "answers must be an array." };
  const out: SpecAnswer[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return { error: "each answer must be an object." };
    const entry = item as Record<string, unknown>;
    if (typeof entry.dimension !== "string" || !isCoverageDimension(entry.dimension)) {
      return { error: `"${String(entry.dimension)}" is not a coverage dimension. Use one of: ${COVERAGE_DIMENSIONS.join(", ")}.` };
    }
    const confidence = entry.confidence;
    if (confidence !== undefined && (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1))) {
      return { error: `confidence for ${entry.dimension} must be a number from 0 to 1.` };
    }
    const answer = typeof entry.answer === "string" ? entry.answer.trim() : "";
    const deferReason = typeof entry.deferReason === "string" ? entry.deferReason.trim() : "";
    if (!answer && !deferReason) return { error: `${entry.dimension} needs an answer or a deferReason.` };
    out.push({
      dimension: entry.dimension,
      ...(answer ? { answer } : {}),
      ...(typeof confidence === "number" ? { confidence } : {}),
      ...(deferReason ? { deferReason } : {}),
    });
  }
  return { value: out };
}

function readTasks(value: unknown): { value: SpecTaskInput[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: "tasks must be a non-empty array." };
  const out: SpecTaskInput[] = [];
  for (const item of value) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    const repository = typeof entry.repository === "string" ? entry.repository.trim() : "";
    if (!title || !repository) return { error: "every task needs a title and a repository." };
    if (entry.kind !== "feature" && entry.kind !== "chore") return { error: `task "${title}" must be of kind feature or chore.` };
    const notes = typeof entry.notes === "string" && entry.notes.trim() ? entry.notes.trim() : undefined;
    out.push({ title, kind: entry.kind, repository, ...(notes ? { notes } : {}) });
  }
  return { value: out };
}

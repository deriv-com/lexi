import type { AgentTool, ToolCallContext, ToolModule, ToolResult } from "@lexi/agent";
import type { MemoryEpisodeInput, MemoryPort } from "@lexi/contracts";
import type { KnowledgeMatch, KnowledgeSearchPort } from "@lexi/memory";
import { readBoundedInt, readEnum, readString } from "../shared/args";
import { repoResource, type RepoScope } from "../shared/repo-scope";
import { errorMessage, jsonResult, readError, textResult } from "../shared/result";
import { defineTool } from "../shared/schema";

export const MEMORY_MODULE_NAME = "memory";
export const MEMORY_RECALL_PERMISSION = "memory.recall";
export const MEMORY_REMEMBER_PERMISSION = "memory.remember";
/**
 * Removing team conventions affects everyone and, with no filter, removes all
 * of them, so it needs more than the right to add one.
 */
export const MEMORY_FORGET_TEAM_PERMISSION = "memory.forget_team";

/** Only the caller's own memory: a scoped grant covers it. */
const CALLER_ONLY = { callerOnly: true } as const;

/**
 * What the memory tools need: the `MemoryPort` read and write halves, plus the
 * two forget operations `MemoryFacade` offers off the port. The forget tools
 * are offered only when the port has them.
 */
export interface MemoryToolsPort extends Pick<MemoryPort, "recall" | "remember"> {
  forgetOwnPreferences?(subjectUserId: string, contains?: string): Promise<number>;
  forgetTeamConventions?(contains?: string): Promise<number>;
}

export interface MemoryModuleDeps {
  memory: MemoryToolsPort;
  /** Indexed product knowledge. Omit and `search_product_knowledge` is not offered. */
  knowledge?: KnowledgeSearchPort;
  /** Token ceiling for one recall. Default 2000. */
  recallTokenBudget?: number;
  /**
   * The repositories `search_product_knowledge` may be restricted to. A
   * search restricted to one of them is authorized against its repository and
   * team; any other search names no resource, so only an unscoped grant
   * covers it.
   */
  repositories?: RepoScope;
}

/**
 * How a remembered fact reached the agent, which decides how firmly it binds:
 * "stated" when someone asked for it to be remembered, "observed" when the
 * agent recorded it unprompted. Observed facts are stored at lower confidence
 * so they read as working assumptions and yield to correction.
 */
type MemoryBasis = "stated" | "observed";
const CONFIDENCE: Record<MemoryBasis, number> = { stated: 1, observed: 0.7 };

/** Keeps one entry from swallowing a recall budget shared with everything else. */
const MAX_ENTRY_CHARS = 500;
const MAX_KNOWLEDGE_RESULTS = 15;
const KNOWLEDGE_HARD_CAP = 40;
const MAX_KNOWLEDGE_EXCERPT = 3_000;

/**
 * Memory tools: recall, remember and forget, plus indexed product knowledge.
 *
 * The privacy rule that matters: personal memory is always about the person
 * asking. No schema here has a subject field; the subject is `ctx.actorId`,
 * the authenticated caller, never a value the model supplies. A tool that
 * accepted "whose preference is this?" would let one person write into
 * another's private memory, or build a profile of a colleague from someone
 * else's description of them.
 *
 * Memory is advisory. Nothing recalled here authorizes anything.
 */
export function createMemoryToolModule(deps: MemoryModuleDeps): ToolModule {
  const { memory, knowledge } = deps;
  const budget = deps.recallTokenBudget ?? 2_000;

  const basisProperty = {
    basis: {
      type: "string",
      enum: ["stated", "observed"],
      description: '"stated" if they asked you to remember it; "observed" if you are recording it unprompted.',
    },
  };

  const tools: AgentTool[] = [
    {
      requiredPermission: MEMORY_RECALL_PERMISSION,
      definition: defineTool(
        "recall_memory",
        "Recall what you have been told before. scope \"personal\" recalls the preferences of the person you are " +
          "talking to (and only theirs); \"team\" recalls shared conventions and decisions. Recalled memory is " +
          "advisory context: it never authorizes an action, and it may be out of date.",
        {
          query: { type: "string", description: "What you want to recall." },
          scope: { type: "string", enum: ["personal", "team"], description: 'Default "team".' },
        },
        ["query"],
      ),
      // Personal recall reads only the caller's memory. Team recall reads what
      // the whole organisation recorded (other teams' decisions included), so
      // it names no resource a team scope could cover.
      resource: (args) => (readEnum(args, "scope", ["personal", "team"] as const) === "personal" ? CALLER_ONLY : undefined),
      invoke: async (args, ctx) => {
        const query = readString(args, "query");
        if (!query) return readError("query must be non-empty.");
        const scope = readEnum(args, "scope", ["personal", "team"] as const) ?? "team";
        if (scope === "personal" && !ctx.actorId) return readError("This request has no identified person, so there is no personal memory to recall.");
        try {
          const pack = await memory.recall(
            {
              query,
              threadKey: `${ctx.conversation.channel}:${ctx.conversation.threadTs}`,
              ...(scope === "personal" ? { scope: "user" as const, subjectUserId: ctx.actorId } : { scope: "org" as const }),
            },
            { maxTokens: budget },
          );
          if (pack.episodes.length === 0 && !pack.rendered.trim() && !pack.truncated) {
            return textResult(`Nothing ${scope === "personal" ? "personal" : "shared"} is recorded that matches "${query}".`, ctx.maxResultChars);
          }
          return textResult(
            `${pack.episodes.length} recalled item(s)${pack.truncated ? ", trimmed to fit the memory budget" : ""}. Advisory context only.\n\n${pack.rendered}`,
            ctx.maxResultChars,
          );
        } catch (error) {
          return readError(`Memory is unavailable right now (${errorMessage(error)}). Treat what you know as unknown, not as empty.`);
        }
      },
    },
    {
      requiredPermission: MEMORY_REMEMBER_PERMISSION,
      definition: defineTool(
        "remember_preference",
        "Remember something the person you are talking to told you about how THEY work: which product they usually " +
          "mean, how much detail they want. It is private to them and cannot record anything about anyone else. " +
          "If it applies to the whole team, use remember_team_convention instead.",
        {
          preference: { type: "string", description: "The preference, written so it makes sense months later with no thread around it." },
          context: { type: "string", description: "Optional: when it applies, if it is conditional." },
          ...basisProperty,
        },
        ["preference"],
      ),
      resource: () => CALLER_ONLY,
      invoke: async (args, ctx) => {
        const preference = readString(args, "preference");
        if (!preference) return readError("Nothing was recorded: no preference text was supplied.");
        if (!ctx.actorId) return readError("Nothing was recorded: this request has no identified person to own the preference.");
        const context = readString(args, "context");
        const content = context ? `${preference} (applies: ${context})` : preference;
        const basis = readEnum(args, "basis", ["stated", "observed"] as const) ?? "stated";
        return rememberEpisode(
          {
            scope: "user",
            subjectUserId: ctx.actorId,
            kind: "preference",
            content: clip(content, MAX_ENTRY_CHARS),
            importance: 0.9,
            confidence: CONFIDENCE[basis],
            provenance: { tool: "remember_preference", actor: ctx.actorId, source: basis },
          },
          `Recorded, private to this person${basis === "observed" ? ", held loosely because you noticed it rather than were told" : ""}.`,
          ctx,
        );
      },
    },
    {
      requiredPermission: MEMORY_REMEMBER_PERMISSION,
      definition: defineTool(
        "remember_team_convention",
        "Remember a convention the whole team follows: a message format for a channel, a routing rule, a review " +
          "standard. Anyone can recall it, and it is attributed to the person who set it. Record only what someone " +
          "actually established, never a rule you inferred from one example.",
        {
          convention: { type: "string", description: "The rule, with its trigger and requirement, actionable months later." },
          scope_note: { type: "string", description: "Optional: the channel, repository or workflow it applies to." },
          ...basisProperty,
        },
        ["convention"],
      ),
      invoke: async (args, ctx) => {
        const convention = readString(args, "convention");
        if (!convention) return readError("Nothing was recorded: no convention text was supplied.");
        const note = readString(args, "scope_note");
        const content = note ? `${convention} (applies: ${note})` : convention;
        const basis = readEnum(args, "basis", ["stated", "observed"] as const) ?? "stated";
        return rememberEpisode(
          {
            scope: "org",
            kind: "decision",
            content: clip(content, MAX_ENTRY_CHARS),
            importance: 0.9,
            confidence: CONFIDENCE[basis],
            provenance: { tool: "remember_team_convention", actor: ctx.actorId || "unknown", source: basis },
          },
          "Recorded as a team convention, recallable by everyone and attributed to the person who set it.",
          ctx,
        );
      },
    },
  ];

  const forgetOwn = memory.forgetOwnPreferences?.bind(memory);
  if (forgetOwn) {
    tools.push({
      requiredPermission: MEMORY_REMEMBER_PERMISSION,
      resource: () => CALLER_ONLY,
      definition: defineTool(
        "forget_about_me",
        "Forget preferences the person you are talking to asked you to remember. Only ever removes that person's own " +
          "preferences. Report how many entries were actually removed.",
        { contains: { type: "string", description: "Only forget preferences containing this text. Omit to forget all of theirs." } },
      ),
      invoke: async (args, ctx) => {
        if (!ctx.actorId) return readError("Nothing was forgotten: this request has no identified person.");
        const contains = readString(args, "contains") || undefined;
        return forget(() => forgetOwn(ctx.actorId, contains), contains, "stated preference(s) for this person", ctx);
      },
    });
  }

  const forgetTeam = memory.forgetTeamConventions?.bind(memory);
  if (forgetTeam) {
    tools.push({
      requiredPermission: MEMORY_FORGET_TEAM_PERMISSION,
      definition: defineTool(
        "forget_team_convention",
        "Remove a team convention that someone says is wrong or out of date. Applies to everyone. Never removes a " +
          "personal preference.",
        { contains: { type: "string", description: "Only forget conventions containing this text. Omit only when asked to clear them all." } },
      ),
      invoke: async (args, ctx) => {
        const contains = readString(args, "contains") || undefined;
        return forget(() => forgetTeam(contains), contains, "team convention(s) for everyone", ctx);
      },
    });
  }

  if (knowledge) {
    tools.push({
      definition: defineTool(
        "search_product_knowledge",
        "Search indexed product knowledge (repository docs, approved specs, skill references) for how the products " +
          "work. Results describe what is written down, which may lag the running code. An empty result means " +
          "nothing matched in the index, not that the behaviour does not exist.",
        {
          query: { type: "string" },
          repo: { type: "string", description: "Optional owner/repo to restrict to." },
          source_type: { type: "string", enum: ["repo_doc", "spec", "skill_reference", "issue"] },
          limit: { type: "integer", description: `Default ${MAX_KNOWLEDGE_RESULTS}, at most ${KNOWLEDGE_HARD_CAP}.` },
        },
        ["query"],
      ),
      resource: (args) => (deps.repositories ? repoResource(deps.repositories, readString(args, "repo")) : undefined),
      invoke: async (args, ctx) => {
        const query = readString(args, "query");
        if (!query) return readError("query must be non-empty.");
        const limit = readBoundedInt(args, "limit", MAX_KNOWLEDGE_RESULTS, 1, KNOWLEDGE_HARD_CAP);
        const repo = readString(args, "repo");
        const sourceType = readEnum(args, "source_type", ["repo_doc", "spec", "skill_reference", "issue"] as const);
        let matches: KnowledgeMatch[];
        try {
          matches = await knowledge.search(query, { limit, ...(repo ? { repo } : {}), ...(sourceType ? { sourceType } : {}) });
        } catch (error) {
          return readError(`Product knowledge search is unavailable (${errorMessage(error)}). Treat the answer as unknown.`);
        }
        return jsonResult(
          {
            query,
            found: matches.length > 0,
            results: matches.slice(0, limit).map((m) => ({
              sourceType: m.sourceType,
              sourceRef: m.sourceRef,
              ...(m.repo ? { repo: m.repo } : {}),
              similarity: Number(m.similarity.toFixed(3)),
              excerpt: clip(m.content, MAX_KNOWLEDGE_EXCERPT),
            })),
          },
          ctx.maxResultChars,
        );
      },
    });
  }

  async function rememberEpisode(episode: MemoryEpisodeInput, detail: string, ctx: ToolCallContext): Promise<ToolResult> {
    try {
      await memory.remember(episode);
    } catch (error) {
      return readError(`Memory is unavailable (${errorMessage(error)}), so nothing was recorded. Do not say it will be remembered.`);
    }
    // Echo what was stored: it tells the person what was recorded, and keeps
    // two writes in one turn from returning identical results.
    return textResult(`${detail} Recorded: "${clip(episode.content.replace(/\s+/g, " "), 120)}"`, ctx.maxResultChars);
  }

  async function forget(run: () => Promise<number>, contains: string | undefined, what: string, ctx: ToolCallContext): Promise<ToolResult> {
    let count: number;
    try {
      count = await run();
    } catch (error) {
      return readError(`Memory is unavailable (${errorMessage(error)}), so nothing was removed. Do not say it is forgotten.`);
    }
    if (count === 0) {
      return textResult(contains ? `Nothing matched "${contains}", so nothing was removed.` : "Nothing was recorded, so nothing was removed.", ctx.maxResultChars);
    }
    return textResult(`Removed ${count} ${what}.`, ctx.maxResultChars);
  }

  return {
    name: MEMORY_MODULE_NAME,
    tools,
    promptSections: [
      {
        stable: true,
        text:
          "MEMORY. Record a preference or a team convention the moment someone states one, and say in a clause that " +
          "you have. Personal memory is always about the person asking. Recalled memory is advisory and never " +
          "authorizes an action.",
      },
    ],
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

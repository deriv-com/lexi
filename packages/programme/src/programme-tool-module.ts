import type { IntentClass } from "@lexi/contracts";
import type {
  AgentTool,
  AuthorizationResource,
  PromptSection,
  ToolCallContext,
  ToolDefinition,
  ToolModule,
  ToolResult,
} from "@lexi/agent";
import type { ProgrammeInvocationContext, ProgrammeToolResult } from "./engine/ports";

/**
 * The rebuild programme tool module, on the agent's `AgentTool` contract.
 * Each tool's `invoke` calls the build service; the registry authorizes the
 * acting person (`ctx.actorId`, never anything the model says) against the
 * tool's `requiredPermission` before `invoke` runs, and the service checks
 * the same rung again, so a tool name that reaches it by another route meets
 * the same refusal.
 *
 * What is deliberately NOT here matters more than what is:
 *
 *   - `approve_milestone` and `conclude_hardening` are in
 *     `HUMAN_ONLY_PROGRAMME_TOOLS` and never enter the model payload. Their
 *     only routes are review-card clicks handled by authorization-checked
 *     services.
 *   - There is NO merge tool at any rung. Auto-merge is executed by
 *     deterministic code inside the advance job after the merge gate passes;
 *     a model cannot propose it, so there is no schema to withhold and no
 *     refusal to route around.
 */

/** Env flag. Ships **off**: the module is withheld entirely while false. */
export const PROGRAMME_FLAG = "PROGRAMME_ENABLED";

export const PROGRAMME_TOOL_MODULE_NAME = "programme";

/**
 * Sent for the same planning-adjacent intent classes as work items, plus
 * delivery (programme status is a delivery question). Deliberately not
 * empty — an empty list marks a module as core and sends it on every class.
 */
export const PROGRAMME_INTENT_CLASSES: IntentClass[] = [
  "work_item",
  "spec",
  "code_task",
  "delivery",
];

/** Withheld from the model payload entirely; Block Kit clicks only. */
export const HUMAN_ONLY_PROGRAMME_TOOLS = ["approve_milestone", "conclude_hardening"] as const;

/**
 * The model-facing tool names, as one list — the `isQaToolName` pattern.
 * `classifyToolName` in the agent loop uses this to route a call to the
 * programme service; a name must appear both here and in `tools()` below or
 * it is either unadvertised or undispatched.
 */
export const PROGRAMME_TOOL_NAMES = [
  "start_app_rebuild",
  "get_programme_status",
  "propose_milestone_plan",
  "add_milestones",
  "pause_programme",
  "resume_programme",
  "cancel_programme",
  "retry_build_task",
  "cancel_build_tasks",
  "set_task_criteria",
  "record_programme_decision",
  "prepare_technical_spec",
  "start_model_bench",
] as const;

export type ProgrammeToolName = (typeof PROGRAMME_TOOL_NAMES)[number];

export function isProgrammeToolName(name: string): name is ProgrammeToolName {
  return (PROGRAMME_TOOL_NAMES as readonly string[]).includes(name);
}

/** Authorization rungs, registered in `authorization.yaml`. */
export const PROGRAMME_PERMISSIONS = {
  PROGRAMME_CREATE: "programme.programme.create",
  READ: "programme.read",
  PAUSE: "programme.pause",
  TASK_RETRY: "programme.task.retry",
  /**
   * Granting a task attempts beyond dispatch.maxTaskAttempts (retry_build_task
   * extraAttempts). A higher rung than the retry itself: it spends budget the
   * policy withheld, so the requesting person must hold it, not just the retry.
   */
  TASK_EXTEND_ATTEMPTS: "programme.task.extend_attempts",
  TASK_CANCEL: "programme.task.cancel",
  /**
   * Re-scoping which acceptance criteria a build task owns (set_task_criteria).
   * The merge gate requires every owned criterion bound green, so narrowing the
   * set changes what a PR must prove to land: a team-lead decision, beside the
   * other scope rungs, never the model's alone.
   */
  TASK_RESCOPE: "programme.task.rescope",
  TASK_DISPATCH: "programme.task.dispatch",
  MILESTONE_APPROVE: "programme.milestone.approve",
  HARDENING_CONCLUDE: "programme.hardening.conclude",
  PROGRAMME_CANCEL: "programme.programme.cancel",
  DECISION_RECORD: "programme.decision.record",
} as const;

/** Per-tool authorization rung, checked at invoke time inside the service. */
export const PROGRAMME_TOOL_PERMISSIONS: Record<ProgrammeToolName, string> = {
  start_app_rebuild: PROGRAMME_PERMISSIONS.PROGRAMME_CREATE,
  get_programme_status: PROGRAMME_PERMISSIONS.READ,
  propose_milestone_plan: PROGRAMME_PERMISSIONS.TASK_DISPATCH,
  // Same rung as commissioning: a milestone is programme scope, and whoever
  // may define a programme's scope at creation may extend it afterwards.
  // Adding one dispatches nothing — planning it is still the dispatch rung.
  add_milestones: PROGRAMME_PERMISSIONS.PROGRAMME_CREATE,
  pause_programme: PROGRAMME_PERMISSIONS.PAUSE,
  // Same rung as pause, deliberately: they are one operational lever, and
  // whoever may stop a programme may start it again. A separate rung would
  // let someone pause and then be unable to undo it, which is the failure
  // this tool exists to remove.
  resume_programme: PROGRAMME_PERMISSIONS.PAUSE,
  // Same rung as commissioning: cancelling retires a body of autonomous work
  // and frees the repository for a fresh programme (one live programme per
  // repo). It never deletes anything — CANCELLED is revivable to PROPOSED.
  cancel_programme: PROGRAMME_PERMISSIONS.PROGRAMME_CANCEL,
  retry_build_task: PROGRAMME_PERMISSIONS.TASK_RETRY,
  set_task_criteria: PROGRAMME_PERMISSIONS.TASK_RESCOPE,
  // Its own rung, NOT the retry rung. Retrying spends one task's attempt
  // budget; retiring changes the shape of the milestone, and because a
  // CANCELLED dependency counts as satisfied it also unblocks whatever
  // depended on it. That is a planning decision, so it sits beside the
  // dispatch rung in blast radius even though it stops work rather than
  // starting it.
  cancel_build_tasks: PROGRAMME_PERMISSIONS.TASK_CANCEL,
  record_programme_decision: PROGRAMME_PERMISSIONS.DECISION_RECORD,
  // A READ that assembles the inputs the technical spec is drafted from; it
  // dispatches nothing and writes nothing.
  prepare_technical_spec: PROGRAMME_PERMISSIONS.READ,
  // The dispatch rung: a bench run spends one paid build per model, which is
  // the blast radius of planning work, not of retrying one task.
  start_model_bench: PROGRAMME_PERMISSIONS.TASK_DISPATCH,
};



export interface ProgrammeToolOptions {
  /** Mirrors `PROGRAMME_ENABLED`. Defaults to false. */
  programmeEnabled?: boolean;
  /**
   * The repo keys programmes may target — the intersection of
   * `programme-policy.yaml programmes.allowedRepoKeys` with registered,
   * non-placeholder `autonomyTier: autonomous` repos, computed by the caller.
   * The enum the model sees can therefore never name a repo that a dispatch
   * would refuse.
   */
  allowedRepoKeys?: string[];
}

/** The build service, as the tools see it. `ProgrammeBuildService` satisfies it. */
export interface ProgrammeToolInvoker {
  invokeTool(
    name: ProgrammeToolName,
    args: Record<string, unknown>,
    ctx: ProgrammeInvocationContext,
  ): Promise<ProgrammeToolResult>;
  /**
   * The repository and team a call targets: the programme's repository, or
   * for `start_app_rebuild` the one it would land in. Absent (or returning
   * nothing for an unknown programme), the call is authorized with no
   * resource, which a team- or repository-scoped grant does not cover.
   */
  toolResource?(name: ProgrammeToolName, args: Record<string, unknown>): Promise<AuthorizationResource | undefined>;
}

export interface ProgrammeToolModuleDeps extends ProgrammeToolOptions {
  build: ProgrammeToolInvoker;
}

/** Tools that change nothing: reads, and a read that assembles drafting inputs. */
export const READ_ONLY_PROGRAMME_TOOLS: readonly ProgrammeToolName[] = ["get_programme_status", "prepare_technical_spec"];

function tools(allowedRepoKeys: string[]) {
  return [
    {
      name: "start_app_rebuild",
      description:
        "Commission a rebuild programme: Lexi rebuilds a product from scratch in its dedicated AI-owned repository, from an approved business spec (a product spec via productSpecDomains, or an OpenSpec document via openSpecDomain unless programme-policy businessSpec.banOpenSpec turns it off in the rebuild channel), the prototype used as INTENT/flow reference only (programme-policy.yaml uiSources — do not port components verbatim; rebuild UI with WCAG 2.2 AA), and the API contract, milestone by milestone. Creates the programme record, working branch and tracking issue where configured — it does not dispatch build work by itself. Do NOT pass Figma keys unless a human strictly requires them; prefer prototype routes. Never target production repos. Use only when the request is to rebuild or generate a whole product. One live programme per repo — check get_programme_status first; cancel_programme retires a stuck one.",
      input_schema: {
        type: "object",
        properties: {
          targetRepoKey: {
            type: "string",
            enum: allowedRepoKeys,
            description:
              "Which registered programme repository the rebuild lands in. Only AI-owned rebuild repos are offered; production repos are never valid here.",
          },
          title: {
            type: "string",
            description: "One-line programme title, e.g. 'Acme Web web rebuild'.",
          },
          sourceSpecIssue: {
            type: "string",
            description:
              "Optional provenance pointer, '<repoKey>#<issueNumber>', recorded on the programme and shown by get_programme_status so a reader can find the document it came from. Nothing reads the issue — the spec a build compiles against arrives via specId — so never block on obtaining one, and omit it when the spec lives as files in the repo rather than as an issue.",
          },
          figmaFileKeys: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional. Figma file keys of design sources to snapshot, one milestone each. Omit when programme-policy.yaml uiSources names a prototype implementation for the repo — the checked-out prototype is then the UI source of truth and a design file would only be a cross-check. Never pass a file that is a cover page: one frame plans one screen for a whole app.",
          },
          specId: {
            type: "string",
            description:
              "Programme-level APPROVED spec id (from a spec session seeded from the source spec issue). In autopilot it governs every milestone, so no per-milestone approval is needed; required when milestoneReview.mode is notify.",
          },
          milestones: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "What this milestone delivers, e.g. 'Empty homepage with logout'." },
              },
              required: ["title"],
              additionalProperties: false,
            },
            description: "Optional. The milestones the requester set, IN ORDER — one record each, ids <programmeKey>:m1, :m2, …. Pass them whenever the requester named milestones; this is the only way a repo with no uiSource and no Figma keys gets any. Not combinable with figmaFileKeys (those create one milestone per file).",
          },
        },
        required: ["targetRepoKey", "title"],
        additionalProperties: false,
      },
    },
    {
      name: "get_programme_status",
      description:
        "Report a rebuild programme's current state: milestone progress, task graph status counts, open review requests, and the latest evidence summary. Read-only.",
      input_schema: {
        type: "object",
        properties: {
          programmeKey: { type: "string", description: "The programme's key (slug)." },
        },
        required: ["programmeKey"],
        additionalProperties: false,
      },
    },
    {
      name: "propose_milestone_plan",
      description:
        "Propose or refine the task breakdown for one milestone of a rebuild programme. Programme-level shared infra (technical spec where the repo requires one, then scaffold, design bindings, data layer) is generated once and reused; each milestone then adds one task per screen, integration, and e2e. Pass screenStates to plan a SLICE — a first milestone of three journeys rather than the whole app. Where the repo has a configured uiSource (the prototype implementation) and no design/parity inventory, screen names are its route paths under the prototype's app directory, e.g. '(auth)/login', '(auth)/signup', 'home' — run prepare_technical_spec first to list them. Where the repo has NO uiSource and no design snapshot (the UI is built from scratch against the spec), there is no inventory: name the milestone's screens yourself in screenStates, as the requester described them (e.g. 'login', 'signup', 'home'). Refinements — splitting a task, adding a dependency — are accepted only if the resulting graph validates (no cycles, no unknown dependencies, never empty).",
      input_schema: {
        type: "object",
        properties: {
          programmeKey: { type: "string" },
          milestoneId: { type: "string" },
          specId: {
            type: "string",
            description:
              "Optional. The APPROVED spec that governs THIS milestone, when it has one of its own (a spec session for just this milestone's capability). Its acceptance criteria become the milestone's criteria and the programme spec's criteria travel alongside as programme-wide rules. Recorded on the milestone, so later re-plans keep it without passing it again. Omit to use the milestone's recorded spec, falling back to the programme spec.",
          },
          deferred: {
            type: "boolean",
            description:
              "Optional. true = QUEUE this plan instead of making it now: the advance job plans the milestone itself once its spec (specId, required here, may still be in review) is approved and every earlier milestone's build is complete, so milestones ship in order with nobody asking for the next. Requires screenStates. Only where the repo enables autoPlanQueuedMilestones; screen names are resolved when it is planned, and a refusal is posted to the review channel. Queue every remaining milestone once, in any order.",
          },
          screenStates: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional. The screens THIS milestone covers, for planning a slice instead of the programme's whole scope — one build task is generated per name. Omit to plan every screen the inventory knows. When an inventory exists (design-context snapshot or the prototype routes of its uiSource — prepare_technical_spec lists them), every name must be in it; an unrecognised name is refused with candidates, never planned. When NO inventory exists (built from scratch), the names are taken as given and are required. Matching ignores case and the inventory's own spelling is used. The approved spec's acceptance criteria are spread across the screens you name until the technical spec's 'Acceptance criteria by screen' table merges, after which the advance job re-assigns them from that table — so scope the business spec to the slice (its domains) and let the technical spec do the per-screen mapping.",
          },
          refinements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["split", "add_dependency", "retitle"] },
                taskId: { type: "string" },
                detail: { type: "string" },
              },
              required: ["op", "taskId", "detail"],
              additionalProperties: false,
            },
            description: "Refinements to the generated skeleton. Empty means accept it as-is.",
          },
        },
        required: ["programmeKey", "milestoneId"],
        additionalProperties: false,
      },
    },
    {
      name: "add_milestones",
      description:
        "Append milestones, in order, to an existing rebuild programme — for scope the requester set after commissioning, or a programme created with none (a repo with no uiSource and no Figma keys starts with zero, and propose_milestone_plan refuses until one exists). Each gets the next ordinal and the id <programmeKey>:m<ordinal>, governed by the programme-level spec until propose_milestone_plan is given a specId of its own. Dispatches nothing: plan each one with propose_milestone_plan when it is its turn. Refused on COMPLETE, CANCELLED and HARDENING programmes (a hardening pass concludes without looking at milestones). Creates the repo's configured working branch if the programme predates it.",
      input_schema: {
        type: "object",
        properties: {
          programmeKey: { type: "string" },
          milestones: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "What this milestone delivers, e.g. 'Empty homepage with logout'." },
              },
              required: ["title"],
              additionalProperties: false,
            },
            description: "The milestones to append, in delivery order.",
          },
        },
        required: ["programmeKey", "milestones"],
        additionalProperties: false,
      },
    },
    {
      name: "pause_programme",
      description:
        "Pause a rebuild programme: no further build tasks are dispatched until a human resumes it. In-flight workflow runs are not cancelled. Use when something looks wrong and stopping is safer than continuing.",
      input_schema: {
        type: "object",
        properties: {
          programmeKey: { type: "string" },
          reason: { type: "string", description: "Why the programme is being paused." },
        },
        required: ["programmeKey", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "resume_programme",
      description:
        "Resume a paused rebuild programme so dispatch, evidence folding and auto-merge continue from where they stopped. The counterpart to pause_programme: without it a pause is one-way, because the programme state machine allows PAUSED to return to work but nothing else performs that transition. Returns the programme to the state it was paused from.",
      input_schema: {
        type: "object",
        properties: {
          programmeKey: { type: "string" },
          reason: {
            type: "string",
            description: "Why it is safe to resume — normally what was fixed since the pause.",
          },
        },
        required: ["programmeKey", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "cancel_programme",
      description:
        "Cancel a rebuild programme: every open build task is retired, no further dispatch happens, and the repository becomes free for a new programme (one live programme per repo). Use when the owner wants a clean slate rather than new scope on the existing programme. In-flight workflow runs are not cancelled. Nothing is deleted — the record stays for history and can be revived to PROPOSED — but the plan is gone, so ask for the reason and state it.",
      input_schema: {
        type: "object",
        properties: {
          programmeKey: { type: "string" },
          reason: { type: "string", description: "Why the programme is being cancelled — recorded on it and posted to the review channel." },
        },
        required: ["programmeKey", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "set_task_criteria",
      description:
        "Replace the acceptance criteria a build task owns. The auto-merge gate requires EVERY owned criterion bound green, so a task that owns criteria it cannot prove (e.g. a milestone planned without a criteria map, where every spec criterion was spread onto its screens — an empty-home screen owning all login and signup criteria) is refused for ever. Pass the ids this task really proves; the removed ones are recorded on the programme as deferred (an audit list get_programme_status shows — the planner does not read it yet, so a later milestone's screens need re-scoping to own them). Only for a task that is not in flight or finished (PENDING, READY, PR_OPEN, HANDBACK, FAILED). On a PR_OPEN task the gate re-evaluates on its next tick with no rebuild. Needs the requester's team-lead rung; every change is posted to the review channel. Use it only when the requester asks or agrees, and name which criteria move and why.",
      input_schema: {
        type: "object",
        properties: {
          programmeKey: { type: "string" },
          buildTaskId: { type: "string" },
          criterionIds: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            description: "The complete new set, as AC-xxxxxxxx ids from the task's approved spec.",
          },
          reason: { type: "string", description: "Why these criteria, and where the removed ones belong (e.g. 'login criteria move to M2')." },
        },
        required: ["programmeKey", "buildTaskId", "criterionIds", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "record_programme_decision",
      description:
        "Record a decision humans made about a rebuild programme so every later build brief carries it and Lexi remembers it across threads: a stack or architecture choice, the answer to an open question in the business spec, a scope cut, a convention for the rebuild repo. Use it after the requester answers a question you asked while preparing the technical spec, and for anything decided in conversation that a coding agent working alone would otherwise have to guess. Each decision is stored as memory (org scope, attached to the rebuild repo), appended to the programme's tracking issue, and included verbatim in the technical-spec brief and every screen brief. Do not record things already in the approved spec, and do not invent a decision nobody made — ask instead.",
      input_schema: {
        type: "object",
        properties: {
          programmeKey: { type: "string" },
          decisions: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                topic: { type: "string", description: "Short label, e.g. 'auth state store' or 'Q-6 resend cooldown'." },
                decision: { type: "string", description: "The decision, as a complete sentence a coding agent can act on." },
                rationale: { type: "string", description: "Optional: why, in the requester's words." },
                decidedBy: { type: "string", description: "Slack user ID of the person who decided, when it is not the caller." },
              },
              required: ["topic", "decision"],
              additionalProperties: false,
            },
          },
        },
        required: ["programmeKey", "decisions"],
        additionalProperties: false,
      },
    },
    {
      name: "prepare_technical_spec",
      description:
        "Assemble everything the technical spec for a rebuild programme will be drafted from, so you can judge what is genuinely unknown BEFORE the technical-spec task dispatches: the approved business spec's criteria and journeys, the prototype's route list (screen names accepted by propose_milestone_plan), the API contract's operations by tag, the rebuild repo's engineering standards index, the decisions already recorded, and what Lexi remembers about this repo from earlier work. Read the digest, then ask the requester ONLY the questions the inputs cannot answer — a contract operation the journey needs that is absent, a prototype screen the spec does not describe, a business-spec open question (Q-nn) that touches this slice, a stack choice the standards leave open. Do not ask about anything the digest already settles. Record the answers with record_programme_decision, then plan the milestone. Reads only.",
      input_schema: {
        type: "object",
        properties: {
          programmeKey: { type: "string" },
        },
        required: ["programmeKey"],
        additionalProperties: false,
      },
    },
    {
      name: "cancel_build_tasks",
      description:
        "Retire one or more build tasks that have not started, or restore ones already retired. Use when a task's work is ALREADY on the working branch — a second programme on a repo re-plans shared infra the first one landed, and re-running it rebuilds files that exist and collides with them. A retired task never dispatches, counts as done for milestone completion, and counts as satisfied for anything that depends on it, so retiring redundant work lets its dependents proceed. Refuses a task that is DISPATCHED or already merged. Reversible with restore.",
      input_schema: {
        type: "object",
        properties: {
          programmeKey: { type: "string" },
          buildTaskIds: {
            type: "array",
            items: { type: "string" },
            description: "Exact build task ids. Not patterns — each id is named so the caller sees what is retired.",
          },
          reason: { type: "string", description: "Why these tasks are not needed. Recorded on every row and shown in the tracking issue." },
          restore: { type: "boolean", description: "Restore previously retired tasks to PENDING instead of retiring them." },
        },
        required: ["programmeKey", "buildTaskIds", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "start_model_bench",
      description:
        "Benchmark models on a rebuild programme: build ONE screen once per named model, in parallel, each run pinned to its model (retries re-run the same model). The standard test page is the login screen. Every run goes through the normal evidence gate and its outcome, model and token spend are recorded on the attempt ledger, so models are compared on identical work. Bench PRs are opened for scoring and NEVER merged; they do not count toward milestones. Name the screen as the planner does (e.g. '(auth)/login') or give the exact build task id. A bench is independent of the programme's own progress: it also runs on a COMPLETE or CANCELLED programme, whose planned screens stay as the bench's source, and such a programme does not take the repository's live-programme slot.",
      input_schema: {
        type: "object",
        properties: {
          programmeKey: { type: "string" },
          screen: {
            type: "string",
            description: "A screen state the programme already planned, e.g. '(auth)/login', or the exact build task id to repeat.",
          },
          models: {
            type: "array",
            items: { type: "string" },
            description: "Exact model names as the model gateway serves them, e.g. model-large, model-small. One build per model.",
          },
          reason: { type: "string", description: "Why this bench run is being started; recorded on every arm." },
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh", "max"],
            description: "Optional agent effort level for every arm of the run. Omit for the runner's default. Name it when the requester asks for a mode or effort, e.g. 'high mode'.",
          },
          baseRef: {
            type: "string",
            description: "Optional branch or tag every arm builds from and opens its PR against, instead of the programme's working branch. Use it to pin a bench to a fixed base so it is comparable with an earlier run. The ref must already exist in the repo.",
          },
        },
        required: ["programmeKey", "screen", "models", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "retry_build_task",
      description:
        "Re-arm a build task for another attempt: a FAILED or HANDBACK task, or a PR_OPEN task whose open PR needs rework (review findings, refused checks, a wrong title). The next dispatch resumes the task's own branch and pushes to the same PR. `reason` is written into that attempt's brief as what it must fix — name the concrete findings. At the attempt cap it refuses unless extraAttempts is given. extraAttempts is granted only at the cap, only when the requesting person asked for it and holds programme.task.extend_attempts (team lead), and every grant is posted to the review channel.",
      input_schema: {
        type: "object",
        properties: {
          programmeKey: { type: "string" },
          buildTaskId: { type: "string" },
          reason: {
            type: "string",
            description: "What the next attempt must fix, concretely (e.g. each review finding with its file). Goes into the build brief verbatim.",
          },
          extraAttempts: {
            type: "integer",
            minimum: 0,
            maximum: 3,
            description: "Extra attempts to grant this task beyond the policy cap (0-3 per call; total extra is capped at the policy cap). Only when earlier attempts were spent on something outside the task's control.",
          },
        },
        required: ["programmeKey", "buildTaskId", "reason"],
        additionalProperties: false,
      },
    },
  ];
}

/**
 * The tool schemas the model may see. Flag-gated tools are **withheld**
 * rather than advertised-then-refused: a tool the model can see is a tool it
 * will propose. No target repos means no programme can be legally created,
 * so everything is withheld then too — an enum with zero options is a schema
 * the model cannot satisfy, only misuse.
 */
export function programmeToolDefinitions(options: ProgrammeToolOptions = {}): ToolDefinition[] {
  const allowedRepoKeys = options.allowedRepoKeys ?? [];
  if (options.programmeEnabled !== true || allowedRepoKeys.length === 0) return [];
  return tools(allowedRepoKeys).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as unknown as Record<string, unknown>,
  }));
}

/** What the agent is told about the programme tools, beside their schemas. */
export const PROGRAMME_PROMPT_SECTION: PromptSection = {
  stable: true,
  text: [
    "REBUILD PROGRAMMES",
    "• A programme rebuilds a product milestone by milestone in a dedicated AI-owned repository. Check get_programme_status before acting on one, and report what the tool returned — never a status you did not read.",
    "• Milestone approval and the hardening conclusion are human clicks on the review card; there is no tool for either, and no merge tool at all. Merges happen automatically when the merge gate passes.",
    "• A refusal from a programme tool is final for that request: say why, and do not retry the same call.",
  ].join("\n"),
};

function truncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  const note = "\n… (truncated)";
  return text.slice(0, Math.max(0, max - note.length)) + note;
}

function toToolResult(name: ProgrammeToolName, result: ProgrammeToolResult, ctx: ToolCallContext): ToolResult {
  const content = truncate(result.text, ctx.maxResultChars);
  if (READ_ONLY_PROGRAMME_TOOLS.includes(name)) {
    return { content, ...(result.ok ? {} : { isError: true }) };
  }
  return {
    content,
    ...(result.ok ? {} : { isError: true }),
    // The registry already authorized the actor; a refusal past that point is
    // the service's own (wrong state, unknown key, policy), reported as
    // blocked rather than failed so the agent says "not done", not "broke".
    outcome: {
      authorized: true,
      executed: result.executed,
      blocked: !result.executed && !result.ok,
      reason: result.text.split("\n")[0] ?? "",
    },
  };
}

/**
 * The programme tools as a `ToolModule`. Register it with the agent's
 * `ToolRegistry`; with the flag off or no target repos it has no tools.
 */
export function createProgrammeToolModule(deps: ProgrammeToolModuleDeps): ToolModule {
  const definitions = programmeToolDefinitions(deps);
  const agentTools: AgentTool[] = definitions.map((definition) => {
    const name = definition.name as ProgrammeToolName;
    return {
      definition,
      requiredPermission: PROGRAMME_TOOL_PERMISSIONS[name],
      mutating: !READ_ONLY_PROGRAMME_TOOLS.includes(name),
      // Resolved per call, so a team-scoped lead is checked against the team
      // that owns the programme's repository, not let through for lack of one.
      resource: (args) => deps.build.toolResource?.(name, args),
      async invoke(args, ctx) {
        const result = await deps.build.invokeTool(name, args, {
          userId: ctx.actorId,
          channel: ctx.conversation.channel,
          threadTs: ctx.conversation.threadTs,
        });
        return toToolResult(name, result, ctx);
      },
    };
  });
  return {
    name: PROGRAMME_TOOL_MODULE_NAME,
    tools: agentTools,
    intentClasses: PROGRAMME_INTENT_CLASSES,
    ...(agentTools.length > 0 ? { promptSections: [PROGRAMME_PROMPT_SECTION] } : {}),
  };
}

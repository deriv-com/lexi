import { readFileSync } from "fs";
import { load } from "js-yaml";
import { z } from "zod";

/**
 * Schema and loader for `config/escalation-policy.yaml`.
 *
 * This file is the *only* place TypeScript learns the governance channel id.
 * The audit flagged hard-coded Slack channel ids in the dispatch path as
 * existing debt; the escalation ladder does not add more, so the id is read
 * from config here and passed down as data. A repo-wide test asserts the id
 * never appears in a `.ts` file.
 *
 * Validation is deliberately stricter than "parses as YAML". Four
 * constraints in this spec are safety properties rather than preferences, and
 * a config that violates one is rejected at boot rather than obeyed:
 *
 *   - **Every rung must have a resolver.** An accepted-but-unroutable rung
 *     escalates into a void: the ladder records that it advanced while nobody
 *     was ever told. This is not hypothetical — the original ladder shipped
 *     `ASSIGNEE_DM` and `LEAD_DM`, and Lexi holds no DM scope at all, so two
 *     of its four rungs could never deliver. The retired names are therefore
 *     rejected by name, with their replacement quoted in the error.
 *   - **Thresholds strictly increase.** A ladder whose later rung fires
 *     earlier than an earlier one has no meaningful ordering, and rung
 *     selection (which walks the ladder by elapsed time) would skip or
 *     oscillate.
 *   - **`stalePr.autoCloseEnabled` cannot be true.** Closing a PR is a
 *     permanent non-goal and violates a standing org constraint. The
 *     key exists so the intent is visible and greppable, not so it can be
 *     flipped; flipping it in config is refused here rather than trusted to a
 *     reviewer noticing.
 *   - **`dryRun` defaults to true.** See the field comment: the safe value is
 *     the one you get by forgetting the key.
 *
 * ## Why the ladder escalates by mention rather than by destination
 *
 * Lexi cannot DM anyone. Every rung therefore posts to the same platform team
 * channel and escalates by *who is tagged* — PIC, then team lead, then the
 * senior manager — before topping out in the governance channel. Landing each
 * rung where the previous one landed is the point rather than a compromise:
 * the pressure accumulates in front of the same audience, and the repo owner
 * confirmed that visibility is intended.
 */

/**
 * The rungs this build implements, in ladder order.
 *
 * Each one resolves to a channel Lexi can actually post to. `PIC`, `TEAM_LEAD`
 * and `MANAGER` all target the module's platform team channel and differ only
 * in whom they mention; `GOVERNANCE` targets the governance channel from
 * config.
 */
export const ESCALATION_RUNGS = ["PIC", "TEAM_LEAD", "MANAGER", "GOVERNANCE"] as const;

export type EscalationRung = (typeof ESCALATION_RUNGS)[number];

/**
 * Rung names that existed before the ladder was rebuilt around mentions, and
 * what to write instead.
 *
 * Kept as data rather than deleted so an operator editing an older config gets
 * a migration instruction instead of "invalid enum value" and a trip to the
 * source. `TEAM_CHANNEL` has no single successor — every rung is a team-channel
 * post now — so it is answered with the choice rather than a substitution.
 */
const RETIRED_RUNGS: Record<string, string> = {
  ASSIGNEE_DM: 'use "PIC" — Lexi has no DM scope, so the person-in-charge is tagged in the team channel instead',
  LEAD_DM: 'use "TEAM_LEAD" — Lexi has no DM scope, so the lead is tagged in the team channel instead',
  MANAGER_DM: 'use "MANAGER" — Lexi has no DM scope, so the manager is tagged in the team channel instead',
  TEAM_CHANNEL:
    'every rung now posts to the team channel and differs only in who is tagged — pick "PIC", "TEAM_LEAD" or "MANAGER"',
};

const escalationRungSchema = z.enum(ESCALATION_RUNGS);

const ladderStepSchema = z.object({
  rung: escalationRungSchema,
  /** Hours of no acknowledged progress after which this rung becomes due. */
  afterHours: z.number().nonnegative(),
});

export const escalationPolicySchema = z
  .object({
    version: z.string(),
    /**
     * PROGRESS_CHECK_ENABLED. Defaults off: everything new in this build ships
     * dark and is enabled as its own deliberate decision.
     */
    enabled: z.boolean().default(false),
    /**
     * When true, a sweep resolves every target and renders every message but
     * posts nothing, returning the plan for review.
     *
     * Defaults to **true**, and that direction is the whole point. The first
     * sweep does not meet one stalled subject, it meets an entire backlog at
     * once, and every one of those messages tags a real person in a channel
     * their whole team reads. An opt-in `--dry-run` is a flag someone has to
     * remember exactly once, on the single occasion where forgetting it is
     * unrecoverable — you cannot un-ping forty people. So the safe mode is the
     * one you get by doing nothing, and turning it off is an explicit edit
     * made after reading a plan.
     */
    dryRun: z.boolean().default(true),
    governance: z.object({
      channelId: z.string().min(1),
      channelName: z.string().min(1),
    }),
    ladder: z.array(ladderStepSchema).min(1),
    acknowledgement: z
      .object({
        stopOnReaction: z.boolean().default(true),
        stopOnThreadReply: z.boolean().default(true),
        dedupePerSubject: z.boolean().default(true),
      })
      .prefault({}),
    staleness: z
      .object({
        excludeSelfWrites: z.boolean().default(true),
        /**
         * Actor whose activity never counts as progress — see `isProgressActor`.
         *
         * Defaulted to the real installed App rather than "lexi", which was a
         * guess that matched nothing: while it was wrong, Lexi's own comments
         * counted as human activity and every issue it had processed reported
         * the same staleness. Detection no longer depends on this (any `[bot]`
         * suffix is automation), but a wrong default here is still a wrong
         * statement about who Lexi is.
         */
        selfActor: z.string().default("lexi-app"),
        /**
         * Further automation that is not human engagement.
         *
         * GitHub Apps are already covered by the `[bot]` suffix rule, so this
         * exists for automation posting under a plain login — a machine user or
         * a PAT. Empty by default: an unlisted human must never be silently
         * reclassified as a bot, which would stop their issue being chased.
         */
        otherBotActors: z.array(z.string()).default([]),
        minIdleHours: z.number().nonnegative().default(24),
      })
      .prefault({}),
    reminders: z
      .object({
        scheduleCron: z.string().default("0 9 * * 1-5"),
        maxPerSubjectPerDay: z.number().int().positive().default(1),
        /**
         * Dry run for `ProgressCheckService` — the standalone reminder job
         * this block already describes.
         *
         * Separate from the top-level `dryRun`, which governs
         * `EscalationLadderService`. They are two services with two sweeps,
         * and a single shared switch would mean flipping one live silently
         * flips the other. Both default true, so the distinction only ever
         * costs an extra deliberate edit, never an accidental broadcast.
         *
         * Defaults to **true** for the same reason the ladder's does: the
         * first sweep does not meet one stale issue, it meets the entire
         * backlog, and every message tags a named person in a channel their
         * team reads. You cannot un-ping those people.
         */
        dryRun: z.boolean().default(true),
        /**
         * Ceiling on notifications sent by one sweep.
         *
         * Positive by construction: zero would be a silent mute that looks
         * exactly like a sweep with nothing to do, and turning tracking off
         * is what `enabled` is for.
         */
        maxNotificationsPerRun: z.number().int().positive().default(10),
      })
      .prefault({}),
    stalePr: z
      .object({
        nudgeAfterDays: z.number().positive().default(7),
        autoCloseEnabled: z.literal(false).default(false),
      })
      .prefault({}),
  })
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    let previousHours = -1;

    policy.ladder.forEach((step, index) => {
      if (seen.has(step.rung)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ladder", index, "rung"],
          message: `duplicated rung "${step.rung}" — each rung may appear at most once`,
        });
      }
      seen.add(step.rung);

      if (step.afterHours <= previousHours) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ladder", index, "afterHours"],
          message: `afterHours must strictly increase down the ladder (got ${step.afterHours} after ${previousHours})`,
        });
      }
      previousHours = step.afterHours;
    });
  });

export type EscalationPolicy = z.infer<typeof escalationPolicySchema>;
export type EscalationLadderStep = EscalationPolicy["ladder"][number];

/**
 * Validates an already-parsed policy object. Throws with every offending path
 * listed, matching `loadQuickFixOwnersConfig`'s error shape — misconfiguration
 * should be readable at boot, not a stack trace at the first escalation.
 */
export function parseEscalationPolicy(raw: unknown): EscalationPolicy {
  // reportInput: zod 4 omits the rejected value from issues unless asked, and
  // describeIssue needs it to name a retired rung's replacement.
  const result = escalationPolicySchema.safeParse(raw, { reportInput: true });
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${describeIssue(issue)}`)
    .join("\n");
  throw new Error(`Invalid escalation policy:\n${issues}`);
}

/**
 * Zod reports an out-of-enum value and a disallowed literal in generic terms
 * ("Invalid enum value", "Invalid literal value"). Both cases here mean
 * something specific that a reader needs to know — the rung was renamed, or
 * PR auto-close is permanently fenced — so they are named explicitly.
 *
 * A retired rung gets its replacement quoted. Renaming an enum that lives in
 * YAML is only safe if the failure tells the operator what to write instead;
 * otherwise the rename turns every older config into a boot error with no
 * instructions.
 */
function describeIssue(issue: z.ZodIssue): string {
  if (issue.code === "invalid_value" && issue.path.includes("rung")) {
    const received = String(issue.input);
    const retired = RETIRED_RUNGS[received];
    if (retired) {
      return `"${received}" is no longer a rung — ${retired}`;
    }
    return `unknown rung "${received}" — expected one of ${ESCALATION_RUNGS.join(", ")}`;
  }

  if (issue.path.includes("autoCloseEnabled")) {
    return "stalePr.autoCloseEnabled must be false — PR auto-close is a permanent non-goal, Lexi never closes or merges a PR";
  }

  return issue.message;
}

/**
 * Reads and validates the policy from disk. Throws on a missing or malformed
 * file: an escalation ladder that silently falls back to defaults would page
 * the wrong people (or nobody) with no indication anything was wrong.
 */
export function loadEscalationPolicy(path: string): EscalationPolicy {
  return parseEscalationPolicy(load(readFileSync(path, "utf-8")));
}

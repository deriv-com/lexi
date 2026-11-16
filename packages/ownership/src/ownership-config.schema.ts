import { z } from "zod";

/**
 * Ownership is two-dimensional.
 *
 * A **module** is the most specific owning area (payments, kyc, partners,
 * standalone P2P…), not the delivery platform and not a repository key.
 * Every routing module has a person-in-charge per platform, while repository
 * identity remains in repos.yaml and each **platform** retains its own Slack
 * channel and team lead.
 *
 * The original `component -> {team, channel}` shape could not express that.
 * It forced one answer to "who owns payments" when there have always been two,
 * which is how a mobile payments bug ends up in a web engineer's queue.
 *
 * Both shapes are accepted. `platforms` + `modules` is the real one;
 * `components` is retained so existing callers and their tests keep
 * compiling and passing, and is synthesised from `platforms` when absent
 * (see `OwnershipResolver`). Nothing here names a person: logins are
 * resolved to Slack IDs through the derived `PersonDirectory`, and the
 * manager edge above a team lead comes from `people-overrides.yaml`, never
 * from this file.
 */

export const PLATFORM_KEYS = ["web", "mobile"] as const;
export type Platform = (typeof PLATFORM_KEYS)[number];

export const platformSchema = z.enum(PLATFORM_KEYS);

/** One platform: its team name, its Slack channel, and who leads it. */
export const platformConfigSchema = z.object({
  team: z.string().min(1),
  /** Human-readable channel name, e.g. `#team-web`. */
  channel: z.string().min(1),
  /** Slack channel ID, e.g. `C0TEST03`. Optional so tests stay terse. */
  channelId: z.string().min(1).optional(),
  /** GitHub login of the platform's team lead — rung 2 of the ladder. */
  teamLead: z.string().min(1),
});

/** The per-platform half of a module's ownership. */
export const modulePlatformOwnershipSchema = z.object({
  /** GitHub login of the person-in-charge for this module on this platform. */
  pic: z.string().min(1),
});

export const moduleConfigSchema = z.object({
  web: modulePlatformOwnershipSchema,
  mobile: modulePlatformOwnershipSchema,
  description: z.string().optional(),
  /**
   * Heuristic seeds for `ModuleInferenceService`. Deterministic-first
   *: these are matched in plain code so the common case costs no
   * model call at all. Config, not code, so adding a keyword is a YAML edit.
   */
  keywords: z.array(z.string().min(1)).default([]),
  /** Path/URL fragments that imply this module, e.g. `/cashier/`. */
  paths: z.array(z.string().min(1)).default([]),
});

export const componentConfigSchema = z.object({
  team: z.string().min(1),
  channel: z.string().min(1),
  description: z.string().optional(),
  owners: z.array(z.string().min(1)).default([]),
});

export const ownershipConfigSchema = z
  .object({
    /** Present in the real config; absent in legacy/component-only fixtures. */
    platforms: z
      .object({
        web: platformConfigSchema,
        mobile: platformConfigSchema,
      })
      .optional(),
    modules: z.record(z.string(), moduleConfigSchema).default({}),
    /**
     * The module a resolution falls back to. Kept as a *distinct* key rather
     * than aliasing a real module, so "we could not tell" is never rendered
     * as a confident answer about a specific product area.
     */
    defaultModule: z.string().min(1).default("default"),
    /** Platform assumed when nothing on the issue disambiguates it. */
    defaultPlatform: platformSchema.default("web"),
    /**
     * Existing tracker labels that identify a module/product area. These are
     * deliberately separate from `labelMappings`, whose values are legacy
     * one-dimensional components such as web/mobile. A label like
     * `product:app.example.com-partners-app` identifies Partners; `domain:web`
     * only identifies its delivery platform.
     */
    moduleLabelMappings: z.record(z.string(), z.string()).default({}),
    /**
     * Legacy one-dimensional surface. Optional: synthesised from `platforms`
     * when omitted, so the real config declares each channel exactly once.
     */
    components: z.record(z.string(), componentConfigSchema).optional(),
    labelMappings: z.record(z.string(), z.string()).default({}),
    priorityLabels: z.array(z.string()).default([]),
    statusLabels: z
      .object({
        toDo: z.string().default("status:to_do"),
        inProgress: z.string().default("status:in_progress"),
      })
      .default({ toDo: "status:to_do", inProgress: "status:in_progress" }),
  })
  .superRefine((config, ctx) => {
    // A config must express ownership *somehow*. Accepting one with neither
    // block would boot a resolver that silently answers "unassigned" forever.
    if (!config.platforms && !config.components) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["components"],
        message: "Required — provide `platforms` + `modules`, or the legacy `components` map",
      });
    }
    // Only meaningful once modules exist; an empty map is the legacy shape.
    const moduleKeys = Object.keys(config.modules);
    if (moduleKeys.length > 0 && !config.modules[config.defaultModule]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultModule"],
        message: `"${config.defaultModule}" is not defined under \`modules\` (have: ${moduleKeys.join(", ")})`,
      });
    }
    for (const [label, moduleKey] of Object.entries(config.moduleLabelMappings)) {
      if (!config.modules[moduleKey]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["moduleLabelMappings", label],
          message: `"${moduleKey}" is not defined under \`modules\``,
        });
      }
    }
  });

export type PlatformConfig = z.infer<typeof platformConfigSchema>;
export type ModulePlatformOwnership = z.infer<typeof modulePlatformOwnershipSchema>;
export type ModuleConfig = z.infer<typeof moduleConfigSchema>;
export type ComponentConfig = z.infer<typeof componentConfigSchema>;
export type OwnershipConfig = z.infer<typeof ownershipConfigSchema>;

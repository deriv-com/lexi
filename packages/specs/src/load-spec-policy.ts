import { readFileSync } from "fs";
import { resolve } from "path";
import { load } from "js-yaml";
import { z } from "zod";
import { COVERAGE_DIMENSIONS } from "./coverage-dimensions";

/**
 * Loads and validates `config/spec-policy.yaml`.
 *
 * The stop condition (`isReadyToDraft`) is deterministic code reading this
 * file rather than a model judgement, so the policy is the thing that
 * decides when Lexi stops interrogating a user. A loose cast here would let a
 * typo silently change that behaviour, which is why this validates like
 * `loadOwnershipConfig` does rather than trusting the YAML.
 */

/**
 * Used when the policy file omits `coverage.minDimensionConfidence`.
 *
 * The committed file predates the threshold. Without a default, every
 * `confidence >= policy.coverage.minDimensionConfidence` comparison would be
 * `>= undefined` — always false — and no session would ever become ready to
 * draft. 0.7 is deliberately below "certain": a dimension answered directly by
 * the user should clear it, while a value merely inferred from the thread
 * should not.
 */
export const DEFAULT_MIN_DIMENSION_CONFIDENCE = 0.7;

/** Default location: `spec-policy.yaml` inside `GOVERNANCE_CONFIG_DIR` (`./config` when unset). */
export const SPEC_POLICY_PATH = resolve(process.env.GOVERNANCE_CONFIG_DIR ?? "config", "spec-policy.yaml");

const coverageDimensionSchema = z.enum(COVERAGE_DIMENSIONS);

/**
 * The risk-tier vocabulary, mirrored from `approval.riskTiers` in the same
 * file.
 *
 * `@lexi/governance` owns the approval half of this policy and orders these
 * tiers for the two-person rule. This package cannot import it — `@lexi/specs`
 * deliberately keeps its two dependencies, and `@lexi/governance` pulls in
 * `@lexi/database` and `@lexi/github` — so rather than duplicating the constant
 * across packages, *the config file is the shared source of truth*: the
 * classifier's tiers are validated against `approval.riskTiers` as read from
 * the very same YAML (see the superRefine below).
 */
const riskTierSchema = z.string().min(1);

const classifierRuleSchema = z
  .object({
    /** Stable identifier — reported in `matchedRuleIds` and in the audit trail. */
    id: z.string().min(1),
    /**
     * `raise` sets a floor, `lower` sets a ceiling that only applies when
     * nothing raised. There is no "set exactly" direction on purpose: a rule
     * that could pull a tier down past a raise would break the monotonicity the
     * whole ordering rests on.
     */
    direction: z.enum(["raise", "lower"]),
    tier: riskTierSchema,
    enabled: z.boolean().default(true),
    /** Restrict the searched text to these dimensions. Absent means all of them. */
    dimensions: z.array(coverageDimensionSchema).optional(),
    /** Case-insensitive substring match. Absent means this predicate abstains. */
    anyKeywords: z.array(z.string().min(1)).optional(),
    minPlatforms: z.number().int().nonnegative().optional(),
    maxPlatforms: z.number().int().nonnegative().optional(),
  })
  .strip()
  .refine(
    (rule) =>
      rule.anyKeywords !== undefined || rule.minPlatforms !== undefined || rule.maxPlatforms !== undefined,
    {
      // A rule with no predicates matches everything, which would classify
      // every spec at that rule's tier — including, for a `lower` rule, every
      // spec at `low`. That is precisely the governance hole this feature
      // exists to close, so the schema refuses to express it.
      message: "a classifier rule needs at least one predicate (anyKeywords, minPlatforms or maxPlatforms)",
    },
  );

export type SpecRiskClassifierRule = z.infer<typeof classifierRuleSchema>;

const specPolicySchema = z
  .object({
    version: z.string(),
    // SPEC_SESSIONS_ENABLED. Absent means off — a new capability never turns
    // itself on by omission.
    enabled: z.boolean().default(false),
    writes: z
      .object({
        githubIssuesEnabled: z.boolean().default(false),
        approvalEnabled: z.boolean().default(false),
      })
      .prefault({}),
    coverage: z
      .object({
        mandatoryDimensions: z.array(coverageDimensionSchema).default([...COVERAGE_DIMENSIONS]),
        deferrableDimensions: z.array(coverageDimensionSchema).default([]),
        maxQuestionTurns: z.number().int().positive().default(5),
        minDimensionConfidence: z
          .number()
          .min(0)
          .max(1)
          .default(DEFAULT_MIN_DIMENSION_CONFIDENCE),
      })
      .prefault({}),
    questioning: z
      .object({
        minQuestionsPerTurn: z.number().int().positive().default(2),
        maxQuestionsPerTurn: z.number().int().positive().default(4),
        offerDefaultForEveryQuestion: z.boolean().default(true),
        neverReaskCoveredDimensions: z.boolean().default(true),
        mineBeforeAsking: z.boolean().default(true),
      })
      .prefault({})
      .refine((q) => q.minQuestionsPerTurn <= q.maxQuestionsPerTurn, {
        message: "minQuestionsPerTurn must not exceed maxQuestionsPerTurn",
      }),
    output: z
      .object({
        // Literal, not an enum: a spec filed in `issues` would be
        // swept into that repo's corpus sync, dedup, triage and reproduction
        // machinery, all of which assume every issue is a production defect
        //. The schema refuses to express the mistake.
        requiredRepoRole: z.literal("specs").default("specs"),
        titlePrefix: z.string().default("[Spec]"),
        labels: z
          .object({
            type: z.string().default("type:spec"),
            draft: z.string().default("spec:draft"),
            approved: z.string().default("spec:approved"),
          })
          .prefault({}),
        boardColumn: z.string().default("Spec review"),
        announceInGovernanceChannel: z.boolean().default(true),
      })
      .prefault({}),
    /**
     * The approval half, owned by `@lexi/governance` and read here only for the
     * tier ordering and enabled state the approval card has to agree with. Kept
     * deliberately narrow: the governance package remains the only enforcer.
     */
    approval: z
      .object({
        riskTiers: z.array(riskTierSchema).default(["low", "medium", "high", "critical"]),
        defaultRiskTier: riskTierSchema.default("high"),
        /**
         * Read for DISPLAY only — so the approval card can say whether a second
         * person is required. `evaluateSpecGate` in `@lexi/governance` is the
         * only enforcer. Defaults match governance so a truncated config
         * explains the same rule the gate applies.
         */
        twoPersonRule: z
          .object({
            enabled: z.boolean().default(true),
            minRiskTier: riskTierSchema.default("medium"),
          })
          .prefault({}),
      })
      .prefault({}),
    riskClassifier: z
      .object({
        // Absent means off, and off means every spec is unclassified — which
        // means every spec gets the gate's strict default. A missing config
        // section must never be the reason a spec became self-approvable.
        enabled: z.boolean().default(false),
        rules: z.array(classifierRuleSchema).default([]),
      })
      .prefault({}),
  })
  .strip()
  .superRefine((policy, ctx) => {
    // The classifier and the gate must speak the same vocabulary or a rule
    // silently classifies a spec at a tier `riskTierRank` cannot order — which
    // `evaluateSpecGate` reads as unknown and replaces with `defaultRiskTier`.
    // That fails safe, but it fails *silently*, and a rule that never has the
    // effect its author intended is worse than one that refuses to load.
    const known = new Set(policy.approval.riskTiers);
    if (!known.has(policy.approval.defaultRiskTier)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approval", "defaultRiskTier"],
        message: `defaultRiskTier "${policy.approval.defaultRiskTier}" is not one of approval.riskTiers [${[...known].join(", ")}]`,
      });
    }
    policy.riskClassifier.rules.forEach((rule, index) => {
      if (!known.has(rule.tier)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["riskClassifier", "rules", index, "tier"],
          message: `tier "${rule.tier}" is not one of approval.riskTiers [${[...known].join(", ")}]`,
        });
      }
    });
  });

export type SpecPolicy = z.infer<typeof specPolicySchema>;

export function loadSpecPolicy(path: string = SPEC_POLICY_PATH): SpecPolicy {
  const raw = readFileSync(path, "utf-8");
  return parseSpecPolicy(raw);
}

export function parseSpecPolicy(raw: string): SpecPolicy {
  const parsed = load(raw);
  const result = specPolicySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid spec policy:\n${issues}`);
  }
  return result.data;
}

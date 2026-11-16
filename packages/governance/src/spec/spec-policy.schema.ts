/**
 * Spec / clarification policy schema.
 *
 * Mirrors the loader idiom in config/load-governance-config.ts: read the YAML
 * if present, let Zod supply defaults otherwise. Every default here is the
 * conservative one — an absent or truncated config yields a policy that
 * refuses rather than one that permits.
 */

import { readFileSync, existsSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import { governanceConfigDir } from "../config/config-dir";

/**
 * Risk tiers, ordered least to most consequential. Index order is the
 * comparison: `riskTiers.indexOf(a) >= riskTiers.indexOf(min)`. Keep them in
 * ascending order — the two-person rule reads position, not name.
 */
export const SPEC_RISK_TIERS = ["low", "medium", "high", "critical"] as const;
export type SpecRiskTier = (typeof SPEC_RISK_TIERS)[number];

export const twoPersonRuleSchema = z.object({
  enabled: z.boolean().default(true),
  /** Risk tier at or above which the approver must differ from the requester. */
  minRiskTier: z.enum(SPEC_RISK_TIERS).default("medium"),
  /** Distinct human approvals required at or above `minRiskTier`. */
  requiredApprovals: z.number().int().positive().default(1),
});

export const specApprovalSchema = z.object({
  /**
   * The model may recommend approval; only a human Slack interaction may
   * invoke it. `approve_spec` is separately withheld from the model's
   * tool payload — this is the second, independent refusal.
   */
  humanOnly: z.boolean().default(true),
  twoPersonRule: twoPersonRuleSchema.prefault({}),
  riskTiers: z.array(z.enum(SPEC_RISK_TIERS)).default([...SPEC_RISK_TIERS]),
  /**
   * Tier assumed when a spec carries no risk tier, or one this build does not
   * recognise. Defaults to `high` so an unclassified spec is governed *more*
   * strictly, not less.
   */
  defaultRiskTier: z.enum(SPEC_RISK_TIERS).default("high"),
});

export const specWritesSchema = z.object({
  githubIssuesEnabled: z.boolean().default(false),
  approvalEnabled: z.boolean().default(false),
});

export const specCoverageSchema = z.object({
  mandatoryDimensions: z.array(z.string()).default([]),
  deferrableDimensions: z.array(z.string()).default([]),
  maxQuestionTurns: z.number().int().positive().default(5),
});

export const specQuestioningSchema = z.object({
  minQuestionsPerTurn: z.number().int().positive().default(2),
  maxQuestionsPerTurn: z.number().int().positive().default(4),
  offerDefaultForEveryQuestion: z.boolean().default(true),
  neverReaskCoveredDimensions: z.boolean().default(true),
  mineBeforeAsking: z.boolean().default(true),
});

export const specOutputSchema = z.object({
  requiredRepoRole: z.string().default("specs"),
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
});

export const specPolicySchema = z.object({
  version: z.string().default("1.0.0"),
  enabled: z.boolean().default(false),
  writes: specWritesSchema.prefault({}),
  approval: specApprovalSchema.prefault({}),
  coverage: specCoverageSchema.prefault({}),
  questioning: specQuestioningSchema.prefault({}),
  output: specOutputSchema.prefault({}),
});

export type SpecPolicy = z.infer<typeof specPolicySchema>;
export type SpecApprovalPolicy = z.infer<typeof specApprovalSchema>;
export type TwoPersonRuleConfig = z.infer<typeof twoPersonRuleSchema>;

/**
 * Load `config/spec-policy.yaml`.
 *
 * A missing file yields the schema defaults, which are the refusing ones —
 * `enabled: false` and `writes.approvalEnabled: false`. There is deliberately
 * no "assume permissive when unconfigured" path.
 */
export function loadSpecPolicy(baseDir = governanceConfigDir()): SpecPolicy {
  const path = `${baseDir}/spec-policy.yaml`;
  if (!existsSync(path)) {
    return specPolicySchema.parse({});
  }
  const parsed = loadYaml(readFileSync(path, "utf8")) as Record<string, unknown> | null;
  return specPolicySchema.parse(parsed ?? {});
}

/**
 * Position of a risk tier in the configured ordering, or -1 when the tier is
 * not recognised. Callers treat -1 as "substitute the fail-closed default".
 */
export function riskTierRank(tier: string, policy: SpecApprovalPolicy): number {
  return policy.riskTiers.indexOf(tier as SpecRiskTier);
}

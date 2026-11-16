/**
 * Feature / work-item policy schema.
 *
 * The governance chassis generalises without change — action classes, run
 * budgets and the mutation guard never knew what a "bug" was. What does not
 * generalise is the *vocabulary*: `never-touch-policy.ts` protects on P0/P1
 * priority, S1/S2 severity and "was it reproduced", none of which a feature
 * or a chore possesses. `vocabulary` below is the per-kind replacement.
 */

import { readFileSync, existsSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import { governanceConfigDir } from "../config/config-dir";

export const WORK_ITEM_KINDS = ["bug", "feature", "chore", "spec"] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

/**
 * Predicates the per-kind never-touch variant may assert on. Deliberately a
 * closed set: a config naming a predicate this build cannot evaluate is a
 * silent hole in the guard, so the schema rejects it rather than ignoring it.
 */
export const WORK_ITEM_PREDICATES = [
  "hasRecentHumanActivity",
  "hasOpenLinkedPR",
  "isExplicitlyAssigned",
  "hasDependentWorkItems",
] as const;
export type WorkItemPredicate = (typeof WORK_ITEM_PREDICATES)[number];

const perKindFields = z
  .object({
    bug: z.array(z.string()).default([]),
    feature: z.array(z.string()).default([]),
    chore: z.array(z.string()).default([]),
    spec: z.array(z.string()).default([]),
  })
  .prefault({});

const perKindPredicates = z
  .object({
    bug: z.array(z.enum(WORK_ITEM_PREDICATES)).default([]),
    feature: z.array(z.enum(WORK_ITEM_PREDICATES)).default([]),
    chore: z.array(z.enum(WORK_ITEM_PREDICATES)).default([]),
    spec: z.array(z.enum(WORK_ITEM_PREDICATES)).default([]),
  })
  .prefault({});

export const featureVocabularySchema = z.object({
  /**
   * What must be present before an item of this kind may be dispatched. The
   * bug row keeps `reproduction`; no other row has it, which is the whole
   * point — requiring reproduction of a chore leaves a caller two bad options,
   * a refusal that can never be satisfied or a false claim of reproduction.
   */
  requiredFields: perKindFields,
  /** Which protective predicates apply to which kind. */
  neverTouchPredicates: perKindPredicates,
});

export const featureWorkItemsSchema = z.object({
  kinds: z.array(z.enum(WORK_ITEM_KINDS)).default([...WORK_ITEM_KINDS]),
  statuses: z.array(z.string()).default([]),
  initialStatus: z.string().default("PROPOSED"),
  terminalStatuses: z.array(z.string()).default(["VERIFIED", "CANCELLED"]),
});

export const featureDispatchSchema = z.object({
  requireApprovedSpecForFeature: z.boolean().default(true),
  requireTargetForChore: z.boolean().default(true),
  requireDesignSkillForUiTasks: z.boolean().default(true),
  /**
   * What happens when no policy row matches the request. `human_review` is the
   * only safe value; `allow` is deliberately absent from the enum so it cannot
   * be configured into existence.
   */
  noPolicyMatchAction: z.enum(["human_review", "deny"]).default("human_review"),
});

export const featureVerificationSchema = z.object({
  featureVerifiedBy: z.string().default("deployment_record"),
  bugVerifiedBy: z.string().default("retest"),
  requireAllLinkedPrsMerged: z.boolean().default(true),
  /**
   * Spec exit gate — spec conformance verification (@lexi/workflows).
   *
   * The config half of the flag; `SPEC_CONFORMANCE_ENABLED` is the env half and
   * the two are AND-ed by `isSpecConformanceEnabled()`. Defaults false: a
   * missing key must not switch a capability on.
   *
   * This gates a REPORT, never a gate. Conformance drift is surfaced to a human
   * in the governance channel; nothing here can fail a PR or block a deploy.
   */
  specConformanceEnabled: z.boolean().default(false),
});

export const featurePolicySchema = z.object({
  version: z.string().default("1.0.0"),
  enabled: z.boolean().default(false),
  workItems: featureWorkItemsSchema.prefault({}),
  dispatch: featureDispatchSchema.prefault({}),
  verification: featureVerificationSchema.prefault({}),
  vocabulary: featureVocabularySchema.prefault({}),
});

export type FeaturePolicy = z.infer<typeof featurePolicySchema>;
export type FeatureVocabulary = z.infer<typeof featureVocabularySchema>;

/**
 * Load `config/feature-policy.yaml`.
 *
 * A missing file yields schema defaults, all of which refuse:
 * `enabled: false`, `requireApprovedSpecForFeature: true`, and empty
 * `requiredFields` rows that `evaluateRequiredFields` treats as unconfigured
 * rather than as "nothing required".
 */
export function loadFeaturePolicy(baseDir = governanceConfigDir()): FeaturePolicy {
  const path = `${baseDir}/feature-policy.yaml`;
  if (!existsSync(path)) {
    return featurePolicySchema.parse({});
  }
  const parsed = loadYaml(readFileSync(path, "utf8")) as Record<string, unknown> | null;
  return featurePolicySchema.parse(parsed ?? {});
}

/** Whether a kind is one this build recognises. */
export function isKnownWorkItemKind(kind: string): kind is WorkItemKind {
  return (WORK_ITEM_KINDS as readonly string[]).includes(kind);
}

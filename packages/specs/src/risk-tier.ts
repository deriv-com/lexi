import type { CoverageDimension } from "@lexi/contracts";
import type { SpecCoverageRecord } from "./coverage";
import type { SpecPolicy, SpecRiskClassifierRule } from "./load-spec-policy";

/**
 * Risk-tier classification.
 *
 * `evaluateSpecGate` applies the two-person rule at and above
 * `twoPersonRule.minRiskTier`, so this module decides whether a spec needs a
 * second pair of eyes. Three properties make that safe to automate:
 *
 *   1. **No LLM, ever**. A model asked to rate the risk of the spec it
 *      has just written would be voting on its own supervision, and the answer
 *      would not survive a replay — two runs over the same coverage record
 *      could disagree, and the tier feeds `contentHash`.
 *   2. **Rules in config, not here.** Every keyword, tier and threshold comes
 *      from `config/spec-policy.yaml`. Changing what counts as risky is a
 *      config review; this file only knows how to *apply* rules.
 *   3. **No tier is a real answer.** When nothing matches, the result is
 *      `tier: null` — not `"low"`, and not the default either. The absent tier
 *      travels to `evaluateSpecGate`, which substitutes `defaultRiskTier`
 *      (`high`) and records `risk_tier_unknown_defaulted`. Substituting here as
 *      well would mean two places implement the fail-safe, and a spec whose
 *      classification silently failed would be indistinguishable from one
 *      genuinely assessed as high risk.
 *
 * ## Resolution order
 *
 * A `raise` always beats a `lower`, and ties resolve to the *higher* tier in
 * both directions. The rule set is therefore monotone upward: adding a rule can
 * never make a spec easier to approve. Without that property, "copy change on
 * the withdrawal screen" would classify as low.
 */

export interface SpecRiskClassification {
  /** The resolved tier, or `null` when no rule matched. Never a guess. */
  tier: string | null;
  /** False when `tier` is null — stated explicitly so callers cannot mistake the two. */
  classified: boolean;
  /** Ids of every rule that matched, in policy order. Travels into the audit trail. */
  matchedRuleIds: string[];
  /** Human-readable account of the decision, for the approval card and logs. */
  reason: string;
}

export interface SpecRiskInput {
  coverage: SpecCoverageRecord;
  /** Folded into the searched text: "Copy change: …" is usually in the title. */
  title?: string;
}

/** The policy slice this module reads — structural, so tests can supply a literal. */
export type SpecRiskPolicy = Pick<SpecPolicy, "approval" | "riskClassifier">;

function rank(tier: string | null | undefined, policy: SpecRiskPolicy): number {
  return tier == null ? -1 : policy.approval.riskTiers.indexOf(tier);
}

/**
 * Is `tier` at or above `floor`?
 *
 * An absent or unrecognised tier answers **true**, which looks surprising until
 * you consider the only question a caller ever asks: "is this spec below the
 * bar, so I can skip the second reviewer?" The gate substitutes
 * `defaultRiskTier` for an unknown tier, and that default sits above
 * `minRiskTier` — so answering `false` here would let a caller conclude an
 * unclassified spec is safe, which is exactly the governance hole this feature
 * closes.
 */
export function riskTierAtLeast(
  tier: string | null | undefined,
  floor: string,
  policy: SpecRiskPolicy,
): boolean {
  const tierRank = rank(tier, policy);
  if (tierRank === -1) return true;
  const floorRank = rank(floor, policy);
  if (floorRank === -1) return true;
  return tierRank >= floorRank;
}

/**
 * The text a rule's keywords are matched against.
 *
 * Only `notes` — the answer in the user's own words — plus the title. Not the
 * dimension keys and not the rendered defaults: every unanswered spec carries
 * the same standing defaults, so matching those would classify identical text
 * on every spec that had not been filled in.
 */
function searchText(input: SpecRiskInput, dimensions: readonly CoverageDimension[] | undefined): string {
  const entries = Object.entries(input.coverage.dimensions) as Array<
    [CoverageDimension, { notes?: string } | undefined]
  >;

  const parts: string[] = [];
  // The title is scoped material only for a whole-document rule. A rule that
  // named `dimensions: [dependencies]` asked about dependencies, and quietly
  // searching the title too would defeat the scoping.
  if (dimensions === undefined && input.title) parts.push(input.title);

  for (const [dimension, entry] of entries) {
    if (dimensions !== undefined && !dimensions.includes(dimension)) continue;
    if (entry?.notes) parts.push(entry.notes);
  }

  return parts.join("\n").toLowerCase();
}

/**
 * How many platforms the spec names.
 *
 * Split on the separators a human actually types. Deliberately conservative:
 * an unanswered `platforms` dimension counts as 0, which fails no `minPlatforms`
 * rule and passes every `maxPlatforms` one — so breadth alone never raises a
 * spec nobody described, and a `maxPlatforms` lowering rule still needs its
 * keywords before it can fire.
 */
function platformCount(coverage: SpecCoverageRecord): number {
  const notes = coverage.dimensions.platforms?.notes;
  if (!notes) return 0;
  return notes
    .split(/[,/&]|\band\b|\+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

function matches(rule: SpecRiskClassifierRule, input: SpecRiskInput): boolean {
  // Every stated predicate must hold. An absent predicate abstains rather than
  // failing, which is what lets a rule be keywords-only or breadth-only.
  if (rule.anyKeywords !== undefined) {
    const text = searchText(input, rule.dimensions);
    if (!rule.anyKeywords.some((keyword) => text.includes(keyword.toLowerCase()))) return false;
  }

  if (rule.minPlatforms !== undefined && platformCount(input.coverage) < rule.minPlatforms) return false;
  if (rule.maxPlatforms !== undefined && platformCount(input.coverage) > rule.maxPlatforms) return false;

  return true;
}

/**
 * Classify a spec's risk tier from its coverage record.
 *
 * Pure: no I/O, no clock, no randomness. That is what lets `draftSpec` stamp
 * the tier into the frontmatter without making `contentHash` depend on when
 * the render happened — the bug this area has already had once.
 */
export function classifySpecRisk(input: SpecRiskInput, policy: SpecRiskPolicy): SpecRiskClassification {
  const unclassified = (reason: string): SpecRiskClassification => ({
    tier: null,
    classified: false,
    matchedRuleIds: [],
    reason,
  });

  if (!policy.riskClassifier.enabled) {
    return unclassified(
      "Risk classification is disabled (riskClassifier.enabled), so the spec carries no tier and the approval gate applies its default.",
    );
  }

  const active = policy.riskClassifier.rules.filter((rule) => rule.enabled);
  const matched = active.filter((rule) => matches(rule, input));

  if (matched.length === 0) {
    return unclassified(
      "No classifier rule matched, so the spec carries no risk tier and the approval gate applies its stricter default.",
    );
  }

  const raises = matched.filter((rule) => rule.direction === "raise");
  // A raise always wins. Only when nothing raised do the lowering rules get to
  // speak, and then the STRICTEST of them wins — ambiguity about how safe
  // something is resolves upward.
  const deciding = raises.length > 0 ? raises : matched;

  const winner = deciding.reduce((best, rule) =>
    rank(rule.tier, policy) > rank(best.tier, policy) ? rule : best,
  );

  const direction = raises.length > 0 ? "raised" : "lowered";
  return {
    tier: winner.tier,
    classified: true,
    matchedRuleIds: matched.map((rule) => rule.id),
    reason: `Risk ${direction} to ${winner.tier} by ${winner.id} (matched: ${matched.map((r) => r.id).join(", ")}).`,
  };
}

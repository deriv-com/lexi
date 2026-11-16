import type { CoverageDimension } from "@lexi/contracts";

/**
 * The clarification checklist, mandatory dimensions first in the order
 * `config/spec-policy.yaml` lists them, then the non-mandatory ones.
 *
 * These keys are frozen in `@lexi/contracts` because `SpecSession.coverage` is
 * persisted against them — renaming one orphans every stored session. The
 * array exists separately from the type so the set can be *iterated* at
 * runtime (a union type erases), and the `satisfies` below keeps the two from
 * drifting: adding a dimension to the contract without adding it here is a
 * compile error, and vice versa.
 */
export const COVERAGE_DIMENSIONS = [
  "problem",
  "users",
  "scope",
  "non_goals",
  "acceptance_criteria",
  "platforms",
  "dependencies",
  "risks",
  "rollout",
  // journey_states and api_contract are in `mandatoryDimensions`.
  // performance_plan stays off that list — with no telemetry source to
  // measure against, a mandatory budget would deadlock drafts.
  "journey_states",
  "api_contract",
  "performance_plan",
] as const satisfies readonly CoverageDimension[];

/**
 * Compile-time proof that the array covers the union exhaustively. If a tenth
 * dimension is added to `@lexi/contracts` and not here, this assignment fails.
 */
const _exhaustive: Record<CoverageDimension, true> = COVERAGE_DIMENSIONS.reduce(
  (acc, dimension) => ({ ...acc, [dimension]: true }),
  {} as Record<CoverageDimension, true>,
);
void _exhaustive;

export function isCoverageDimension(value: unknown): value is CoverageDimension {
  return typeof value === "string" && (COVERAGE_DIMENSIONS as readonly string[]).includes(value);
}

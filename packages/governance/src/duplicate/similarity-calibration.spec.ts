import { describe, it, expect } from "vitest";
import {
  DuplicateOrchestrator,
  type DuplicateOrchestratorConfig,
} from "./duplicate-orchestrator";
import { HeuristicDuplicateAdjudicator } from "./adjudication";
import { InMemoryVectorIndexProvider, DisabledVectorIndexProvider } from "./semantic-index";
import type { IssueSearchCandidate } from "./lexical-search";
import { hybridRetrieval } from "./hybrid-retrieval";
import { computeCandidateSimilarity } from "./candidate-similarity";

/**
 * The scale mismatch at the heart of the duplicate pipeline.
 *
 * `hybridRetrieval` fuses its three tiers with reciprocal rank fusion —
 * `weight / (60 + rank + 1)` — so a candidate ranked FIRST in all three tiers
 * scores at most `1.0 / 61 ≈ 0.0164`. `DuplicateOrchestrator` handed that
 * fusion score to the adjudicator as `similarity`, and every adjudicator on
 * every path thresholds `similarity` at >= 0.75 (DUPLICATE) and >= 0.5
 * (POSSIBLE_DUPLICATE):
 *
 *   - `HeuristicDuplicateAdjudicator`            (LLM flag off / no API key)
 *   - `LlmDuplicateAdjudicator.fallbackDecisions` (LLM gateway outage)
 *   - the LLM prompt itself, which renders the number as "lexical similarity"
 *
 * An RRF score encodes RANK, not likeness: a candidate ranked #1 in one tier
 * scores `0.35/61` whether it is a perfect match or the least-bad of three
 * terrible ones. So the fix is NOT to lower the thresholds onto the RRF scale —
 * that would make the pipeline fire on the best available candidate regardless
 * of quality. The fix is to compute a real 0-1 likeness from the per-tier
 * similarity scores the candidates already carry, and leave RRF doing the one
 * job it is good at: ORDERING.
 */

const REPO = "acme-internal/issues";

/**
 * Corpus fixtures shaped like `acme-internal/issues`: a title plus a
 * Steps / Expected / Actual body, drawn from the cashier, trading and auth
 * areas that dominate the real corpus.
 */
const CANONICAL: IssueSearchCandidate = {
  number: 4102,
  title: "Deposit button does nothing on iOS cashier",
  body: [
    "Steps to reproduce:",
    "1. Log in on iOS Safari",
    "2. Open /cashier/deposit",
    "3. Tap the Deposit button",
    "Expected: the deposit sheet opens",
    "Actual: nothing happens, the deposit button does nothing on the iOS cashier",
  ].join("\n"),
  labels: ["bug", "cashier"],
  state: "open",
  url: `https://github.com/${REPO}/issues/4102`,
};

/**
 * The same issue, re-submitted verbatim — the canonical's own text fed back in.
 * This is the "byte-identical issue" the pipeline provably could not detect.
 */
const VERBATIM_REPORT = {
  title: CANONICAL.title,
  steps: [
    "Steps to reproduce:",
    "1. Log in on iOS Safari",
    "2. Open /cashier/deposit",
    "3. Tap the Deposit button",
  ],
  actual: [
    "Expected: the deposit sheet opens",
    "Actual: nothing happens, the deposit button does nothing on the iOS cashier",
  ].join("\n"),
};

/**
 * The same defect reported afresh through intake, which collects title / steps
 * / actual as separate fields and so drops the stored issue's template
 * scaffolding. This is the ordinary duplicate shape — the wording overlaps
 * heavily but is not identical, so it scores below a verbatim re-post. Landing
 * in the review band rather than the auto-reject band is the intended,
 * conservative outcome for a pipeline whose downstream can close issues.
 */
const RESTATED_REPORT = {
  title: CANONICAL.title,
  steps: ["Log in on iOS Safari", "Open /cashier/deposit", "Tap the Deposit button"],
  actual: "nothing happens, the deposit button does nothing on the iOS cashier",
};

/**
 * Same screen and platform, DIFFERENT operation. A human triager would call
 * this related but not the same bug — it must not be auto-rejected.
 */
const SIMILAR_BUT_DISTINCT = {
  title: "Withdrawal button unresponsive on iOS cashier",
  steps: ["Log in on iOS Safari", "Open /cashier/withdraw", "Tap the Withdraw button"],
  actual: "the withdraw button is unresponsive on the iOS cashier and no sheet appears",
};

/** A different product area entirely. */
const UNRELATED = {
  title: "Chart timeframe resets after page refresh",
  steps: ["Open the trading chart", "Set timeframe to 4h", "Refresh the page"],
  actual: "the chart timeframe resets to 1m instead of keeping the selection",
};

const OTHER_CORPUS: IssueSearchCandidate[] = [
  {
    number: 4110,
    title: "Withdrawal button unresponsive on iOS cashier",
    body: [
      "Steps to reproduce:",
      "1. Log in on iOS Safari",
      "2. Open /cashier/withdraw",
      "3. Tap the Withdraw button",
      "Expected: the withdrawal sheet opens",
      "Actual: the withdraw button is unresponsive on the iOS cashier and no sheet appears",
    ].join("\n"),
    labels: ["bug", "cashier"],
    state: "open",
    url: `https://github.com/${REPO}/issues/4110`,
  },
  {
    number: 4211,
    title: "Chart timeframe resets after page refresh",
    body: [
      "Steps to reproduce:",
      "1. Open the trading chart",
      "2. Set timeframe to 4h",
      "3. Refresh the page",
      "Expected: the chart keeps the 4h timeframe",
      "Actual: the chart timeframe resets to 1m instead of keeping the selection",
    ].join("\n"),
    labels: ["bug", "trading"],
    state: "open",
    url: `https://github.com/${REPO}/issues/4211`,
  },
  {
    number: 4315,
    title: "MT5 password reset email never arrives",
    body: [
      "Steps to reproduce:",
      "1. Open the MT5 dashboard",
      "2. Request a password reset",
      "Expected: a reset email arrives",
      "Actual: no email is ever delivered",
    ].join("\n"),
    labels: ["bug", "mt5"],
    state: "open",
    url: `https://github.com/${REPO}/issues/4315`,
  },
];

const CORPUS: IssueSearchCandidate[] = [CANONICAL, ...OTHER_CORPUS];

async function populatedIndex(): Promise<InMemoryVectorIndexProvider> {
  const index = new InMemoryVectorIndexProvider();
  for (const c of CORPUS) {
    await index.upsert({
      id: `${REPO}#${c.number}`,
      issueNumber: c.number,
      repository: REPO,
      text: `${c.title}\n${c.body ?? ""}`,
      updatedAt: "2026-08-01T00:00:00Z",
    });
  }
  return index;
}

function orchestratorConfig(
  over: Partial<DuplicateOrchestratorConfig> = {},
): DuplicateOrchestratorConfig {
  return {
    highConfidenceThreshold: 0.85,
    mediumConfidenceThreshold: 0.6,
    reviewDedupLabel: "lexi:review-dedup",
    retrieval: {},
    llmAdjudicationEnabled: false,
    humanAdjudicationEnabled: false,
    consolidationRequired: false,
    closedIssueSemanticsEnabled: false,
    calibratedSimilarityEnabled: true,
    ...over,
  };
}

async function evaluate(
  report: { title: string; steps: string[]; actual: string },
  over: Partial<DuplicateOrchestratorConfig> = {},
) {
  const orchestrator = new DuplicateOrchestrator(
    await populatedIndex(),
    new HeuristicDuplicateAdjudicator(),
    null,
    null,
    orchestratorConfig(over),
  );
  return orchestrator.evaluate(report.title, report.steps, report.actual, CORPUS);
}

/** The similarity the pipeline assigned to a specific candidate. */
function similarityOf(
  decisions: Array<{ issueNumber: number; similarity: number }>,
  issueNumber: number,
): number {
  const found = decisions.find((d) => d.issueNumber === issueNumber);
  if (!found) throw new Error(`issue #${issueNumber} was not among the adjudicated candidates`);
  return found.similarity;
}

describe("calibrated similarity — the heuristic path can adjudicate at all", () => {
  it("reports a byte-identical issue as a duplicate of the canonical", async () => {
    const outcome = await evaluate(VERBATIM_REPORT);

    expect(outcome.decisions[0].issueNumber).toBe(CANONICAL.number);
    expect(outcome.decisions[0].verdict).toBe("DUPLICATE");
    expect(similarityOf(outcome.decisions, CANONICAL.number)).toBeGreaterThanOrEqual(0.75);
    expect(outcome.action).not.toBe("CREATE_NEW");
  });

  it("surfaces a restated duplicate for review instead of filing it as new", async () => {
    const outcome = await evaluate(RESTATED_REPORT);

    expect(outcome.decisions[0].issueNumber).toBe(CANONICAL.number);
    expect(outcome.decisions[0].verdict).toBe("POSSIBLE_DUPLICATE");
    expect(outcome.action).not.toBe("CREATE_NEW");
  });

  it("does NOT report an unrelated issue as a duplicate", async () => {
    const outcome = await evaluate(UNRELATED);

    const canonical = outcome.decisions.find((d) => d.issueNumber === CANONICAL.number);
    // Either the cashier issue was not retrieved at all, or it was retrieved
    // and scored low. Both are correct; scoring it high is not.
    expect(canonical).toBeDefined();
    expect(canonical!.similarity).toBeLessThan(0.5);
    expect(canonical!.verdict).toBe("NOT_DUPLICATE");
  });

  it("ranks likeness monotonically: verbatim > restated > cousin > stranger", async () => {
    const verbatim = await evaluate(VERBATIM_REPORT);
    const restated = await evaluate(RESTATED_REPORT);
    const similar = await evaluate(SIMILAR_BUT_DISTINCT);
    const unrelated = await evaluate(UNRELATED);

    // All four measured against the SAME canonical issue, so the numbers are
    // directly comparable. This is the property the RRF score could never have:
    // it ranks, but it does not measure.
    const against4102 = (o: Awaited<ReturnType<typeof evaluate>>) =>
      o.decisions.find((d) => d.issueNumber === CANONICAL.number)?.similarity ?? 0;

    expect(against4102(verbatim)).toBeGreaterThan(against4102(restated));
    expect(against4102(restated)).toBeGreaterThan(against4102(similar));
    expect(against4102(similar)).toBeGreaterThan(against4102(unrelated));
  });

  it("matches a cousin report to its OWN canonical, not to the neighbouring bug", async () => {
    // The withdrawal report shares screen, platform and phrasing with the
    // deposit bug. A rank-only signal would happily rank #4102 first; a likeness
    // measure must put #4110 first and leave #4102 well below the duplicate band.
    const outcome = await evaluate(SIMILAR_BUT_DISTINCT);

    expect(outcome.decisions[0].issueNumber).toBe(4110);
    const deposit = outcome.decisions.find((d) => d.issueNumber === CANONICAL.number);
    expect(deposit!.verdict).not.toBe("DUPLICATE");
    expect(deposit!.similarity).toBeLessThan(0.5);
  });

  it("scores a real duplicate far above the RRF ceiling that made the pipeline inert", async () => {
    // Every RRF score is <= 1.0/61. Any similarity above that is proof the
    // adjudicator is no longer being handed a rank-fusion value.
    const outcome = await evaluate(VERBATIM_REPORT);
    expect(similarityOf(outcome.decisions, CANONICAL.number)).toBeGreaterThan(1 / 61);
  });
});

describe("calibrated similarity — the scoring function itself", () => {
  it("returns a full score only when every tier agrees the issues are alike", () => {
    const perfect = computeCandidateSimilarity(
      { structured: 1, lexical: 1, semantic: 1 },
      { semanticAvailable: true },
    );
    expect(perfect).toBeCloseTo(1, 5);
  });

  it("returns zero when no tier scored the candidate", () => {
    expect(computeCandidateSimilarity({}, { semanticAvailable: true })).toBe(0);
  });

  it("is monotonic — raising any tier score cannot lower the result", () => {
    const base = computeCandidateSimilarity(
      { structured: 0.5, lexical: 0.5, semantic: 0.5 },
      { semanticAvailable: true },
    );
    for (const tier of ["structured", "lexical", "semantic"] as const) {
      const raised = computeCandidateSimilarity(
        { structured: 0.5, lexical: 0.5, semantic: 0.5, [tier]: 0.9 },
        { semanticAvailable: true },
      );
      expect(raised, `raising ${tier} lowered the similarity`).toBeGreaterThan(base);
    }
  });

  it("stays within 0-1 for every combination of tier scores", () => {
    for (const s of [undefined, 0, 0.5, 1]) {
      for (const l of [undefined, 0, 0.5, 1]) {
        for (const m of [undefined, 0, 0.5, 1]) {
          const value = computeCandidateSimilarity(
            { structured: s, lexical: l, semantic: m },
            { semanticAvailable: true },
          );
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("clamps out-of-range tier scores instead of propagating them", () => {
    // Cosine similarity implementations return values slightly outside [0,1]
    // through float error, and can return negatives for opposed vectors. An
    // unclamped tier score would leak straight through to the duplicate
    // thresholds — a 1.4 semantic score would manufacture a duplicate verdict.
    const tooHigh = computeCandidateSimilarity(
      { structured: 1.4, lexical: 1.4, semantic: 1.4 },
      { semanticAvailable: true },
    );
    expect(tooHigh).toBeLessThanOrEqual(1);
    expect(tooHigh).toBe(
      computeCandidateSimilarity(
        { structured: 1, lexical: 1, semantic: 1 },
        { semanticAvailable: true },
      ),
    );

    const negative = computeCandidateSimilarity(
      { structured: -0.5, lexical: -1, semantic: -0.2 },
      { semanticAvailable: true },
    );
    expect(negative).toBe(0);

    // The case a final output clamp cannot save: ONE out-of-range tier. Left
    // unclamped it inflates the agreement term enough to swamp the
    // corroboration discount, so a single overshooting tier would outrank a
    // candidate that every tier called a perfect match.
    const oneOverflowingTier = computeCandidateSimilarity(
      { semantic: 5 },
      { semanticAvailable: true },
    );
    const allTiersPerfect = computeCandidateSimilarity(
      { structured: 1, lexical: 1, semantic: 1 },
      { semanticAvailable: true },
    );
    expect(oneOverflowingTier).toBeLessThan(allTiersPerfect);
  });

  it("caps corroboration when a tier reports unavailable but still returns a score", () => {
    // A degraded provider can report unhealthy and still emit a match. Counting
    // that as MORE than full corroboration would score such a candidate above
    // an identical one found while every tier was healthy.
    const raced = computeCandidateSimilarity(
      { structured: 0.9, lexical: 0.9, semantic: 0.9 },
      { semanticAvailable: false },
    );
    const healthy = computeCandidateSimilarity(
      { structured: 0.9, lexical: 0.9, semantic: 0.9 },
      { semanticAvailable: true },
    );
    expect(raced).toBeLessThanOrEqual(healthy);
    expect(raced).toBeLessThanOrEqual(1);
  });

  it("discounts a candidate corroborated by only one tier below one corroborated by all three", () => {
    const oneTier = computeCandidateSimilarity({ lexical: 0.9 }, { semanticAvailable: true });
    const allTiers = computeCandidateSimilarity(
      { structured: 0.9, lexical: 0.9, semantic: 0.9 },
      { semanticAvailable: true },
    );
    expect(oneTier).toBeLessThan(allTiers);
  });

  it("does not penalise a candidate for a tier that was unavailable rather than silent", () => {
    // A degraded pgvector index is not evidence against a candidate. Missing
    // semantic must cost less when semantic could not run at all.
    const semanticDown = computeCandidateSimilarity(
      { structured: 0.8, lexical: 0.8 },
      { semanticAvailable: false },
    );
    const semanticUpButSilent = computeCandidateSimilarity(
      { structured: 0.8, lexical: 0.8 },
      { semanticAvailable: true },
    );
    expect(semanticDown).toBeGreaterThan(semanticUpButSilent);
  });
});

describe("calibrated similarity — retrieval exposes it without changing ordering", () => {
  it("attaches a calibrated similarity to every candidate while RRF still ranks them", async () => {
    const result = await hybridRetrieval(
      VERBATIM_REPORT.title,
      VERBATIM_REPORT.steps,
      VERBATIM_REPORT.actual,
      CORPUS,
      await populatedIndex(),
    );

    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.calibratedSimilarity).toBeGreaterThanOrEqual(0);
      expect(candidate.calibratedSimilarity).toBeLessThanOrEqual(1);
      // The RRF score is retained, unchanged, for ordering.
      expect(candidate.score).toBeLessThanOrEqual(1 / 61);
    }

    const scores = result.candidates.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(result.candidates[0].issueNumber).toBe(CANONICAL.number);
  });

  it("charges a candidate for a SILENT semantic tier but not for an ABSENT one", async () => {
    // The distinction that decides whether duplicate detection quietly gets
    // worse during a pgvector outage. Both runs produce identical structured and
    // lexical scores and neither gets a semantic score; the only difference is
    // whether the tier could have spoken.
    const disabled = await hybridRetrieval(
      VERBATIM_REPORT.title,
      VERBATIM_REPORT.steps,
      VERBATIM_REPORT.actual,
      CORPUS,
      new DisabledVectorIndexProvider(),
    );

    // An operational index that simply holds nothing matching this query: it
    // ran, it had documents, and it declined to match. That IS evidence.
    const operationalButSilent = new InMemoryVectorIndexProvider();
    await operationalButSilent.upsert({
      id: `${REPO}#9001`,
      issueNumber: 9001,
      repository: REPO,
      text: "zzz qqq vvv unrelated tokens sharing nothing with the query",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    const silent = await hybridRetrieval(
      VERBATIM_REPORT.title,
      VERBATIM_REPORT.steps,
      VERBATIM_REPORT.actual,
      CORPUS,
      operationalButSilent,
    );

    const pick = (r: Awaited<ReturnType<typeof hybridRetrieval>>) =>
      r.candidates.find((c) => c.issueNumber === CANONICAL.number)!;

    expect(pick(disabled).tierScores.semantic).toBeUndefined();
    expect(pick(silent).tierScores.semantic).toBeUndefined();
    expect(pick(disabled).tierScores.lexical).toBe(pick(silent).tierScores.lexical);

    expect(pick(disabled).calibratedSimilarity).toBeGreaterThan(
      pick(silent).calibratedSimilarity,
    );
  });

  it("computes similarity from tier scores even when semantic is disabled", async () => {
    const result = await hybridRetrieval(
      VERBATIM_REPORT.title,
      VERBATIM_REPORT.steps,
      VERBATIM_REPORT.actual,
      CORPUS,
      new DisabledVectorIndexProvider(),
    );

    const canonical = result.candidates.find((c) => c.issueNumber === CANONICAL.number);
    expect(canonical).toBeDefined();
    expect(canonical!.tierScores.semantic).toBeUndefined();
    // Lexical and structured alone are still strong evidence for a byte-identical
    // report, and a dead semantic tier must not veto them.
    expect(canonical!.calibratedSimilarity).toBeGreaterThanOrEqual(0.75);
  });
});

describe("calibrated similarity — the flag that keeps this observable before it is authoritative", () => {
  it("leaves the legacy RRF similarity in place when calibration is disabled", async () => {
    // Pins the pre-fix behaviour so the flag is a real switch and not decoration:
    // with calibration off the pipeline still cannot adjudicate, which is exactly
    // why `intake-decision-dependencies` refuses to run on the heuristic path.
    const outcome = await evaluate(VERBATIM_REPORT, { calibratedSimilarityEnabled: false });

    expect(outcome.action).toBe("CREATE_NEW");
    expect(outcome.decisions[0].verdict).toBe("NOT_DUPLICATE");
    expect(outcome.decisions[0].similarity).toBeLessThanOrEqual(1 / 61);
  });

  it("still reports the calibrated similarity for observation while disabled", async () => {
    // The whole point of shipping this dark: operators can compare what the new
    // scoring WOULD have decided against what the live pipeline actually did.
    const outcome = await evaluate(VERBATIM_REPORT, { calibratedSimilarityEnabled: false });

    const canonical = outcome.retrievalResult.candidates.find(
      (c) => c.issueNumber === CANONICAL.number,
    );
    expect(canonical!.calibratedSimilarity).toBeGreaterThanOrEqual(0.75);
  });

  it("defaults to disabled when the caller does not opt in", async () => {
    const config = orchestratorConfig();
    delete (config as Partial<DuplicateOrchestratorConfig>).calibratedSimilarityEnabled;

    const orchestrator = new DuplicateOrchestrator(
      await populatedIndex(),
      new HeuristicDuplicateAdjudicator(),
      null,
      null,
      config,
    );
    const outcome = await orchestrator.evaluate(
      VERBATIM_REPORT.title,
      VERBATIM_REPORT.steps,
      VERBATIM_REPORT.actual,
      CORPUS,
    );

    expect(outcome.action).toBe("CREATE_NEW");
  });
});

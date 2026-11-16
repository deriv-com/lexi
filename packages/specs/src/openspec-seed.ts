import type { AcceptanceCriterion, CoverageDimension } from "@lexi/contracts";
import type { SessionAnswers } from "./spec-session";
import { acceptanceCriteriaFromOpenSpec, type OpenSpecDocument } from "./openspec";

/**
 * Seeds a spec session from an OpenSpec domain spec.
 *
 * The counterpart to `seedSessionFromDocument`, which mines a free-form
 * product document by matching headings against coverage-dimension synonyms.
 * That approach is wrong for OpenSpec: its headings are `Purpose`,
 * `Requirements`, `Requirement: …` and `Scenario: …`, which match almost no
 * dimension synonym, so the generic seeder would return nearly nothing from a
 * document that is in fact the most precise source we have.
 *
 * What OpenSpec is unusually good at is exactly one dimension —
 * `acceptance_criteria` — and this seeds that dimension from the scenarios
 * rather than from prose.
 *
 * ## Why the criteria round-trip byte-for-byte
 *
 * `parseAcceptanceCriteria` splits a dimension's notes per LINE, strips a
 * leading list marker, collapses whitespace, and hashes the result. Rendering
 * one criterion per `- ` line therefore re-mints the SAME `AC-xxxxxxxx` ids
 * that {@link acceptanceCriteriaFromOpenSpec} computed, and the approved
 * document's rendered `- **AC-xxxxxxxx** — text` lines parse back to the same
 * ids again in `parseRenderedAcceptanceCriteria`. So a criterion keeps one
 * identity from the reviewed spec file, through the session, through the
 * approved document, into the build brief and the AC matrix. Verified against
 * the real `home` spec: 48 in, 48 out, ids and text identical.
 *
 * This is the whole point. An id that changed anywhere along that chain would
 * silently break the matrix — evidence citing `AC-x` would match no row.
 */

/** Above the 0.7 readiness threshold; an edit in the session still wins. */
const MINED_CONFIDENCE = 0.75;
/**
 * Higher than mined prose: these are not inferred from a heading match, they
 * are the reviewed scenarios themselves, transcribed without interpretation.
 */
const TRANSCRIBED_CONFIDENCE = 0.9;

export interface OpenSpecSeedOptions {
  /**
   * Prototype screen names, when a usable Figma binding exists. Seeds
   * `journey_states`, which OpenSpec CANNOT supply — see `unseeded` below.
   */
  figmaStates?: string[];
  /** Registry platform key of the rebuild repo; seeds `platforms`. */
  platform?: string;
}

export interface OpenSpecSeedResult {
  /** Ready to pass to `start_spec_session` via `seedAnswersForTool`-shaped rows. */
  answers: SessionAnswers;
  /** The criteria, with the ids the session will mint for them. */
  criteria: AcceptanceCriterion[];
  /** Parse output, including `problems` — non-empty means the spec was not fully read. */
  document: OpenSpecDocument;
  /**
   * Mandatory dimensions this seeding did NOT answer, so the caller can say so
   * rather than presenting a quarter-filled session as ready. OpenSpec
   * describes behaviour; it says nothing about users, non-goals, dependencies,
   * risks, rollout, or the API contract, and its requirements are behaviour
   * groups rather than journey states.
   */
  unseeded: CoverageDimension[];
}

/** Mandatory per config/spec-policy.yaml, in that file's order. */
const MANDATORY: readonly CoverageDimension[] = [
  "problem",
  "users",
  "scope",
  "non_goals",
  "acceptance_criteria",
  "platforms",
  "dependencies",
  "risks",
  "rollout",
  "journey_states",
  "api_contract",
];

export function seedSessionFromOpenSpec(
  markdown: string,
  options: OpenSpecSeedOptions = {},
): OpenSpecSeedResult {
  const { criteria, document } = acceptanceCriteriaFromOpenSpec(markdown);
  const answers: SessionAnswers = {};

  if (criteria.length > 0) {
    // One criterion per line, deliberately NOT truncated. The generic seeder
    // caps a mined section at 2000 characters, which is right for prose and
    // catastrophic here: the `home` spec renders to 7,287 characters, so a cap
    // would silently drop roughly two thirds of its criteria and the session
    // would look complete while covering a third of the behaviour.
    answers.acceptance_criteria = {
      answer: criteria.map((criterion) => `- ${criterion.text}`).join("\n"),
      confidence: TRANSCRIBED_CONFIDENCE,
    };
  }

  const purpose = document.purpose.trim();
  if (purpose.length > 0) {
    answers.problem = { answer: purpose, confidence: MINED_CONFIDENCE };
  }

  // The requirement list IS the scope of a domain: what the spec governs is
  // exactly the set of requirements it states. Statements are included where
  // present because "The system SHALL …" is the substance; the heading alone
  // is a label.
  if (document.requirements.length > 0) {
    const lines = document.requirements.map((requirement) =>
      requirement.statement.trim().length > 0
        ? `- ${requirement.name}: ${requirement.statement.trim()}`
        : `- ${requirement.name}`,
    );
    answers.scope = {
      answer: `In scope — ${document.requirements.length} requirements from the ${document.domain || "domain"} OpenSpec:\n${lines.join("\n")}`,
      confidence: MINED_CONFIDENCE,
    };
  }

  if (options.figmaStates && options.figmaStates.length > 0) {
    answers.journey_states = {
      answer: `Screens from the approved prototype: ${options.figmaStates.join(", ")}.`,
      confidence: TRANSCRIBED_CONFIDENCE,
    };
  }
  if (options.platform) {
    answers.platforms = {
      answer: `Rebuild target platform key: ${options.platform}.`,
      confidence: TRANSCRIBED_CONFIDENCE,
    };
  }

  return {
    answers,
    criteria,
    document,
    unseeded: MANDATORY.filter((dimension) => answers[dimension]?.answer === undefined),
  };
}

/**
 * The wire shape `start_spec_session.seedAnswers` accepts, mirroring
 * `seedAnswersForTool` for the OpenSpec source.
 */
export function openSpecSeedAnswersForTool(
  markdown: string,
  options: OpenSpecSeedOptions = {},
): {
  seedAnswers: Array<{ dimension: CoverageDimension; answer: string; confidence: number }>;
  criteria: AcceptanceCriterion[];
  document: OpenSpecDocument;
  unseeded: CoverageDimension[];
} {
  const result = seedSessionFromOpenSpec(markdown, options);
  const seedAnswers = Object.entries(result.answers).flatMap(([dimension, value]) =>
    value?.answer
      ? [
          {
            dimension: dimension as CoverageDimension,
            answer: value.answer,
            confidence: value.confidence ?? MINED_CONFIDENCE,
          },
        ]
      : [],
  );
  return { seedAnswers, criteria: result.criteria, document: result.document, unseeded: result.unseeded };
}

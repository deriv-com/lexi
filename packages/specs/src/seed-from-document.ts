import type { CoverageDimension } from "@lexi/contracts";
import { isCoverageDimension } from "./coverage-dimensions";
import type { SessionAnswers } from "./spec-session";

/**
 * Seeds a spec session from an EXISTING product-spec document — the
 * alternative to pure Slack elicitation when the product is already written up.
 *
 * Pure and deterministic: markdown in, `SessionAnswers` out, in exactly the
 * shape `startSpecSession({seed})` accepts, so the elicitation loop then
 * asks only about the dimensions the document genuinely left uncovered.
 * Nothing here judges quality — a heading that exists with any prose counts
 * as an answer, at a deliberately modest confidence, and the human review
 * gate stays exactly where it was.
 */

/**
 * Heading → dimension mapping. Case-insensitive substring match on h2/h3
 * headings; first match wins per dimension. Deliberately generous with
 * synonyms — a product spec was written for humans, not for this parser —
 * and deliberately NOT a fuzzy model call: seeding must be deterministic.
 */
const HEADING_SYNONYMS: Record<CoverageDimension, string[]> = {
  problem: ["problem", "background", "why", "motivation", "overview", "context"],
  users: ["users", "audience", "personas", "who is this for", "customers"],
  scope: ["scope", "what we are building", "requirements", "features", "functional requirements"],
  non_goals: ["non-goals", "non goals", "out of scope", "not building", "exclusions"],
  acceptance_criteria: ["acceptance criteria", "success criteria", "definition of done", "done means"],
  platforms: ["platforms", "targets", "devices", "web and mobile", "supported platforms"],
  dependencies: ["dependencies", "depends on", "integrations", "external services"],
  risks: ["risks", "concerns", "open questions", "assumptions"],
  rollout: ["rollout", "launch", "release plan", "migration", "go-live"],
  journey_states: ["journey", "user flows", "screens", "states", "flows"],
  api_contract: ["api", "contracts", "endpoints", "data model", "backend"],
  performance_plan: ["performance", "budgets", "vitals", "latency", "load"],
};

interface DocumentSection {
  heading: string;
  body: string;
}

/** h2/h3 sections; text before the first heading is ignored (title prose). */
export function splitSections(markdown: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const lines = markdown.split("\n");
  let current: DocumentSection | null = null;
  for (const line of lines) {
    const heading = line.match(/^#{2,3}\s+(.+)$/);
    if (heading) {
      if (current) sections.push(current);
      current = { heading: heading[1].trim(), body: "" };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) sections.push(current);
  return sections;
}

export interface SeedFromDocumentOptions {
  /**
   * Sanitised prototype screen names, when a Figma binding exists. They seed
   * `journey_states` directly — the prototype IS the journey inventory, and
   * seeding it from the document's prose when the drawn screens are known
   * would prefer the vaguer source.
   */
  figmaStates?: string[];
  /** Registry platform key of the rebuild repo; seeds `platforms`. */
  platform?: string;
}

/**
 * Confidence for document-mined answers: above the readiness threshold
 * (0.7 default) so a covered heading genuinely covers its dimension, but
 * below direct-user-answer territory — an edit in the session still wins.
 */
const MINED_CONFIDENCE = 0.75;

export function seedSessionFromDocument(
  markdown: string,
  options: SeedFromDocumentOptions = {},
): SessionAnswers {
  const answers: SessionAnswers = {};
  const sections = splitSections(markdown);

  for (const [dimension, synonyms] of Object.entries(HEADING_SYNONYMS)) {
    if (!isCoverageDimension(dimension)) continue;
    const section = sections.find((candidate) =>
      synonyms.some((synonym) => candidate.heading.toLowerCase().includes(synonym)),
    );
    const body = section?.body.trim() ?? "";
    if (body.length === 0) continue;
    answers[dimension] = {
      // Capped so one sprawling section does not blow the coverage record;
      // the full document stays linked as evidence on the session.
      answer: body.length > 2000 ? `${body.slice(0, 2000)}\n… (truncated; see source document)` : body,
      confidence: MINED_CONFIDENCE,
    };
  }

  if (options.figmaStates && options.figmaStates.length > 0) {
    answers.journey_states = {
      answer: `Screens from the approved prototype: ${options.figmaStates.join(", ")}.`,
      confidence: 0.9,
    };
  }
  if (options.platform) {
    answers.platforms = {
      answer: `Rebuild target platform key: ${options.platform}.`,
      confidence: 0.9,
    };
  }

  return answers;
}

/**
 * The wire shape `start_spec_session.seedAnswers` accepts (an ARRAY of
 * `{dimension, answer, confidence}` — see `parseAnswers` in the pipeline
 * service), for callers driving the tool boundary rather than the pure API.
 */
export function seedAnswersForTool(
  markdown: string,
  options: SeedFromDocumentOptions = {},
): Array<{ dimension: CoverageDimension; answer: string; confidence: number }> {
  const answers = seedSessionFromDocument(markdown, options);
  return Object.entries(answers).flatMap(([dimension, value]) =>
    value?.answer && isCoverageDimension(dimension)
      ? [{ dimension, answer: value.answer, confidence: value.confidence ?? MINED_CONFIDENCE }]
      : [],
  );
}

import type { AcceptanceCriterion } from "@lexi/contracts";
import { acceptanceCriterionId } from "./task-candidates";

/**
 * OpenSpec parser — reviewed product behaviour as acceptance criteria.
 *
 * `openspec/specs/<domain>/spec.md` holds a product's behaviour as
 * Requirement → Scenario pairs. Each scenario is already exactly what an
 * acceptance criterion is: one WHEN, one THEN, independently testable. This
 * turns them into `AcceptanceCriterion[]` so work is planned
 * from reviewed product behaviour rather than from criteria a model invented.
 *
 * The grammar is fixed and this parser is STRICT about it:
 *
 *   # <domain> Specification
 *   ## Purpose
 *   <prose>
 *   ## Requirements
 *   ### Requirement: <name>
 *   <the "system SHALL" statement>
 *   #### Scenario: <name>
 *   - **WHEN** <condition>
 *   - **THEN** <expectation>
 *
 * Strict rather than lenient because the failure mode of a lenient parser here
 * is silent under-extraction: a scenario it fails to recognise becomes a
 * criterion nobody owns, and `deriveMilestonePlan` would then plan a milestone
 * that provably cannot cover the spec while looking like it does. Anything
 * unrecognised lands in `problems` and the caller decides; nothing is dropped
 * quietly.
 *
 * Ids come from `acceptanceCriterionId`, so the same scenario text always
 * yields the same `AC-xxxxxxxx` and re-parsing an unedited spec is a no-op.
 */

/** One WHEN/THEN pair under a requirement. */
export interface OpenSpecScenario {
  /** Heading text after `#### Scenario:`. */
  readonly name: string;
  readonly when: string;
  readonly then: string;
}

export interface OpenSpecRequirement {
  /** Heading text after `### Requirement:`. */
  readonly name: string;
  /**
   * The prose between the requirement heading and its first scenario — the
   * "The system SHALL …" statement. Empty when the spec omits it.
   */
  readonly statement: string;
  readonly scenarios: readonly OpenSpecScenario[];
}

export interface OpenSpecDocument {
  /**
   * Domain name from the `# <domain> Specification` heading (e.g. "auth").
   * Empty when the heading is missing or malformed.
   */
  readonly domain: string;
  readonly purpose: string;
  readonly requirements: readonly OpenSpecRequirement[];
  /**
   * Everything the parser could not account for, each naming its line number.
   * A non-empty list means the document is NOT fully represented above.
   */
  readonly problems: readonly string[];
}

const TITLE = /^#[ \t]+(\S(?:.*\S)?)[ \t]+Specification[ \t]*$/;
const H2 = /^##[ \t]+(\S(?:.*\S)?)$/;
const REQUIREMENT = /^###[ \t]+Requirement:[ \t]*(\S(?:.*\S)?)$/;
const SCENARIO = /^####[ \t]+Scenario:[ \t]*(\S(?:.*\S)?)$/;
const WHEN = /^-[ \t]+\*\*WHEN\*\*[ \t]+(\S(?:.*\S)?)$/;
const THEN = /^-[ \t]+\*\*THEN\*\*[ \t]+(\S(?:.*\S)?)$/;
/** Any heading, used to detect where a block ends. */
const ANY_HEADING = /^#{1,6}\s/;

interface MutableRequirement {
  name: string;
  statement: string[];
  scenarios: OpenSpecScenario[];
}

export function parseOpenSpec(markdown: string): OpenSpecDocument {
  const lines = markdown.split(/\r?\n/);
  const problems: string[] = [];
  const requirements: MutableRequirement[] = [];
  const purpose: string[] = [];

  let domain = "";
  let section: "none" | "purpose" | "requirements" = "none";
  let current: MutableRequirement | null = null;
  // Scenario being assembled. Held open until its WHEN and THEN are both
  // seen, so a scenario missing either is reported rather than half-kept.
  let scenario: { name: string; line: number; when?: string; then?: string } | null = null;

  const closeScenario = (): void => {
    if (!scenario) return;
    const { name, line, when, then } = scenario;
    scenario = null;
    if (!when || !then) {
      problems.push(
        `line ${line}: scenario "${name}" is missing ${!when && !then ? "both WHEN and THEN" : !when ? "a WHEN" : "a THEN"}`,
      );
      return;
    }
    if (!current) {
      problems.push(`line ${line}: scenario "${name}" appears outside any requirement`);
      return;
    }
    current.scenarios.push({ name, when, then });
  };

  const closeRequirement = (): void => {
    closeScenario();
    if (!current) return;
    if (current.scenarios.length === 0) {
      problems.push(`requirement "${current.name}" has no scenarios, so nothing about it is testable`);
    }
    requirements.push(current);
    current = null;
  };

  for (const [index, raw] of lines.entries()) {
    const line = raw.trimEnd();
    const lineNumber = index + 1;

    const title = TITLE.exec(line);
    if (title?.[1]) {
      domain = title[1].trim();
      continue;
    }

    if (ANY_HEADING.test(line)) {
      const h2 = H2.exec(line);
      if (h2?.[1]) {
        closeRequirement();
        const heading = h2[1].trim().toLowerCase();
        section = heading === "purpose" ? "purpose" : heading === "requirements" ? "requirements" : "none";
        if (section === "none") problems.push(`line ${lineNumber}: unrecognised section "${h2[1].trim()}"`);
        continue;
      }

      const requirement = REQUIREMENT.exec(line);
      if (requirement?.[1]) {
        closeRequirement();
        if (section !== "requirements") {
          problems.push(`line ${lineNumber}: requirement "${requirement[1]}" is outside the Requirements section`);
        }
        current = { name: requirement[1].trim(), statement: [], scenarios: [] };
        continue;
      }

      const next = SCENARIO.exec(line);
      if (next?.[1]) {
        closeScenario();
        scenario = { name: next[1].trim(), line: lineNumber };
        continue;
      }

      // A heading the grammar does not define. Reported rather than ignored:
      // an `### Requirment:` typo would otherwise silently drop scenarios.
      closeScenario();
      problems.push(`line ${lineNumber}: unrecognised heading ${JSON.stringify(line.slice(0, 60))}`);
      continue;
    }

    if (scenario) {
      const when = WHEN.exec(line);
      if (when?.[1]) {
        if (scenario.when) problems.push(`line ${lineNumber}: scenario "${scenario.name}" has a second WHEN`);
        else scenario.when = when[1].trim();
        continue;
      }
      const then = THEN.exec(line);
      if (then?.[1]) {
        if (scenario.then) problems.push(`line ${lineNumber}: scenario "${scenario.name}" has a second THEN`);
        else scenario.then = then[1].trim();
        continue;
      }
      if (line.trim().length > 0) {
        problems.push(
          `line ${lineNumber}: scenario "${scenario.name}" has a body line that is neither WHEN nor THEN: ${JSON.stringify(line.trim().slice(0, 60))}`,
        );
      }
      continue;
    }

    if (line.trim().length === 0) continue;
    if (section === "purpose") purpose.push(line.trim());
    else if (current) current.statement.push(line.trim());
    else if (section === "requirements") {
      problems.push(`line ${lineNumber}: prose in Requirements before any requirement heading`);
    }
  }
  closeRequirement();

  if (!domain) problems.push("no `# <domain> Specification` title heading was found");

  return {
    domain,
    purpose: purpose.join(" "),
    requirements: requirements.map((requirement) => ({
      name: requirement.name,
      statement: requirement.statement.join(" "),
      scenarios: requirement.scenarios,
    })),
    problems,
  };
}

/**
 * One criterion per scenario, in document order.
 *
 * The text is `<domain>/<requirement>: when … , then …`, and the whole of it
 * is the hashed identity, so `id === acceptanceCriterionId(text)` always holds
 * and any consumer can re-derive an id from the text it was given.
 *
 * Both prefixes are load-bearing rather than decoration:
 *
 *   - The **requirement** name, because the text is the whole of what a build
 *     agent sees in its brief, and "then the code is accepted" is not bindable
 *     without knowing which flow it belongs to. Moving a scenario under a
 *     different requirement changes what it means, and so changes its id.
 *   - The **domain**, because the twelve specs genuinely repeat behaviour
 *     across domains. `home` and `portfolio` both specify, word for word,
 *     "Balance visibility: when the user toggles balance visibility on, then
 *     every balance shows its value again". Those are two different
 *     milestones. Without the domain they share one id, and then evidence
 *     proving it in the home milestone silently satisfies portfolio's AC
 *     matrix row — a criterion reported green in a milestone that never
 *     tested it. Verified: 585 scenarios yield 584 distinct ids without the
 *     domain prefix, and 585 with it.
 *
 * Duplicates WITHIN a document still collapse, matching
 * `parseAcceptanceCriteria`: two matrix rows under one address would make
 * "evidence for AC-x" ambiguous. `ordinal` keeps reading order and the drop is
 * observable as a count difference.
 */
export function openSpecAcceptanceCriteria(document: OpenSpecDocument): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  const seen = new Set<string>();
  const prefix = document.domain ? `${document.domain}/` : "";
  for (const requirement of document.requirements) {
    for (const scenario of requirement.scenarios) {
      const text = `${prefix}${requirement.name}: when ${scenario.when}, then ${scenario.then}`;
      const id = acceptanceCriterionId(text);
      if (seen.has(id)) continue;
      seen.add(id);
      criteria.push({ id, text, ordinal: criteria.length + 1 });
    }
  }
  return criteria;
}

/** Convenience: parse and extract in one step. Problems are still surfaced. */
export function acceptanceCriteriaFromOpenSpec(markdown: string): {
  criteria: AcceptanceCriterion[];
  document: OpenSpecDocument;
} {
  const document = parseOpenSpec(markdown);
  return { criteria: openSpecAcceptanceCriteria(document), document };
}

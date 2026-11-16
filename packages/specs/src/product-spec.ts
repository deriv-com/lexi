import type { AcceptanceCriterion, CoverageDimension } from "@lexi/contracts";
import type { SessionAnswers } from "./spec-session";
import { parseAcceptanceCriteria } from "./task-candidates";

/**
 * Seeds a spec session from a PRODUCT SPECIFICATION document — the business
 * spec the product owner writes for a whole app — rather than from an
 * OpenSpec domain file.
 *
 * The shape this parses is `docs/PRODUCT_SPEC.md` in the rebuild repository
 * (acme-labs/web-app-next): one `### D<n> — <Title>` section per
 * product domain, each with the same `####` subsections — Overview, User
 * Journeys (a `| # | Journey |` table), Preconditions, Product Behaviour
 * (bold-led paragraphs, some followed by decision tables), Business Rules
 * (`| ID | Rule |`), States (`| State | Behaviour |`), Validation Rules
 * (`| Field | Rule |`), Error Behaviour (bullets), Platform Differences
 * (`| Behaviour | Rationale |`), Dependencies, Open Questions.
 *
 * Why a third seeder exists: `seedSessionFromDocument` mines free prose by
 * heading synonym and would collapse ~50 precise statements into one 2000-char
 * blob; `seedSessionFromOpenSpec` wants `Scenario:` blocks this document does
 * not have. What the business spec is unusually good at is exactly what the
 * build needs — behaviour, rules, validation and error statements written to
 * be testable — so each of those becomes one acceptance criterion, minted with
 * the same `AC-<8 hex>` id rule every other seeder uses (`parseAcceptanceCriteria`
 * splits per line and hashes the normalised text), so a criterion keeps one
 * identity from this document through the session, the approved spec, the
 * brief and the AC matrix.
 *
 * Struck-through rows and paragraphs (`~~…~~`) are resolved or removed items
 * by the document's own convention; they are dropped, never seeded.
 */

export interface ProductSpecJourney {
  id: string;
  text: string;
}

export interface ProductSpecDomain {
  /** `D1`, `D12` — the key a caller names. */
  id: string;
  /** `Identity & Access`. */
  title: string;
  overview: string;
  journeys: ProductSpecJourney[];
  /** Criterion texts in reading order, before hashing/dedup. */
  criterionTexts: string[];
  platformDifferences: string[];
  dependencies: string;
  openQuestions: string[];
  removed: string[];
}

export interface ProductSpecDocument {
  domains: ProductSpecDomain[];
  /** `Q-6` → question text, from the Part 3 question register when present. */
  questionRegister: Record<string, string>;
  /** `D-16` → decision text, from the decision log when present. */
  decisionLog: Record<string, string>;
  problems: string[];
}

const DOMAIN_HEADING = /^###\s+(D\d+)\s+[—–-]+\s+(.+?)\s*$/;
const SUBSECTION_HEADING = /^####\s+(.+?)\s*$/;
const ANY_HEADING = /^#{1,3}\s/;
const STRUCK = /~~/;

function cleanInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = trimmed.split("|").map((cell) => cell.trim());
  // Leading and trailing pipes produce empty first/last cells.
  const inner = cells.slice(1, cells.length - 1);
  if (inner.length === 0) return null;
  if (inner.every((cell) => /^:?-{2,}:?$/.test(cell))) return null;
  return inner;
}

function isHeaderRow(cells: string[]): boolean {
  const first = cells[0]?.toLowerCase() ?? "";
  return ["#", "id", "state", "field", "behaviour", "determination", "condition", "step", "trigger", "resolution", "exception", "area", "capability"].includes(first)
    && cells.length >= 2
    && /^[a-z #]+$/i.test(cells.slice(1).join(" "));
}

/** Parses the whole document into domains plus the two lookup tables. */
export function parseProductSpec(markdown: string): ProductSpecDocument {
  const lines = markdown.split(/\r?\n/);
  const domains: ProductSpecDomain[] = [];
  const problems: string[] = [];
  const questionRegister: Record<string, string> = {};
  const decisionLog: Record<string, string> = {};

  let current: ProductSpecDomain | null = null;
  let section = "";
  let behaviourTitle = "";

  const flushDomain = (): void => {
    if (current) domains.push(current);
    current = null;
    section = "";
    behaviourTitle = "";
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Lookup tables live outside the domains, in Part 3 / the decision log.
    const registerRow = splitRow(line);
    if (registerRow && registerRow.length >= 3) {
      const idCell = cleanInline(registerRow[0]!.replace(/~~/g, ""));
      const qMatch = idCell.match(/^(Q-\d+[a-z]?)$/i);
      if (qMatch && !current) {
        questionRegister[qMatch[1]!.toUpperCase()] = cleanInline(registerRow[2]!.replace(/~~/g, ""));
      }
    }
    if (registerRow && registerRow.length >= 2 && !current) {
      const idCell = cleanInline(registerRow[0]!.replace(/`/g, ""));
      const dMatch = idCell.match(/^(D-\d+)$/);
      if (dMatch) decisionLog[dMatch[1]!] = cleanInline(registerRow[1]!);
    }

    const domainMatch = line.match(DOMAIN_HEADING);
    if (domainMatch) {
      flushDomain();
      current = {
        id: domainMatch[1]!,
        title: cleanInline(domainMatch[2]!),
        overview: "",
        journeys: [],
        criterionTexts: [],
        platformDifferences: [],
        dependencies: "",
        openQuestions: [],
        removed: [],
      };
      continue;
    }
    if (!current) continue;

    if (ANY_HEADING.test(line)) {
      // A level-1/2/3 heading that is not a domain ends the domain.
      flushDomain();
      continue;
    }
    const sub = line.match(SUBSECTION_HEADING);
    if (sub) {
      section = sub[1]!.toLowerCase();
      behaviourTitle = "";
      continue;
    }
    if (line.trim() === "" || line.trim() === "---") continue;

    const domain: ProductSpecDomain = current;
    const row = splitRow(line);
    // A table separator or a malformed row is table furniture, never prose.
    if (row === null && line.trim().startsWith("|")) continue;

    if (STRUCK.test(line)) {
      // Struck-through means resolved by the decision log. Only the ones the
      // log REMOVED are non-goals; a resolved parity question ("holds on both")
      // is a requirement stated elsewhere, not something left out.
      const struck = cleanInline(line.replace(/~~/g, "").replace(/^\|/, "").replace(/\|$/, "").replace(/\|/g, " — "));
      if (struck && /removed|not product behaviour|not (yet )?offered|deleted/i.test(struck)) {
        domain.removed.push(struck);
      }
      continue;
    }

    switch (true) {
      case section === "overview": {
        domain.overview = `${domain.overview} ${cleanInline(line)}`.trim();
        break;
      }
      case section === "user journeys": {
        if (row && row.length >= 2 && !isHeaderRow(row)) {
          const id = cleanInline(row[0]!);
          if (/^J\d+\.\d+$/i.test(id)) domain.journeys.push({ id, text: cleanInline(row[1]!) });
        }
        break;
      }
      case section === "product behaviour": {
        if (row) {
          if (row.length >= 2 && !isHeaderRow(row)) {
            const prefix = behaviourTitle ? `${behaviourTitle} — ` : "";
            domain.criterionTexts.push(cleanInline(`${prefix}${row[0]}: ${row.slice(1).join(" ")}`));
          }
          break;
        }
        const bold = line.match(/^\*\*(.+?)\*\*\s*(.*)$/);
        if (bold) {
          behaviourTitle = cleanInline(bold[1]!).replace(/[.:]\s*$/, "");
          const rest = cleanInline(bold[2] ?? "");
          if (rest) domain.criterionTexts.push(`${behaviourTitle}: ${rest}`);
          break;
        }
        if (line.startsWith("`D-")) {
          // A decision paragraph: `D-04` Critically, … — a requirement in its own right.
          domain.criterionTexts.push(cleanInline(line.replace(/`/g, "")));
          break;
        }
        // A continuation paragraph under the current bold title.
        const text = cleanInline(line);
        if (text.length > 0) {
          domain.criterionTexts.push(behaviourTitle ? `${behaviourTitle}: ${text}` : text);
        }
        break;
      }
      case section === "business rules": {
        if (row && row.length >= 2 && !isHeaderRow(row)) {
          domain.criterionTexts.push(cleanInline(`${row[0]}: ${row[1]}`));
        }
        break;
      }
      case section === "states": {
        if (row && row.length >= 2 && !isHeaderRow(row)) {
          domain.criterionTexts.push(cleanInline(`State ${row[0]}: ${row[1]}`));
        }
        break;
      }
      case section === "validation rules": {
        if (row && row.length >= 2 && !isHeaderRow(row)) {
          domain.criterionTexts.push(cleanInline(`Validation — ${row[0]}: ${row[1]}`));
        }
        break;
      }
      case section === "error behaviour": {
        const bullet = line.match(/^\s*[-*]\s+(.+)$/);
        if (bullet) domain.criterionTexts.push(`Error behaviour: ${cleanInline(bullet[1]!)}`);
        break;
      }
      case section === "platform differences": {
        if (row && row.length >= 2 && !isHeaderRow(row)) {
          domain.platformDifferences.push(cleanInline(`${row[0]} — ${row[1]}`));
        }
        break;
      }
      case section === "dependencies": {
        domain.dependencies = `${domain.dependencies} ${cleanInline(line)}`.trim();
        break;
      }
      case section === "open questions": {
        for (const q of line.match(/Q-\d+[a-z]?/gi) ?? []) domain.openQuestions.push(q.toUpperCase());
        break;
      }
      default:
        break;
    }
  }
  flushDomain();

  if (domains.length === 0) {
    problems.push("no `### D<n> — <Title>` domain sections found");
  }
  return { domains, questionRegister, decisionLog, problems };
}

/** Above the 0.7 readiness threshold; an edit in the session still wins. */
const MINED_CONFIDENCE = 0.75;
/** These are the reviewed statements themselves, transcribed without interpretation. */
const TRANSCRIBED_CONFIDENCE = 0.9;

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

export interface ProductSpecSeedOptions {
  /** Domain ids to seed from, e.g. ["D1", "D2", "D12"]. Case-insensitive. */
  domains: string[];
  /** Registry platform key of the rebuild repo; seeds `platforms`. */
  platform?: string;
}

export interface ProductSpecSeedResult {
  answers: SessionAnswers;
  criteria: AcceptanceCriterion[];
  document: ProductSpecDocument;
  /** Domain ids the caller asked for that the document does not have. */
  unknownDomains: string[];
  /** Mandatory dimensions this seeding did NOT answer. */
  unseeded: CoverageDimension[];
}

export function seedSessionFromProductSpec(
  markdown: string,
  options: ProductSpecSeedOptions,
): ProductSpecSeedResult {
  const document = parseProductSpec(markdown);
  const wanted = options.domains.map((d) => d.trim().toUpperCase()).filter((d) => d.length > 0);
  const byId = new Map(document.domains.map((domain) => [domain.id.toUpperCase(), domain]));
  const selected = wanted.map((id) => byId.get(id)).filter((d): d is ProductSpecDomain => d !== undefined);
  const unknownDomains = wanted.filter((id) => !byId.has(id));
  const answers: SessionAnswers = {};

  if (selected.length === 0) {
    return { answers, criteria: [], document, unknownDomains, unseeded: [...MANDATORY] };
  }

  // One criterion per line, deliberately NOT truncated: a cap would drop
  // criteria silently and the session would look complete while covering a
  // fraction of the behaviour. Dedup by id keeps two identical statements in
  // two domains from becoming two matrix rows under one address.
  const criteriaText = selected.flatMap((domain) => domain.criterionTexts).map((text) => `- ${text}`).join("\n");
  const criteria = parseAcceptanceCriteria(criteriaText);
  if (criteria.length > 0) {
    answers.acceptance_criteria = {
      answer: criteria.map((criterion) => `- ${criterion.text}`).join("\n"),
      confidence: TRANSCRIBED_CONFIDENCE,
    };
  }

  const problem = selected.map((domain) => `${domain.id} ${domain.title}: ${domain.overview}`).join("\n");
  if (problem.trim().length > 0) answers.problem = { answer: problem, confidence: MINED_CONFIDENCE };

  const journeys = selected.flatMap((domain) => domain.journeys.map((j) => `- ${j.id} ${j.text} (${domain.id})`));
  if (journeys.length > 0) {
    answers.scope = {
      answer: `In scope — ${journeys.length} user journeys across ${selected.map((d) => `${d.id} ${d.title}`).join(", ")} of the business specification:\n${journeys.join("\n")}`,
      confidence: MINED_CONFIDENCE,
    };
    answers.journey_states = {
      answer: `Journeys from the business specification, each with its loading, empty, error and interruption states as the domain's States and Error Behaviour sections describe:\n${journeys.join("\n")}`,
      confidence: MINED_CONFIDENCE,
    };
  }

  const removed = selected.flatMap((domain) => domain.removed);
  if (removed.length > 0) {
    answers.non_goals = {
      answer: `Not built — resolved or removed by the decision log (struck through in the business spec):\n${removed.map((r) => `- ${r}`).join("\n")}`,
      confidence: MINED_CONFIDENCE,
    };
  }

  const platformLines = [
    ...(options.platform ? [`Rebuild target platform key: ${options.platform}.`] : []),
    ...selected.flatMap((domain) => domain.platformDifferences.map((p) => `- ${p}`)),
  ];
  if (platformLines.length > 0) {
    answers.platforms = { answer: platformLines.join("\n"), confidence: options.platform ? TRANSCRIBED_CONFIDENCE : MINED_CONFIDENCE };
  }

  const dependencies = selected.map((domain) => `${domain.id}: ${domain.dependencies}`).filter((d) => !d.endsWith(": "));
  if (dependencies.length > 0) {
    answers.dependencies = { answer: dependencies.join("\n"), confidence: MINED_CONFIDENCE };
  }

  const questions = [...new Set(selected.flatMap((domain) => domain.openQuestions))];
  if (questions.length > 0) {
    answers.risks = {
      answer:
        `Open questions the business spec still carries for these domains — each needs a decision before the behaviour it touches is built:\n` +
        questions.map((q) => `- ${q}: ${document.questionRegister[q] ?? "(see the question register)"}`).join("\n"),
      confidence: MINED_CONFIDENCE,
    };
  }

  return {
    answers,
    criteria,
    document,
    unknownDomains,
    unseeded: MANDATORY.filter((dimension) => answers[dimension]?.answer === undefined),
  };
}

import { createHash } from "node:crypto";
import { z } from "zod";
import type { CoverageDimension, SpecChangedSection, SpecEvidenceLink, SpecNamedOwner } from "@lexi/contracts";
import { ALL_SPEC_STATUSES } from "./spec-state-machine";
import { QUESTION_PROMPTS } from "./question-prompts";
import { parseAcceptanceCriteria } from "./task-candidates";
import type { SpecCoverageRecord } from "./coverage";

/**
 * Spec rendering.
 *
 * Deterministic string assembly with **no** model call. Two reasons beyond
 * cost: a spec that renders differently on a re-run would
 * invalidate the `contentHash` that `SpecDocument` stores per revision (the
 * whole point of which is that replay never depends on GitHub state), and a
 * generated document is a poor audit artefact when nobody can reproduce it.
 *
 * The model elicits the answers. This turns them into the document.
 */

/**
 * Sections that draw their content from a coverage dimension.
 *
 * `id` is `string`, not `CoverageDimension`. It used to be the latter, which
 * held only because every backed section happened to be named after its
 * dimension — an incidental property, not a rule. `id` is the key callers pass
 * overrides under (`renderSpec({ sections: { metrics: "…" } })`), so it is a
 * published name: renaming "metrics" to "performance_plan" to satisfy the type
 * would silently drop any override still using the old key. The dimension link
 * lives in `dimension`, where it is stated rather than inferred from a name.
 */
type CoverageBackedSection = { id: string; heading: string; dimension: CoverageDimension };
/** Sections with no dimension behind them — filled by override or a standing default. */
type StandaloneSection = { id: string; heading: string; dimension?: undefined; fallback?: string };

export type SpecSection = CoverageBackedSection | StandaloneSection;

/**
 * The template, in render order. Every coverage dimension gets a section so no
 * answered question is silently dropped, plus the sections the template
 * requires that no dimension covers.
 *
 * `metrics`, `api_data` and `edge_states` used to be in that second group —
 * headings with neither a dimension nor a fallback, which meant `sectionBody`
 * fell through to `NOT_SPECIFIED` and every spec ever rendered carried three
 * sections reading `_Not yet specified._`. They now name the dimensions added
 * for them. Those dimensions are not mandatory in `config/spec-policy.yaml`,
 * so an unanswered one still renders the same placeholder — the difference is
 * that there is now a question that can fill it.
 */
export const SPEC_SECTIONS: SpecSection[] = [
  { id: "problem", heading: "Problem", dimension: "problem" },
  { id: "users", heading: "Users", dimension: "users" },
  { id: "scope", heading: "V1 scope", dimension: "scope" },
  { id: "non_goals", heading: "Out of scope", dimension: "non_goals" },
  { id: "ux_references", heading: "UX references" },
  {
    id: "accessibility",
    heading: "Accessibility",
    // WCAG 2.2 AA is a non-negotiable floor, so it is the standing default
    // rather than something a spec has to remember to assert.
    fallback: "WCAG 2.2 AA is the floor. Any request to ship below AA escalates rather than being accepted.",
  },
  { id: "acceptance_criteria", heading: "Acceptance criteria", dimension: "acceptance_criteria" },
  { id: "metrics", heading: "Metrics", dimension: "performance_plan" },
  { id: "api_data", heading: "API & data", dimension: "api_contract" },
  { id: "edge_states", heading: "Edge states", dimension: "journey_states" },
  { id: "platforms", heading: "Platforms", dimension: "platforms" },
  { id: "dependencies", heading: "Dependencies", dimension: "dependencies" },
  { id: "risks", heading: "Risks", dimension: "risks" },
  { id: "rollout", heading: "Rollout", dimension: "rollout" },
];

const specFrontmatterSchema = z.object({
  specId: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(ALL_SPEC_STATUSES),
  revision: z.number().int().min(1),
  requestedBy: z.string().min(1),
  /** Product repo the spec governs and where its issue lives — never the bug repo. */
  trackingRepoKey: z.string().min(1),
  codeRepoKey: z.string().min(1).optional(),
  platforms: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  labels: z.array(z.string()).default([]),
  /**
   * Risk tier, from `classifySpecRisk`.
   *
   * **Optional on purpose.** An unclassified spec carries no tier at all rather
   * than a guessed one: the absent value reaches `evaluateSpecGate`, which
   * substitutes `defaultRiskTier` (`high`) and applies the two-person rule.
   * Defaulting it to anything here — least of all `low` — would turn a
   * classification gap into a governance hole, and would do it silently.
   *
   * The enum is the frozen ordering `@lexi/governance` compares positions in.
   * It is validated rather than free-text because a typo would render a tier
   * the gate cannot order, which it would treat as unknown — failing safe, but
   * silently, and the spec would claim a tier it never had.
   */
  riskTier: z.enum(["low", "medium", "high", "critical"]).optional(),
});

export type SpecFrontmatter = z.infer<typeof specFrontmatterSchema>;

export interface SpecTaskBreakdownItem {
  title: string;
  kind: "feature" | "chore" | "bug";
  codeRepoKey?: string;
  notes?: string;
}

/** Revision ledger fields surfaced in the Revision ledger section. */
export interface SpecRevisionLedger {
  changedSections: SpecChangedSection[];
  evidenceLinks: SpecEvidenceLink[];
  owners: SpecNamedOwner[];
  /** `approve` | `request_changes` | `reject`, or the document status when none yet. */
  approvalAction?: string;
  approvedAt?: string;
}

export interface SpecDraftInput {
  frontmatter: SpecFrontmatter;
  coverage: SpecCoverageRecord;
  /** Free-text overrides keyed by section id; beats coverage where present. */
  sections?: Record<string, string>;
  openQuestions?: string[];
  /** Unmet mandatory dimensions when the draft was forced (cap or override). */
  blockingOpenQuestions?: string[];
  tasks?: SpecTaskBreakdownItem[];
  /**
   * Revision ledger. When omitted, the section still renders from frontmatter
   * (version, requester, status, timestamp) with empty changed-sections and
   * evidence — a first revision has nothing to diff and may have no permalink.
   */
  ledger?: SpecRevisionLedger;
  /**
   * Internal: render the content sections without the ledger, so a caller can
   * diff two revisions without the derived section reporting itself as changed.
   */
  omitLedger?: boolean;
}

/**
 * One section as rendered, carried structurally rather than recoverable from
 * `body`.
 *
 * This exists so a revision diff never has to parse the rendered markdown.
 * Section content is free text supplied by a requester: an answer that happens
 * to begin `## Something` is indistinguishable from a template heading once the
 * document is a single string, so a body parser would split a spec in the wrong
 * place based on what a user typed. Emitting the map from the same
 * `sectionBody` calls that build the body means the diff sees exactly what the
 * renderer saw.
 */
export interface RenderedSpecSection {
  /** Stable template id. Survives a heading rewording; the heading does not. */
  id: string;
  heading: string;
  body: string;
}

export interface RenderedSpec {
  body: string;
  contentHash: string;
  /**
   * Every section in render order, including the trailing sections that
   * have no `SPEC_SECTIONS` entry (`open_questions`, `task_breakdown`,
   * `revision_ledger`).
   *
   * Additive: `body` and `contentHash` are unchanged, so nothing that consumes
   * the document is affected by this field existing.
   */
  sections: RenderedSpecSection[];
}

/**
 * Just the persisted half of a rendered spec.
 *
 * Callers that only *publish* a document need `body` and `contentHash`. The
 * section map is persisted separately (`renderedSections` on the document
 * frontmatter JSON) so a later revision can be diffed without parsing `body`.
 * Demanding a full `RenderedSpec` from a publish call site would force it to
 * fabricate sections it does not have.
 */
export type SpecDocumentContent = Pick<RenderedSpec, "body" | "contentHash">;

/**
 * Ids for the two sections `renderSpec` appends after the template.
 *
 * Named constants because the diff refers to them and a typo would silently
 * report a section as added-and-removed rather than changed.
 */
export const SPEC_OPEN_QUESTIONS_SECTION_ID = "open_questions";
export const SPEC_TASK_BREAKDOWN_SECTION_ID = "task_breakdown";
export const SPEC_REVISION_LEDGER_SECTION_ID = "revision_ledger";

export function parseSpecFrontmatter(raw: unknown): SpecFrontmatter {
  const result = specFrontmatterSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid spec frontmatter:\n${issues}`);
  }
  return result.data;
}

const NOT_SPECIFIED = "_Not yet specified._";

/**
 * Renders acceptance criteria as `- **AC-xxxxxxxx** — text`.
 *
 * Falls back to the raw text when nothing parses, rather than emitting an empty
 * list: the requester wrote *something*, and swallowing it because it did not
 * look like a list would lose content the spec is supposed to carry.
 */
function renderAcceptanceCriteria(notes: string): string {
  const criteria = parseAcceptanceCriteria(notes);
  if (criteria.length === 0) return notes.trim();
  return criteria.map((c) => `- **${c.id}** — ${c.text}`).join("\n");
}

function sectionBody(section: SpecSection, input: SpecDraftInput): string {
  const override = input.sections?.[section.id];
  if (override && override.trim().length > 0) return override.trim();

  if (section.dimension) {
    const entry = input.coverage.dimensions[section.dimension];

    if (entry?.state === "EXPLICITLY_DEFERRED") {
      // Deferrals are stated, never omitted: "we decided not to decide" is a
      // decision, and losing it is how it silently becomes an oversight.
      return `_Deferred — ${entry.reason ?? "no reason recorded"}._`;
    }

    if (entry?.notes && entry.notes.trim().length > 0) {
      // Acceptance criteria render as an id-prefixed list rather than as the
      // prose the requester typed. The id has to appear in the document itself:
      // a test or a PR evidence index cites `AC-a1b2c3d4`, and a reviewer has
      // to be able to find that string in the approved spec without re-deriving
      // a hash by hand. Every other dimension stays verbatim.
      if (section.dimension === "acceptance_criteria") {
        return renderAcceptanceCriteria(entry.notes);
      }
      return entry.notes.trim();
    }

    // Nobody answered, so the offered default is what the spec records. It is a
    // considered product position, not a blank — an empty section reads as
    // finished when it is not.
    return `${QUESTION_PROMPTS[section.dimension].defaultAnswer} _(default — not confirmed)_`;
  }

  return section.fallback ?? NOT_SPECIFIED;
}

function renderFrontmatter(frontmatter: SpecFrontmatter): string {
  // Fixed key order, hand-rolled rather than YAML-dumped: the content hash has
  // to be reproducible, and a serializer's key ordering is not part of any
  // contract we control.
  const lines = [
    "---",
    `specId: ${frontmatter.specId}`,
    `title: ${JSON.stringify(frontmatter.title)}`,
    `status: ${frontmatter.status}`,
    `revision: ${frontmatter.revision}`,
    `requestedBy: ${frontmatter.requestedBy}`,
    `trackingRepoKey: ${frontmatter.trackingRepoKey}`,
  ];
  if (frontmatter.codeRepoKey) lines.push(`codeRepoKey: ${frontmatter.codeRepoKey}`);
  // Emitted only when the spec actually has a tier. An unclassified spec shows
  // no `riskTier` line rather than one reading `unknown`, so a reader cannot
  // mistake "nothing matched" for "assessed and found unremarkable".
  if (frontmatter.riskTier) lines.push(`riskTier: ${frontmatter.riskTier}`);
  lines.push(`platforms: [${frontmatter.platforms.join(", ")}]`);
  lines.push(`createdAt: ${frontmatter.createdAt}`);
  lines.push(`labels: [${frontmatter.labels.join(", ")}]`);
  lines.push("---");
  return lines.join("\n");
}

export function renderSpec(input: SpecDraftInput): RenderedSpec {
  const frontmatter = parseSpecFrontmatter(input.frontmatter);
  const lines: string[] = [];
  const sections: RenderedSpecSection[] = [];

  lines.push(renderFrontmatter(frontmatter));
  lines.push("");
  lines.push(`# ${frontmatter.title}`);
  lines.push("");

  // One helper for both the template sections and the two trailing ones, so a
  // section can never reach `body` without also reaching `sections`. Appending
  // to `lines` separately from building the map is how the two drift apart.
  const emit = (id: string, heading: string, body: string): void => {
    sections.push({ id, heading, body });
    lines.push(`## ${heading}`);
    lines.push("");
    lines.push(body);
    lines.push("");
  };

  for (const section of SPEC_SECTIONS) {
    emit(section.id, section.heading, sectionBody(section, input));
  }

  const blocking = input.blockingOpenQuestions ?? [];
  const open = input.openQuestions ?? [];
  let openQuestionsBody: string;
  if (blocking.length === 0 && open.length === 0) {
    openQuestionsBody = "_None._";
  } else {
    // Blocking questions come from a draft forced by the turn cap or a user
    // override. They travel with the spec so "we ran out of turns" can never
    // quietly read as "we agreed".
    openQuestionsBody = [
      ...blocking.map((question) => `- **BLOCKING** ${question}`),
      ...open.map((question) => `- ${question}`),
    ].join("\n");
  }
  emit(SPEC_OPEN_QUESTIONS_SECTION_ID, "Open questions", openQuestionsBody);

  const tasks = input.tasks ?? [];
  let taskBreakdownBody: string;
  if (tasks.length === 0) {
    taskBreakdownBody = "_Not yet broken down._";
  } else {
    const taskLines: string[] = [];
    for (const task of tasks) {
      const meta = [task.kind, task.codeRepoKey].filter(Boolean).join(", ");
      taskLines.push(`- [ ] ${task.title}${meta ? ` _(${meta})_` : ""}`);
      if (task.notes) taskLines.push(`      ${task.notes}`);
    }
    taskBreakdownBody = taskLines.join("\n");
  }
  emit(SPEC_TASK_BREAKDOWN_SECTION_ID, "Task breakdown", taskBreakdownBody);

  if (!input.omitLedger) {
    emit(SPEC_REVISION_LEDGER_SECTION_ID, "Revision ledger", renderRevisionLedger(frontmatter, input.ledger));
  }

  const body = lines.join("\n");
  return {
    body,
    contentHash: createHash("sha256").update(body, "utf8").digest("hex"),
    sections,
  };
}

/**
 * The six revision ledger fields, as a section the reviewer can read without
 * opening the database. Built from structured ledger data — never by parsing
 * the document body.
 */
function renderRevisionLedger(frontmatter: SpecFrontmatter, ledger: SpecRevisionLedger | undefined): string {
  const changed = ledger?.changedSections ?? [];
  const links = ledger?.evidenceLinks ?? [];
  const owners =
    ledger?.owners && ledger.owners.length > 0
      ? ledger.owners
      : [{ role: "requester", name: frontmatter.requestedBy }];
  const approval = ledger?.approvalAction ?? frontmatter.status;
  const timestamp = ledger?.approvedAt ?? frontmatter.createdAt;

  const changedLine =
    changed.length === 0
      ? "_None (first revision)._"
      : changed.map((section) => `${section.heading} (${section.kind})`).join("; ");
  const evidenceLine =
    links.length === 0 ? "_None._" : links.map((link) => (link.label ? `[${link.label}](${link.href})` : link.href)).join("; ");
  const ownerLine = owners.map((owner) => `${owner.name} (${owner.role})`).join("; ");

  return [
    `- **Specification version:** ${frontmatter.revision}`,
    `- **Changed sections:** ${changedLine}`,
    `- **Decision owner:** ${ownerLine}`,
    `- **Evidence:** ${evidenceLine}`,
    `- **Approval or exception:** ${approval}`,
    `- **Timestamp:** ${timestamp}`,
  ].join("\n");
}

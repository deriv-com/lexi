/**
 * Spec revision diff — what changed between two revisions of one spec.
 *
 * A specification is the governed artefact a review is traceable to. Once a
 * spec can be revised, "approved" stops meaning
 * anything unless a reviewer can see what moved: an approval of revision 3 is
 * not an approval of revision 4, and re-reading two full documents to find out
 * whether the acceptance criteria changed is how a reviewer ends up approving
 * something they did not read.
 *
 * DIFFS THE SECTION MAP, NEVER THE RENDERED BODY. `RenderedSpec.sections` comes
 * out of the same `sectionBody` calls that build the document, so this module
 * sees exactly what the renderer saw. Parsing the markdown back apart would be
 * wrong in a way that is easy to miss: section content is free text a requester
 * typed, and an answer beginning `## Rollout` is indistinguishable from a
 * template heading once the document is one string. A body parser would split
 * the spec wherever a user happened to write a Markdown heading.
 *
 * SECTION IDENTITY IS THE TEMPLATE ID, not the heading. Rewording "V1 scope" to
 * "Scope for v1" is a template change, not a spec change, and an
 * identity-by-heading diff would report every section as removed-and-added the
 * first time a heading is edited.
 *
 * Text comparison is exact after trimming. No word-level diff and no similarity
 * score: this answers "did this section change, and what does it say now",
 * which is the question a reviewer's decision turns on. A prettier
 * intra-section diff can be layered on top by whoever renders it.
 */

import {
  type RenderedSpec,
  type RenderedSpecSection,
  type SpecFrontmatter,
} from "./spec-template";

/** What happened to one section between two revisions. */
export type SpecSectionChangeKind = "added" | "removed" | "changed" | "unchanged";

export interface SpecSectionChange {
  id: string;
  /**
   * Heading to display. Taken from the newer side when the section exists
   * there, so a reworded heading shows its current wording rather than the
   * historical one.
   */
  heading: string;
  kind: SpecSectionChangeKind;
  /** Absent when `kind` is `added`. */
  before?: string;
  /** Absent when `kind` is `removed`. */
  after?: string;
}

/** One frontmatter field that moved. Values are stringified for display. */
export interface SpecFieldChange {
  field: string;
  before?: string;
  after?: string;
}

export interface SpecRevisionSide {
  rendered: RenderedSpec;
  /**
   * Optional. Supplied when the caller has it, so the diff can report a status
   * or risk-tier move alongside the prose. Omitted rather than re-parsed out of
   * `rendered.body` — same reason the sections are not parsed.
   */
  frontmatter?: SpecFrontmatter;
}

export interface SpecRevisionDiff {
  /** Every section, in the newer revision's order, with removals appended. */
  sections: SpecSectionChange[];
  /** Frontmatter fields that moved. Empty when no frontmatter was supplied. */
  frontmatter: SpecFieldChange[];
  /**
   * True when any section or frontmatter field moved.
   *
   * Derived from the section and field lists rather than from `contentHash`,
   * because the two answer different questions: a hash difference tells you the
   * document is not byte-identical, which is also true when only the template
   * changed. This tells you the spec's *content* moved.
   */
  hasChanges: boolean;
  /** Convenience: the subset a reviewer actually has to read. */
  changed: SpecSectionChange[];
}

function byId(sections: readonly RenderedSpecSection[]): Map<string, RenderedSpecSection> {
  const map = new Map<string, RenderedSpecSection>();
  for (const section of sections) {
    // A duplicate id is a template bug. Dropping the later one made a wrong
    // diff look like a clean one. Fail instead of picking a winner.
    if (map.has(section.id)) {
      throw new Error(
        `Duplicate spec section id "${section.id}". The template must name each section once; ` +
          `a silent first-wins map would hide the bug as a wrong diff.`,
      );
    }
    map.set(section.id, section);
  }
  return map;
}

/**
 * Frontmatter fields worth diffing, and how to render each.
 *
 * An explicit list rather than a key walk: `createdAt` never changes
 * meaningfully between revisions of the same spec, and `revision` itself moving
 * from 3 to 4 is the diff's premise rather than a finding. Reporting either as
 * a change would bury the fields a reviewer cares about under noise.
 */
const FRONTMATTER_FIELDS: ReadonlyArray<{
  field: string;
  read: (frontmatter: Partial<SpecFrontmatter> | undefined) => string | undefined;
}> = [
  { field: "title", read: (f) => f?.title },
  { field: "status", read: (f) => f?.status },
  { field: "riskTier", read: (f) => f?.riskTier },
  { field: "trackingRepoKey", read: (f) => f?.trackingRepoKey },
  { field: "codeRepoKey", read: (f) => f?.codeRepoKey },
  { field: "platforms", read: (f) => f?.platforms?.join(", ") },
  { field: "labels", read: (f) => f?.labels?.join(", ") },
];

function diffFrontmatter(
  before: SpecFrontmatter | undefined,
  after: SpecFrontmatter | undefined,
): SpecFieldChange[] {
  // One side omitted is not "nothing moved". Title lives in YAML, not in
  // SPEC_SECTIONS; swallowing a one-sided compare hid status/title moves.
  if (!before && !after) return [];
  const changes: SpecFieldChange[] = [];
  for (const { field, read } of FRONTMATTER_FIELDS) {
    const beforeValue = read(before);
    const afterValue = read(after);
    if (beforeValue === afterValue) continue;
    changes.push({ field, before: beforeValue, after: afterValue });
  }
  return changes;
}

/**
 * Compare two rendered revisions of the same spec.
 *
 * Order follows the NEWER revision, because that is the document a reviewer is
 * reading; sections that exist only in the older one are appended as `removed`
 * rather than interleaved at their historical position, which would put a
 * deleted section in the middle of a document it is no longer part of.
 */
export function diffSpecRevisions(
  before: SpecRevisionSide,
  after: SpecRevisionSide,
): SpecRevisionDiff {
  const beforeSections = byId(before.rendered.sections);
  const afterSections = byId(after.rendered.sections);
  const sections: SpecSectionChange[] = [];

  for (const section of after.rendered.sections) {
    const previous = beforeSections.get(section.id);
    if (!previous) {
      sections.push({
        id: section.id,
        heading: section.heading,
        kind: "added",
        after: section.body,
      });
      continue;
    }
    const changed = previous.body.trim() !== section.body.trim();
    sections.push({
      id: section.id,
      heading: section.heading,
      kind: changed ? "changed" : "unchanged",
      before: previous.body,
      after: section.body,
    });
  }

  for (const section of before.rendered.sections) {
    if (afterSections.has(section.id)) continue;
    sections.push({
      id: section.id,
      heading: section.heading,
      kind: "removed",
      before: section.body,
    });
  }

  const frontmatter = diffFrontmatter(before.frontmatter, after.frontmatter);
  const changed = sections.filter((section) => section.kind !== "unchanged");

  return {
    sections,
    frontmatter,
    changed,
    hasChanges: changed.length > 0 || frontmatter.length > 0,
  };
}

/**
 * One-line-per-change summary, for Slack and the audit trail.
 *
 * Deliberately does not include section bodies. A spec section can be
 * arbitrarily long, and a summary that pastes two revisions of the acceptance
 * criteria into a Slack message is not a summary. Callers that want the text
 * read it off `SpecSectionChange`.
 */
export function summariseSpecDiff(diff: SpecRevisionDiff): string {
  if (!diff.hasChanges) return "No content changes between these revisions.";

  const lines: string[] = [];
  for (const field of diff.frontmatter) {
    lines.push(`- ${field.field}: ${field.before ?? "(unset)"} → ${field.after ?? "(unset)"}`);
  }
  for (const section of diff.changed) {
    const label =
      section.kind === "added" ? "added" : section.kind === "removed" ? "removed" : "changed";
    lines.push(`- ${section.heading}: ${label}`);
  }
  return lines.join("\n");
}

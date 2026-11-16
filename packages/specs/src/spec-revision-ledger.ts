/**
 * Spec revision ledger — the six fields a revision must persist for review.
 *
 * Three of the six are already on the document (`revision`, `SpecApproval.action`,
 * `createdAt` / `approvedAt`). This module is the other three: what moved,
 * who owns the open questions, and the evidence that justified the change —
 * as real http(s) URLs, never the literal string `"thread"`.
 *
 * DIFFS THE SECTION MAP. `ledgerFromDiff` reads `SpecRevisionDiff` from
 * `diffSpecRevisions`, which compares `renderSpec`'s section list. Parsing the
 * rendered markdown to recover headings would split a spec wherever a
 * requester happened to type `##`.
 */

import type { SpecChangedSection, SpecEvidenceKind, SpecEvidenceLink, SpecNamedOwner } from "@lexi/contracts";
import type { SpecRevisionDiff, SpecSectionChange } from "./spec-diff";

export type { SpecChangedSection, SpecEvidenceKind, SpecEvidenceLink, SpecNamedOwner };

/**
 * Same id as `SPEC_REVISION_LEDGER_SECTION_ID` in spec-template. Duplicated
 * rather than imported: this module must not import the renderer, and the
 * renderer imports the ledger helpers.
 */
export const SPEC_REVISION_LEDGER_SECTION_ID = "revision_ledger";

/** The ledger section is derived from the revision; it is never itself a finding. */
const LEDGER_SECTION_ID = SPEC_REVISION_LEDGER_SECTION_ID;

const EVIDENCE_KINDS: ReadonlySet<SpecEvidenceKind> = new Set([
  "slack_thread",
  "github_issue",
  "github_pr",
  "figma",
  "other",
]);

/**
 * True only for `http://` or `https://` URLs.
 *
 * The string `"thread"` fails this, as does every other non-URL token that used
 * to be written in place of a permalink. A Slack thread is evidence when it
 * has a permalink; without one the link is omitted rather than faked.
 */
export function isSpecEvidenceHref(href: string): boolean {
  if (typeof href !== "string" || href.length === 0 || href.length > 2048) return false;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function inferSpecEvidenceKind(href: string): SpecEvidenceKind {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return "other";
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === "slack.com" || host.endsWith(".slack.com")) return "slack_thread";
  if (host === "figma.com" || host.endsWith(".figma.com")) return "figma";
  if (host === "github.com" || host === "www.github.com") {
    if (/\/pull\/\d+/.test(path)) return "github_pr";
    if (/\/issues\/\d+/.test(path)) return "github_issue";
  }
  return "other";
}

/**
 * Accept a single candidate link, or `null` if it is not an http(s) URL.
 *
 * `"thread"` returns `null`. Callers that have no permalink omit the link
 * rather than inventing one.
 */
export function parseSpecEvidenceLink(raw: unknown): SpecEvidenceLink | null {
  if (typeof raw === "string") {
    if (!isSpecEvidenceHref(raw)) return null;
    return { href: raw, kind: inferSpecEvidenceKind(raw) };
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const href = typeof record.href === "string" ? record.href : "";
  if (!isSpecEvidenceHref(href)) return null;

  const label = typeof record.label === "string" && record.label.trim().length > 0 ? record.label.trim() : undefined;
  const kindRaw = typeof record.kind === "string" ? record.kind : undefined;
  const kind: SpecEvidenceKind =
    kindRaw && EVIDENCE_KINDS.has(kindRaw as SpecEvidenceKind)
      ? (kindRaw as SpecEvidenceKind)
      : inferSpecEvidenceKind(href);

  return {
    href,
    ...(label !== undefined ? { label } : {}),
    kind,
  };
}

/** Drop any entry whose href is not an http(s) URL. `"thread"` is dropped. */
export function sanitizeEvidenceLinks(raw: readonly unknown[]): SpecEvidenceLink[] {
  const seen = new Set<string>();
  const links: SpecEvidenceLink[] = [];
  for (const entry of raw) {
    const parsed = parseSpecEvidenceLink(entry);
    if (!parsed || seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    links.push(parsed);
  }
  return links;
}

export function parseNamedOwner(raw: unknown): SpecNamedOwner | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!role || !name) return null;
  const slackUserId =
    typeof record.slackUserId === "string" && record.slackUserId.trim().length > 0
      ? record.slackUserId.trim()
      : undefined;
  return { role, name, ...(slackUserId !== undefined ? { slackUserId } : {}) };
}

export function sanitizeNamedOwners(raw: readonly unknown[]): SpecNamedOwner[] {
  const owners: SpecNamedOwner[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const parsed = parseNamedOwner(entry);
    if (!parsed) continue;
    const key = `${parsed.role}:${parsed.slackUserId ?? parsed.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    owners.push(parsed);
  }
  return owners;
}

export function requesterOwner(requestedBy: string): SpecNamedOwner {
  return { role: "requester", name: requestedBy, slackUserId: requestedBy };
}

export function approverOwner(approvedBy: string): SpecNamedOwner {
  return { role: "approver", name: approvedBy, slackUserId: approvedBy };
}

/**
 * Map a revision diff onto the persisted changed-sections list.
 *
 * Excludes `unchanged` (a reviewer does not need to re-read those) and the
 * ledger section itself (it is derived from this list, so treating it as a
 * finding would make every revision report itself as changed).
 */
export function ledgerFromDiff(diff: SpecRevisionDiff): SpecChangedSection[] {
  return diff.changed
    .filter((section) => section.kind !== "unchanged" && section.id !== LEDGER_SECTION_ID)
    .map(toChangedSection);
}

function toChangedSection(section: SpecSectionChange): SpecChangedSection {
  return {
    id: section.id,
    heading: section.heading,
    kind: section.kind === "removed" || section.kind === "added" ? section.kind : "changed",
  };
}

export function parseChangedSections(raw: unknown): SpecChangedSection[] {
  if (!Array.isArray(raw)) return [];
  const sections: SpecChangedSection[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const heading = typeof record.heading === "string" ? record.heading : "";
    const kind = record.kind;
    if (!id || !heading) continue;
    if (kind !== "added" && kind !== "removed" && kind !== "changed") continue;
    sections.push({ id, heading, kind });
  }
  return sections;
}

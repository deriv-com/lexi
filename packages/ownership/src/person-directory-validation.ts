/**
 * Placeholder-data validation: `PersonDirectory` validation fails startup on
 * placeholder data, so a deployment cannot run on example owners by accident.
 *
 * `config/ownership.yaml` shipped with every component owned by
 * `alice`, annotated TEMP, from the first commit. That is worse than
 * having no ownership data: a real person's login on six components means
 * every unrouted bug is assigned, notified, and escalated to somebody who is
 * not responsible for it, and nothing about the running system looks wrong.
 *
 * So this fails **loudly, at boot**, rather than warning into a log nobody
 * reads. An empty directory is explicitly *not* a failure — "the sync has not
 * run yet" is a different and recoverable condition from "the data is wrong",
 * and conflating them would make the check impossible to enable.
 */

import type { OwnershipConfig } from "./ownership-config.schema";
import type { PersonDirectoryEntry } from "./person-directory";

/** Thrown at startup when ownership data is placeholder rather than real. */
export class PlaceholderDataError extends Error {
  constructor(
    message: string,
    readonly offendingLogins: string[],
  ) {
    super(message);
    this.name = "PlaceholderDataError";
  }
}

/**
 * Known-bad logins built in to every deployment. Empty: a placeholder that is a
 * real-looking login cannot be caught by a pattern, so a deployment that ships
 * one names it through `additionalPlaceholders`.
 */
export const DEFAULT_PLACEHOLDER_LOGINS: readonly string[] = Object.freeze([]);

/**
 * Generic placeholder shapes, so the next placeholder does not need a code
 * change to be caught. Matched against the whole login, case-insensitively.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = Object.freeze([
  /^todo$/i,
  /^tbd$/i,
  /^n\/?a$/i,
  /^none$/i,
  /^unassigned$/i,
  /^change[-_]?me$/i,
  /placeholder/i,
  /^example([-_].*)?$/i,
  /^your[-_]/i,
  /^<.*>$/,
]);

export interface PlaceholderCheckOptions {
  /** Extra logins to treat as placeholders, on top of the defaults. */
  additionalPlaceholders?: readonly string[];
  /** Named in the error so the operator knows which file to fix. */
  sourceDescription?: string;
}

export function isPlaceholderLogin(login: string, options: PlaceholderCheckOptions = {}): boolean {
  const normalized = login.trim().toLowerCase();
  if (!normalized) return false;

  const known = [...DEFAULT_PLACEHOLDER_LOGINS, ...(options.additionalPlaceholders ?? [])];
  if (known.some((candidate) => candidate.trim().toLowerCase() === normalized)) return true;

  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function fail(logins: string[], options: PlaceholderCheckOptions): never {
  const where = options.sourceDescription ? ` in ${options.sourceDescription}` : "";
  throw new PlaceholderDataError(
    `Placeholder ownership data${where}: ${logins.join(", ")}. ` +
      `Placeholder owners route real issues to people who are not responsible for them, silently. ` +
      `Replace them with derived ownership (CODEOWNERS + Slack directory) or an explicit entry in ` +
      `config/people-overrides.yaml before enabling this deployment.`,
    logins,
  );
}

/**
 * Throws when any directory entry carries a placeholder login. Call at
 * startup, after the directory sync, before anything can assign or escalate.
 */
export function assertNoPlaceholderPeople(
  entries: readonly PersonDirectoryEntry[],
  options: PlaceholderCheckOptions = {},
): void {
  const offending = entries
    .map((entry) => entry.githubLogin)
    .filter((login) => isPlaceholderLogin(login, options));
  if (offending.length > 0) fail([...new Set(offending)], options);
}

/**
 * Same check against `config/ownership.yaml` itself, so the file is rejected
 * before it ever reaches the directory. Covers every place the file can name
 * a person, across both shapes it accepts:
 *
 *   - `modules[].web.pic` / `modules[].mobile.pic` — the two-dimensional
 *     shape's people-in-charge, i.e. who gets assigned and paged;
 *   - `platforms[].teamLead` — rung 2 of the escalation ladder;
 *   - `components[].owners` — the legacy one-dimensional shape.
 *
 * A placeholder that moved from `owners` into `pic` is the same failure in a
 * new costume; a guard that only knew the old key would pass the new file
 * silently, which is worse than not having run at all.
 *
 * Every field is optional in the schema, so each is read defensively: the
 * guard must never itself throw a TypeError, because a crashing boot check
 * reads as "something is broken" rather than "ownership data is fake", and
 * the two get fixed by different people.
 *
 * A component with *no* owners still passes: owners are supplied by
 * `PersonDirectory`, and an empty list is the honest representation of
 * "derived elsewhere". A module PIC, by contrast, is mandatory — the schema
 * requires it — so there is no empty case to allow.
 */
export function assertOwnershipConfigHasNoPlaceholders(
  config: OwnershipConfig,
  options: PlaceholderCheckOptions = {},
): void {
  const offending: string[] = [];
  const check = (login: string | undefined | null): void => {
    if (login && isPlaceholderLogin(login, options)) offending.push(login);
  };

  for (const module of Object.values(config.modules ?? {})) {
    check(module?.web?.pic);
    check(module?.mobile?.pic);
  }

  for (const platform of Object.values(config.platforms ?? {})) {
    check(platform?.teamLead);
  }

  for (const component of Object.values(config.components ?? {})) {
    for (const owner of component?.owners ?? []) check(owner);
  }

  if (offending.length > 0) {
    fail([...new Set(offending)], { sourceDescription: "config/ownership.yaml", ...options });
  }
}

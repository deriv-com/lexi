/**
 * Person directory.
 *
 * One model reconciling four partial sources that each held a fragment of
 * "who owns this":
 *
 *   1. **CODEOWNERS** per registered code repo — GitHub logins, no Slack.
 *   2. **The Slack directory** — Slack IDs and display names, no GitHub.
 *   3. **`config/ownership.yaml`** — components to teams, with a placeholder
 *      owner list that has been wrong since the first commit.
 *   4. **`config/quick-fix-owners.yaml`** — the one file with *real* Slack
 *      IDs, keyed by feature category rather than by person.
 *
 * The merge is deterministic and pure: same inputs, same output, no clock, no
 * network, no model call. Persistence to the `PersonDirectory` table
 * and fetching CODEOWNERS/Slack live at the integration layer — this module
 * only decides what the rows should be.
 *
 * **Identity is never invented.** GitHub logins and Slack IDs share no field,
 * so the two are linked only by an explicit override or by a Slack entry that
 * already carries a `githubLogin`. A Slack user who cannot be linked is
 * *reported* in `unmatchedSlackIds`, not guessed at. Guessing is how a
 * directory quietly starts routing work to the wrong person — the same class
 * of failure as a placeholder owner in config.
 */

import { codeownersLogins, parseCodeowners } from "./codeowners";
import type { PeopleOverridesConfig } from "./people-overrides.schema";
import type { QuickFixOwnersConfig } from "./quick-fix-owners-config.schema";

export interface PersonDirectoryEntry {
  /** Primary key. Matches `PersonDirectory.githubLogin` in the frozen schema. */
  githubLogin: string;
  slackId: string | null;
  displayName: string | null;
  /** Deferred — retained so managers need no migration later. */
  managerGithub: string | null;
  teams: string[];
  /** "override" when any field came from people-overrides.yaml. */
  source: "derived" | "override";
}

/** CODEOWNERS content for one registered repo, plus the team that owns it. */
export interface CodeownersSource {
  repoKey: string;
  team: string;
  content: string;
}

/** A Slack directory member, as returned by `users.list`. */
export interface SlackDirectoryEntry {
  slackId: string;
  displayName?: string | null;
  /** Present only when the workspace profile records it; usually absent. */
  githubLogin?: string | null;
}

/** Accepts hand-built overrides too, where zod defaults have not been applied. */
export type PersonOverrideInput = Omit<PeopleOverridesConfig["people"][number], "teams"> & { teams?: string[] };

export interface BuildPersonDirectoryInput {
  codeowners: CodeownersSource[];
  slackDirectory: SlackDirectoryEntry[];
  overrides: { people: PersonOverrideInput[] };
  /** Optional: folds `config/quick-fix-owners.yaml` categories in as teams. */
  quickFixOwners?: QuickFixOwnersConfig;
}

export interface BuildPersonDirectoryResult {
  entries: PersonDirectoryEntry[];
  /** Slack members that could not be linked to a GitHub login. Not an error. */
  unmatchedSlackIds: string[];
}

interface MutableEntry extends Omit<PersonDirectoryEntry, "teams"> {
  teams: Set<string>;
}

function addTeam(entry: MutableEntry, team: string | undefined | null): void {
  const normalized = team?.trim();
  if (normalized) entry.teams.add(normalized);
}

export function buildPersonDirectory(input: BuildPersonDirectoryInput): BuildPersonDirectoryResult {
  // Keyed by lowercased login so `Alice` and `alice` are one person, while the
  // first-seen casing is what gets persisted.
  const byLogin = new Map<string, MutableEntry>();

  const upsert = (githubLogin: string): MutableEntry => {
    const key = githubLogin.toLowerCase();
    const existing = byLogin.get(key);
    if (existing) return existing;
    const created: MutableEntry = {
      githubLogin,
      slackId: null,
      displayName: null,
      managerGithub: null,
      teams: new Set<string>(),
      source: "derived",
    };
    byLogin.set(key, created);
    return created;
  };

  // 1. CODEOWNERS — the derived backbone.
  for (const source of input.codeowners) {
    for (const login of codeownersLogins(parseCodeowners(source.content))) {
      addTeam(upsert(login), source.team);
    }
  }

  // 2. Slack directory — only where it already carries a GitHub login.
  const unmatchedSlackIds: string[] = [];
  for (const member of input.slackDirectory) {
    if (!member.githubLogin) {
      unmatchedSlackIds.push(member.slackId);
      continue;
    }
    const entry = upsert(member.githubLogin);
    entry.slackId ??= member.slackId;
    entry.displayName ??= member.displayName ?? null;
  }

  // 3. Overrides — authoritative, applied last so they win every conflict.
  for (const override of input.overrides.people) {
    const entry = upsert(override.githubLogin);
    if (override.slackId) entry.slackId = override.slackId;
    if (override.displayName) entry.displayName = override.displayName;
    if (override.managerGithub) entry.managerGithub = override.managerGithub;
    // `teams` is defaulted by the zod schema, but this function also accepts
    // hand-built inputs (tests, and any caller that assembles overrides in
    // code) — an absent list must mean "no extra teams", not a crash.
    for (const team of override.teams ?? []) addTeam(entry, team);
    entry.source = "override";
  }

  // 4. quick-fix-owners.yaml — category ownership, matched on Slack ID. This
  //    is the reconciliation step: the file stays the operator-facing way to
  //    say "who reviews portfolio fixes", but the fact lands on the person.
  if (input.quickFixOwners) {
    const bySlackId = new Map<string, MutableEntry>();
    for (const entry of byLogin.values()) {
      if (entry.slackId) bySlackId.set(entry.slackId, entry);
    }
    for (const [category, owners] of Object.entries(input.quickFixOwners.categories)) {
      for (const slackId of [owners.web, owners.mobile]) {
        const entry = slackId ? bySlackId.get(slackId) : undefined;
        if (entry) addTeam(entry, category);
      }
    }
  }

  // Sorted by login so a re-sync produces byte-identical output and diffs stay
  // reviewable. Teams sorted for the same reason.
  const entries = [...byLogin.values()]
    .map((entry) => ({ ...entry, teams: [...entry.teams].sort() }))
    .sort((a, b) => a.githubLogin.localeCompare(b.githubLogin));

  return { entries, unmatchedSlackIds };
}

/** Individual logins in the directory that belong to `team` (case-insensitive). */
export function directoryOwnersForTeam(directory: readonly PersonDirectoryEntry[], team: string): string[] {
  const normalized = team.trim().toLowerCase();
  return directory
    .filter((entry) => entry.teams.some((t) => t.trim().toLowerCase() === normalized))
    .map((entry) => entry.githubLogin);
}

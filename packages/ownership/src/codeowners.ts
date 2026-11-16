/**
 * CODEOWNERS parsing. Ownership data is **derived**: CODEOWNERS plus the Slack
 * directory, not a hand-kept list.
 *
 * Deterministic text parsing, zero model calls: ownership resolution must give
 * the same answer every time, so it is plain code.
 *
 * The format is GitHub's: one rule per line, `<path-pattern> <owner>...`,
 * `#` starts a comment, owners are `@login` or `@org/team`. Only individuals
 * become `PersonDirectory` rows — see `codeownersLogins`.
 */

export interface CodeownersRule {
  pattern: string;
  /** Owners with the leading `@` stripped. May include `org/team` handles. */
  owners: string[];
}

/** True for an `org/team` handle rather than an individual login. */
export function isTeamHandle(owner: string): boolean {
  return owner.includes("/");
}

export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    // A `#` anywhere starts a comment, including at end of line — an inline
    // comment's words would otherwise be parsed as additional owners.
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    const [pattern, ...ownerTokens] = line.split(/\s+/);
    if (!pattern) continue;

    const owners = ownerTokens
      .filter((token) => token.startsWith("@"))
      .map((token) => token.slice(1))
      .filter(Boolean);

    rules.push({ pattern, owners });
  }

  return rules;
}

/**
 * Distinct individual logins across every rule, in first-seen order.
 *
 * Team handles (`@acme/web-site`) are deliberately excluded: writing one
 * into `PersonDirectory.githubLogin` would create a "person" with no Slack
 * identity, who cannot be DM'd, assigned, or escalated to — which is exactly
 * the failure mode the placeholder validation exists to prevent.
 */
export function codeownersLogins(rules: CodeownersRule[]): string[] {
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const rule of rules) {
    for (const owner of rule.owners) {
      if (isTeamHandle(owner)) continue;
      const normalized = owner.trim();
      if (!normalized || seen.has(normalized.toLowerCase())) continue;
      seen.add(normalized.toLowerCase());
      logins.push(normalized);
    }
  }
  return logins;
}

/** Team handles across every rule, in first-seen order. */
export function codeownersTeamHandles(rules: CodeownersRule[]): string[] {
  const seen = new Set<string>();
  const teams: string[] = [];
  for (const rule of rules) {
    for (const owner of rule.owners) {
      if (!isTeamHandle(owner)) continue;
      if (seen.has(owner.toLowerCase())) continue;
      seen.add(owner.toLowerCase());
      teams.push(owner);
    }
  }
  return teams;
}

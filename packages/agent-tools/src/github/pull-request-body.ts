/**
 * Fits a pull request body to the repository's own PR template.
 *
 * Repositories often gate PRs on their template (a check that the body carries
 * a `## Description` heading, say). A body written without the template fails
 * that check, and nothing on the agent's side could repair it afterwards.
 *
 * Rules, in order:
 *   1. No template, or a body that already carries the template's first
 *      heading: return the body untouched. Never reformat a body that already
 *      fits; its author may know the repository better than this function.
 *   2. Otherwise put the body into the template's FIRST section and keep every
 *      later section intact.
 *
 * HTML comments are left in place: they are the template's instructions to a
 * human reader.
 */
export function composePullRequestBody(body: string, template: string | null): string {
  const trimmedBody = body.trim();
  if (!template) return trimmedBody;

  const headings = [...template.matchAll(/^##\s+.+$/gm)];
  if (headings.length === 0) return trimmedBody;

  const firstHeading = headings[0][0].trim();
  if (trimmedBody.includes(firstHeading)) return trimmedBody;
  if (!trimmedBody) return template.trim();

  const firstStart = headings[0].index ?? 0;
  const secondStart = headings.length > 1 ? (headings[1].index ?? template.length) : template.length;

  const preamble = template.slice(0, firstStart);
  const rest = template.slice(secondStart);

  return `${preamble}${firstHeading}\n\n${trimmedBody}\n\n${rest}`.trim();
}

/** Where GitHub looks for a single PR template, in its own order of preference. */
export const PULL_REQUEST_TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

/** True when `body` already closes `#issueNumber` with a closing keyword. */
export function hasClosingReference(body: string, issueNumber: number): boolean {
  const pattern = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, "i");
  return pattern.test(body);
}

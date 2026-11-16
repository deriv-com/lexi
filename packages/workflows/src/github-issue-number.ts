/**
 * GitHub's per-repo issue number (`Issue.githubNumber`) is Prisma `Int` /
 * Postgres INT4. The platform-wide issue *id* is a BigInt on purpose
 * (`githubIssueId`) because it already overflowed 32 bits.
 *
 * GitHub Actions run ids are a different namespace and are routinely larger
 * than INT4 (e.g. `32334312816`). Feeding one into `prisma.issue.findFirst`
 * throws `ConversionError` and, if that throw escapes the Slack handler,
 * the user sees a generic routing failure — even
 * when the turn already succeeded.
 */

export const GITHUB_ISSUE_NUMBER_MAX = 2_147_483_647;

export function isGithubIssueNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= GITHUB_ISSUE_NUMBER_MAX;
}

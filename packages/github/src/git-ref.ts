/**
 * Shared validation for Git refs this provider is willing to write.
 *
 * Branch names and SHAs reach GitHub's git API as path segments. An
 * unvalidated string can smuggle `..`, `refs/`, or the other ref namespace into
 * `heads/{name}` and write a ref the caller did not name. These helpers are the
 * allowlist; callers must run them before any network call, not after a 422.
 *
 * There is no tag-name validator: Lexi writes no tags since `moveTag` (behind
 * `push_release_tag`) was removed.
 */

/** Nested-submodule gitlinks the nested-stack procedure is allowed to move. */
export const ALLOWED_SUBMODULE_PATHS = ["packages", "design_system"] as const;
export type AllowedSubmodulePath = (typeof ALLOWED_SUBMODULE_PATHS)[number];

const BRANCH_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,243}[A-Za-z0-9])?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export function isAllowedSubmodulePath(path: string): path is AllowedSubmodulePath {
  return (ALLOWED_SUBMODULE_PATHS as readonly string[]).includes(path);
}

export function assertSafeBranchName(name: string, label: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  if (trimmed.includes("..") || trimmed.includes("//") || trimmed.includes("@{")) {
    throw new Error(`${label} "${trimmed}" is not a legal git ref name.`);
  }
  if (trimmed.endsWith(".lock") || trimmed.endsWith("/") || trimmed.startsWith("/")) {
    throw new Error(`${label} "${trimmed}" is not a legal git ref name.`);
  }
  if (!BRANCH_NAME.test(trimmed)) {
    throw new Error(
      `${label} "${trimmed}" is not a legal branch name. Use letters, digits, underscore, dot, slash, and hyphen only.`,
    );
  }
  return trimmed;
}

export function assertFullSha(sha: string, label: string): string {
  const trimmed = sha.trim().toLowerCase();
  if (!FULL_SHA.test(trimmed)) {
    throw new Error(`${label} must be a full 40-character commit sha, not "${sha}".`);
  }
  return trimmed;
}

export function assertSubmodulePath(path: string): AllowedSubmodulePath {
  const trimmed = path.trim();
  if (!isAllowedSubmodulePath(trimmed)) {
    throw new Error(
      `submodule path "${trimmed}" is not allowed. Only ${ALLOWED_SUBMODULE_PATHS.join(" and ")} may be moved.`,
    );
  }
  return trimmed;
}

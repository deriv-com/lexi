export interface LinkedRef {
  owner: string;
  repo: string;
  number: number;
  type: "issues" | "pull";
}

const GITHUB_LINK_PATTERN = /github\.com\/([a-z0-9][a-z0-9-]*)\/([a-z0-9._-]+)\/(issues|pull)\/(\d+)/gi;

/**
 * Pure, I/O-free scan for `github.com/{owner}/{repo}/(issues|pull)/{number}`
 * links anywhere in a blob of text (issue body, comment body, markdown link
 * targets, etc.). Case-insensitive on the `issues`/`pull` segment, and
 * de-duplicates identical refs so callers don't re-fetch the same
 * issue/PR twice.
 */
export function extractLinkedRefs(text: string): LinkedRef[] {
  const seen = new Set<string>();
  const refs: LinkedRef[] = [];

  for (const match of text.matchAll(GITHUB_LINK_PATTERN)) {
    const [, owner, repo, rawType, rawNumber] = match;
    const type = rawType.toLowerCase() as "issues" | "pull";
    const ref: LinkedRef = {
      owner,
      repo,
      number: Number(rawNumber),
      type,
    };
    const key = `${ref.owner}/${ref.repo}/${ref.type}/${ref.number}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push(ref);
  }

  return refs;
}

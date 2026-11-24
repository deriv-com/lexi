export interface IssueSearchCandidate {
  number: number;
  title: string;
  body?: string | null;
  labels: string[];
  state: string;
  url: string;
  closedReason?: string | null;
}

export interface LexicalMatch {
  issueNumber: number;
  url: string;
  similarity: number;
  matchedSignals: string[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9/:._-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function extractSignatures(text: string): string[] {
  const signatures: string[] = [];
  const errorPatterns = text.match(/(?<![A-Za-z])[A-Z][A-Za-z]+Error|(?<![A-Z0-9_])ERR_[A-Z0-9_]+|failed to fetch/gi) ?? [];
  const urls = text.match(/https?:\/\/[^\s)]+/g) ?? [];
  const routes = text.match(/\/[a-z0-9][a-z0-9/_-]*/gi) ?? [];
  signatures.push(...errorPatterns, ...urls.slice(0, 5), ...routes.slice(0, 10));
  return signatures.map((s) => s.toLowerCase());
}

/**
 * Pass 1 — lexical duplicate search over candidate issues.
 */
export function lexicalDuplicateSearch(
  title: string,
  steps: string[],
  actualBehaviour: string,
  candidates: IssueSearchCandidate[],
  minSimilarity = 0.35,
): LexicalMatch[] {
  const queryTokens = new Set([
    ...tokenize(title),
    ...tokenize(steps.join(" ")),
    ...tokenize(actualBehaviour),
    ...extractSignatures(`${title} ${steps.join(" ")} ${actualBehaviour}`),
  ]);

  const results: LexicalMatch[] = [];

  for (const candidate of candidates) {
    const candidateText = `${candidate.title} ${candidate.body ?? ""} ${candidate.labels.join(" ")}`;
    const candidateTokens = new Set([
      ...tokenize(candidateText),
      ...extractSignatures(candidateText),
    ]);

    let overlap = 0;
    const matchedSignals: string[] = [];
    for (const token of queryTokens) {
      if (candidateTokens.has(token)) {
        overlap += 1;
        if (token.length >= 4) {
          matchedSignals.push(token);
        }
      }
    }

    const union = new Set([...queryTokens, ...candidateTokens]).size;
    const similarity = union > 0 ? overlap / union : 0;

    if (similarity >= minSimilarity) {
      results.push({
        issueNumber: candidate.number,
        url: candidate.url,
        similarity,
        matchedSignals: matchedSignals.slice(0, 8),
      });
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity);
}

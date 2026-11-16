import type { IssueSearchCandidate } from "./lexical-search";
import { lexicalDuplicateSearch } from "./lexical-search";
import type { DuplicateAdjudicationProvider, DuplicatePolicyConfig, DuplicatePolicyOutcome } from "./adjudication";
import { evaluateDuplicatePolicy, HeuristicDuplicateAdjudicator } from "./adjudication";
import type { VectorIndexProvider } from "./semantic-index";

export interface DuplicateEngineConfig extends DuplicatePolicyConfig {
  lexicalMinSimilarity: number;
  semanticTopK: number;
}

export interface ClosedIssueContext {
  state: string;
  closedReason?: string | null;
  labels: string[];
}

/**
 * Closed-issue duplicate rules per Lexi spec.
 */
export function resolveClosedIssueAction(
  canonical: ClosedIssueContext,
): "REOPEN" | "REGRESSION" | "RESOLVE_CANONICAL" | "NONE" {
  if (canonical.state !== "closed") {
    return "NONE";
  }

  const labels = canonical.labels.map((l) => l.toLowerCase());
  if (labels.includes("duplicate")) {
    return "RESOLVE_CANONICAL";
  }
  if (labels.includes("lexi:not-observed") || canonical.closedReason === "not_planned") {
    return "REOPEN";
  }
  if (labels.includes("fixed") || canonical.closedReason === "completed") {
    return "REGRESSION";
  }
  return "NONE";
}

export class DuplicateEngine {
  constructor(
    private readonly vectorIndex: VectorIndexProvider,
    private readonly adjudicator: DuplicateAdjudicationProvider = new HeuristicDuplicateAdjudicator(),
    private readonly config: DuplicateEngineConfig,
  ) {}

  async evaluate(
    title: string,
    steps: string[],
    actualBehaviour: string,
    candidates: IssueSearchCandidate[],
  ): Promise<DuplicatePolicyOutcome> {
    const lexical = lexicalDuplicateSearch(
      title,
      steps,
      actualBehaviour,
      candidates,
      this.config.lexicalMinSimilarity,
    );

    const queryText = `${title}\n${steps.join("\n")}\n${actualBehaviour}`;
    const semanticHealth = await this.vectorIndex.health();
    const semantic = await this.vectorIndex.search(queryText, this.config.semanticTopK);

    const merged = new Map<number, { similarity: number; title: string; body?: string | null }>();

    for (const m of lexical) {
      const candidate = candidates.find((c) => c.number === m.issueNumber);
      merged.set(m.issueNumber, {
        similarity: m.similarity,
        title: candidate?.title ?? "",
        body: candidate?.body,
      });
    }

    for (const m of semantic) {
      const existing = merged.get(m.issueNumber);
      const candidate = candidates.find((c) => c.number === m.issueNumber);
      const blended = existing
        ? Math.max(existing.similarity, m.similarity)
        : m.similarity;
      merged.set(m.issueNumber, {
        similarity: blended,
        title: candidate?.title ?? existing?.title ?? "",
        body: candidate?.body ?? existing?.body,
      });
    }

    const ranked = [...merged.entries()]
      .map(([issueNumber, data]) => ({ issueNumber, ...data }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.config.semanticTopK);

    const decisions = await this.adjudicator.adjudicate(queryText, ranked);
    const outcome = evaluateDuplicatePolicy(decisions, this.config);

    // Never let a degraded semantic tier look like a completed one.
    if (semanticHealth.status !== "operational") {
      return {
        ...outcome,
        semanticHealth,
        explanation: `${outcome.explanation} Semantic search did not contribute: ${semanticHealth.detail}`,
      };
    }

    return { ...outcome, semanticHealth };
  }
}

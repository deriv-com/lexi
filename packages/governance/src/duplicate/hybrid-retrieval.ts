/**
 * Hybrid retrieval pipeline: structured → lexical → semantic.
 *
 * Combines three retrieval strategies for maximum duplicate coverage:
 * 1. Structured: exact match on error signatures, URLs, component names
 * 2. Lexical: token-overlap Jaccard similarity (existing lexicalDuplicateSearch)
 * 3. Semantic: pgvector cosine similarity on embeddings
 *
 * Results are merged with reciprocal rank fusion, then passed to adjudication.
 * Retrieval operates over the COMPLETE synchronized corpus — no corpus size cap.
 * Only candidate display and LLM context are bounded.
 */

import type { IssueSearchCandidate, LexicalMatch } from "./lexical-search";
import { lexicalDuplicateSearch } from "./lexical-search";
import type { VectorIndexProvider, SemanticMatch, SemanticIndexHealth } from "./semantic-index";
import { computeCandidateSimilarity } from "./candidate-similarity";

export interface StructuredMatch {
  issueNumber: number;
  matchType: "error_signature" | "url" | "component" | "route" | "exact_title";
  matchedValue: string;
  confidence: number;
}

export interface HybridRetrievalResult {
  /** Merged and ranked candidates ready for adjudication. */
  candidates: HybridCandidate[];
  /** Raw results from each tier for audit. */
  tierResults: {
    structured: StructuredMatch[];
    lexical: LexicalMatch[];
    semantic: SemanticMatch[];
  };
  /** Semantic tier health for transparency. */
  semanticHealth: SemanticIndexHealth;
}

export interface HybridCandidate {
  issueNumber: number;
  /**
   * Reciprocal-rank-fusion score. This is an ORDERING key, not a likeness
   * measure: it encodes each tier's RANK, so its maximum is `1/61 ≈ 0.0164`
   * even for a byte-identical issue. Never threshold it — use
   * {@link HybridCandidate.calibratedSimilarity} for that.
   */
  score: number;
  /**
   * Calibrated 0-1 likeness derived from {@link HybridCandidate.tierScores}.
   * This is the value that is comparable against the duplicate thresholds.
   * Always computed, so the scoring can be observed before it is authoritative.
   */
  calibratedSimilarity: number;
  /** Which tiers contributed. */
  sources: Array<"structured" | "lexical" | "semantic">;
  /** Per-tier scores for transparency. */
  tierScores: {
    structured?: number;
    lexical?: number;
    semantic?: number;
  };
  /** Matched signals for explanation. */
  matchedSignals: string[];
}

export interface HybridRetrievalConfig {
  /** Minimum lexical similarity (default 0.3). */
  lexicalMinSimilarity: number;
  /** Maximum candidates from semantic tier (default 20). */
  semanticTopK: number;
  /** Maximum final candidates to return (default 10). */
  maxCandidates: number;
  /** Weights for reciprocal rank fusion. */
  fusionWeights: {
    structured: number;
    lexical: number;
    semantic: number;
  };
}

const DEFAULT_CONFIG: HybridRetrievalConfig = {
  lexicalMinSimilarity: 0.3,
  semanticTopK: 20,
  maxCandidates: 10,
  fusionWeights: {
    structured: 0.35,
    lexical: 0.30,
    semantic: 0.35,
  },
};

/**
 * Execute hybrid retrieval across all three tiers.
 */
export async function hybridRetrieval(
  title: string,
  steps: string[],
  actualBehaviour: string,
  corpusCandidates: IssueSearchCandidate[],
  vectorIndex: VectorIndexProvider,
  config: Partial<HybridRetrievalConfig> = {},
): Promise<HybridRetrievalResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Tier 1: Structured matching (exact signatures)
  const structured = structuredSearch(title, steps, actualBehaviour, corpusCandidates);

  // Tier 2: Lexical (token overlap)
  const lexical = lexicalDuplicateSearch(
    title,
    steps,
    actualBehaviour,
    corpusCandidates,
    cfg.lexicalMinSimilarity,
  );

  // Tier 3: Semantic (vector similarity)
  const queryText = `${title}\n${steps.join("\n")}\n${actualBehaviour}`;
  const semanticHealth = await vectorIndex.health();
  const semantic = await vectorIndex.search(queryText, cfg.semanticTopK);

  // Merge with reciprocal rank fusion for ORDERING, then attach a calibrated
  // 0-1 similarity computed from the per-tier scores for THRESHOLDING.
  const candidates = reciprocalRankFusion(
    structured,
    lexical,
    semantic,
    cfg.fusionWeights,
    cfg.maxCandidates,
    // A tier that could not run is not evidence against a candidate.
    semanticHealth.status === "operational",
  );

  return {
    candidates,
    tierResults: { structured, lexical, semantic },
    semanticHealth,
  };
}

/**
 * Tier 1: Structured search — exact matching on error signatures,
 * URLs, routes, and component names.
 */
function structuredSearch(
  title: string,
  steps: string[],
  actualBehaviour: string,
  candidates: IssueSearchCandidate[],
): StructuredMatch[] {
  const queryText = `${title} ${steps.join(" ")} ${actualBehaviour}`;
  const matches: StructuredMatch[] = [];

  // Extract structured signals from query
  const querySignatures = extractSignatures(queryText);
  const queryUrls = extractUrls(queryText);
  const queryRoutes = extractRoutes(queryText);

  for (const candidate of candidates) {
    const candidateText = `${candidate.title} ${candidate.body ?? ""}`;

    // Exact error signature match (high confidence)
    for (const sig of querySignatures) {
      if (candidateText.toLowerCase().includes(sig.toLowerCase()) && sig.length >= 8) {
        matches.push({
          issueNumber: candidate.number,
          matchType: "error_signature",
          matchedValue: sig,
          confidence: 0.9,
        });
      }
    }

    // URL match
    for (const url of queryUrls) {
      if (candidateText.includes(url)) {
        matches.push({
          issueNumber: candidate.number,
          matchType: "url",
          matchedValue: url,
          confidence: 0.7,
        });
      }
    }

    // Route match
    for (const route of queryRoutes) {
      if (candidateText.toLowerCase().includes(route.toLowerCase()) && route.length >= 5) {
        matches.push({
          issueNumber: candidate.number,
          matchType: "route",
          matchedValue: route,
          confidence: 0.6,
        });
      }
    }

    // Exact title match (case-insensitive)
    if (candidate.title.toLowerCase() === title.toLowerCase() && title.length >= 10) {
      matches.push({
        issueNumber: candidate.number,
        matchType: "exact_title",
        matchedValue: candidate.title,
        confidence: 0.95,
      });
    }
  }

  return matches;
}

/**
 * Reciprocal Rank Fusion: merge results from multiple tiers into a single
 * ranked list using RRF scoring.
 */
function reciprocalRankFusion(
  structured: StructuredMatch[],
  lexical: LexicalMatch[],
  semantic: SemanticMatch[],
  weights: { structured: number; lexical: number; semantic: number },
  maxCandidates: number,
  semanticAvailable: boolean,
): HybridCandidate[] {
  const k = 60; // RRF constant
  const scores = new Map<number, {
    score: number;
    sources: Set<"structured" | "lexical" | "semantic">;
    tierScores: { structured?: number; lexical?: number; semantic?: number };
    matchedSignals: string[];
  }>();

  // Structured tier: group by issueNumber, take best confidence
  const structuredByIssue = new Map<number, { confidence: number; signals: string[] }>();
  for (const m of structured) {
    const existing = structuredByIssue.get(m.issueNumber);
    if (!existing || m.confidence > existing.confidence) {
      structuredByIssue.set(m.issueNumber, {
        confidence: m.confidence,
        signals: [...(existing?.signals ?? []), m.matchedValue],
      });
    } else {
      existing.signals.push(m.matchedValue);
    }
  }

  // RRF for structured (sorted by confidence)
  const structuredRanked = [...structuredByIssue.entries()]
    .sort((a, b) => b[1].confidence - a[1].confidence);
  for (let rank = 0; rank < structuredRanked.length; rank++) {
    const [issueNumber, data] = structuredRanked[rank];
    const rrfScore = weights.structured / (k + rank + 1);
    const entry = getOrCreate(scores, issueNumber);
    entry.score += rrfScore;
    entry.sources.add("structured");
    entry.tierScores.structured = data.confidence;
    entry.matchedSignals.push(...data.signals.slice(0, 4));
  }

  // RRF for lexical (already sorted by similarity)
  for (let rank = 0; rank < lexical.length; rank++) {
    const m = lexical[rank];
    const rrfScore = weights.lexical / (k + rank + 1);
    const entry = getOrCreate(scores, m.issueNumber);
    entry.score += rrfScore;
    entry.sources.add("lexical");
    entry.tierScores.lexical = m.similarity;
    entry.matchedSignals.push(...m.matchedSignals.slice(0, 4));
  }

  // RRF for semantic (already sorted by similarity)
  for (let rank = 0; rank < semantic.length; rank++) {
    const m = semantic[rank];
    const rrfScore = weights.semantic / (k + rank + 1);
    const entry = getOrCreate(scores, m.issueNumber);
    entry.score += rrfScore;
    entry.sources.add("semantic");
    entry.tierScores.semantic = m.similarity;
  }

  // Convert to array, sort by RRF score, limit. Ordering stays RRF's job;
  // `calibratedSimilarity` is what downstream thresholds compare against.
  return [...scores.entries()]
    .map(([issueNumber, data]) => ({
      issueNumber,
      score: data.score,
      calibratedSimilarity: computeCandidateSimilarity(data.tierScores, { semanticAvailable }),
      sources: [...data.sources] as Array<"structured" | "lexical" | "semantic">,
      tierScores: data.tierScores,
      matchedSignals: [...new Set(data.matchedSignals)].slice(0, 8),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);
}

function getOrCreate(
  map: Map<number, { score: number; sources: Set<"structured" | "lexical" | "semantic">; tierScores: { structured?: number; lexical?: number; semantic?: number }; matchedSignals: string[] }>,
  key: number,
) {
  let entry = map.get(key);
  if (!entry) {
    entry = { score: 0, sources: new Set(), tierScores: {}, matchedSignals: [] };
    map.set(key, entry);
  }
  return entry;
}

// --- Signal extraction helpers ---

function extractSignatures(text: string): string[] {
  const signatures: string[] = [];
  const errorPatterns = text.match(/(?<![A-Za-z])[A-Z][A-Za-z]+Error|(?<![A-Z0-9_])ERR_[A-Z0-9_]+|ENOENT|EACCES|ETIMEDOUT/g) ?? [];
  const httpErrors = text.match(/(?:status|HTTP|response)\s*(?:code\s*)?(\d{3})/gi) ?? [];
  signatures.push(...errorPatterns, ...httpErrors);
  return [...new Set(signatures)];
}

function extractUrls(text: string): string[] {
  const urls = text.match(/https?:\/\/[^\s)>"]+/g) ?? [];
  return [...new Set(urls)].slice(0, 10);
}

function extractRoutes(text: string): string[] {
  const routes = text.match(/\/[a-z][a-z0-9/_-]{3,}/gi) ?? [];
  return [...new Set(routes)].slice(0, 10);
}

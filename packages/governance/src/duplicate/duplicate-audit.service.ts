/**
 * Duplicate decision audit trail — records every evaluation for replay.
 *
 * Every duplicate detection run is persisted with:
 * - Input (query text, candidates considered)
 * - Retrieval results (which tiers contributed)
 * - Adjudication decisions (per-candidate verdicts)
 * - Final outcome (action taken)
 * - Semantic health at time of evaluation
 *
 * This enables:
 * - Replay of past decisions for review
 * - Debugging of false positives/negatives
 * - Confidence calibration over time
 * - Audit compliance
 */

import type { DuplicateOrchestratorOutcome } from "./duplicate-orchestrator";
import type { DuplicateCandidateDecision } from "./adjudication";

export interface DuplicateAuditRecord {
  id: string;
  /** Source issue being evaluated. */
  sourceIssueNumber: number;
  sourceRepository: string;
  /** Query text used for retrieval. */
  queryText: string;
  /** Final pipeline action. */
  action: string;
  /** Canonical issue number if duplicate found. */
  canonicalIssueNumber?: number;
  /** Top confidence score. */
  topConfidence?: number;
  /** Adjudication decisions. */
  decisions: DuplicateCandidateDecision[];
  /** Retrieval tier contributions. */
  retrievalSummary: {
    structuredCount: number;
    lexicalCount: number;
    semanticCount: number;
    mergedCandidateCount: number;
  };
  /** Semantic health at evaluation time. */
  semanticStatus: string;
  semanticDetail: string;
  /** Adjudication method used. */
  adjudicationMethod: string;
  /** Whether consolidation was performed. */
  consolidationPerformed: boolean;
  /** Whether human adjudication was requested. */
  humanAdjudicationRequested: boolean;
  /** Run ID for correlation. */
  runId?: string;
  /** Timestamp. */
  createdAt: Date;
}

export interface DuplicateAuditPersistence {
  recordAudit(record: DuplicateAuditRecord): Promise<string>;
  getAuditBySource(issueNumber: number, repository: string): Promise<DuplicateAuditRecord[]>;
  getAuditById(id: string): Promise<DuplicateAuditRecord | null>;
}

/**
 * Records duplicate evaluations for replay and audit.
 */
export class DuplicateAuditService {
  constructor(private readonly persistence: DuplicateAuditPersistence) {}

  /**
   * Record a duplicate evaluation outcome.
   */
  async record(
    sourceIssueNumber: number,
    sourceRepository: string,
    queryText: string,
    outcome: DuplicateOrchestratorOutcome,
    options?: { runId?: string; adjudicationMethod?: string },
  ): Promise<string> {
    const record: DuplicateAuditRecord = {
      id: crypto.randomUUID(),
      sourceIssueNumber,
      sourceRepository,
      queryText,
      action: outcome.action,
      canonicalIssueNumber: outcome.canonicalIssueNumber,
      topConfidence: outcome.topConfidence,
      decisions: outcome.decisions,
      retrievalSummary: {
        structuredCount: outcome.retrievalResult.tierResults.structured.length,
        lexicalCount: outcome.retrievalResult.tierResults.lexical.length,
        semanticCount: outcome.retrievalResult.tierResults.semantic.length,
        mergedCandidateCount: outcome.retrievalResult.candidates.length,
      },
      semanticStatus: outcome.semanticHealth.status,
      semanticDetail: outcome.semanticHealth.detail,
      adjudicationMethod: options?.adjudicationMethod ?? "heuristic",
      consolidationPerformed: outcome.consolidation?.consolidated ?? false,
      humanAdjudicationRequested: outcome.humanAdjudicationId !== undefined,
      runId: options?.runId,
      createdAt: new Date(),
    };

    return this.persistence.recordAudit(record);
  }

  /**
   * Retrieve audit history for a source issue.
   */
  async getHistory(
    issueNumber: number,
    repository: string,
  ): Promise<DuplicateAuditRecord[]> {
    return this.persistence.getAuditBySource(issueNumber, repository);
  }

  /**
   * Retrieve a specific audit record by ID.
   */
  async getById(id: string): Promise<DuplicateAuditRecord | null> {
    return this.persistence.getAuditById(id);
  }
}

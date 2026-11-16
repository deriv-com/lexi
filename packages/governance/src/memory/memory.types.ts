/**
 * Lexi Memory Engine — Type definitions
 *
 * Memory is divided into:
 * - Permanent: engineering graph, user profiles, capability graph
 * - Semi-permanent (30d expiry): watched issues, recent conversations, open plans
 * - Temporary (24h expiry): thread context, pending clarifications
 * - Never stored: secrets, PII, prompt injections
 */

// ============================================================================
// Engineering Knowledge Graph
// ============================================================================

export interface EngineeringKnowledgeNode {
  id: string;
  type: "issue" | "pull_request" | "commit" | "release" | "component" | "engineer" | "scenario" | "regression";
  externalId?: string; // GitHub number, commit SHA, release tag
  repo?: string;
  title?: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface EngineeringKnowledgeEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationship:
    | "fixed_by"        // issue → PR
    | "introduced_by"   // regression → commit/release
    | "related_to"      // issue → issue
    | "duplicate_of"    // issue → canonical issue
    | "regressed_from"  // issue → previous fix
    | "owned_by"        // component → engineer
    | "released_in"     // PR → release
    | "changed_by"      // component → PR
    | "blocked_by"      // issue → issue
    | "verified_by"     // fix → reproduction run
    | "caused_by";      // issue → commit
  confidence: number; // 0.0 - 1.0
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/** Query result: the full chain for an issue */
export interface IssueKnowledgeChain {
  issueNumber: number;
  repo: string;
  fixes: Array<{
    prNumber: number;
    prRepo: string;
    mergedAt?: string;
    author?: string;
  }>;
  regressions: Array<{
    fromIssueNumber: number;
    originalFixPR?: number;
    regressionRelease?: string;
  }>;
  relatedIssues: Array<{
    number: number;
    relationship: string;
    title?: string;
  }>;
  releases: Array<{
    version: string;
    releasedAt?: string;
    includesFix: boolean;
  }>;
  owners: Array<{
    login: string;
    role: string; // "fixer" | "reporter" | "reviewer" | "assigned"
  }>;
  /** Natural language summary of engineering history */
  historySummary?: string;
}

// ============================================================================
// User Preferences
// ============================================================================

export type DetailLevel = "brief" | "standard" | "detailed";
export type UserRole = "engineer" | "qa" | "lead" | "manager" | "admin" | "viewer";

export interface UserProfile {
  slackId: string;
  githubLogin?: string;
  displayName?: string;
  /** Preferred response detail level */
  detailLevel: DetailLevel;
  /** IANA timezone (e.g. "Asia/Kolkata") */
  timezone?: string;
  /** Role for authorization and UX adaptation */
  role: UserRole;
  /** Teams the user belongs to */
  teams: string[];
  /** Repositories the user watches */
  watchedRepos: string[];
  /** Issue numbers the user is tracking */
  watchedIssues: number[];
  /** Components the user owns */
  ownedComponents: string[];
  /** Custom preferences (extensible) */
  preferences: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Issue Memory
// ============================================================================

export interface IssueMemoryEntry {
  id: string;
  issueNumber: number;
  repo: string;
  /** Rolling summary of all investigations, not raw event log */
  summary: string;
  /** Key facts extracted from history */
  facts: IssueFact[];
  /** Regression chain (if this issue is a regression) */
  regressionChain?: RegressionChainEntry[];
  /** Previous investigation outcomes */
  investigations: InvestigationSummary[];
  /** Number of times this issue was processed/reproduced */
  processCount: number;
  /** Last time memory was updated */
  lastUpdatedAt: Date;
  /** When this memory expires (null = permanent) */
  expiresAt?: Date;
}

export interface IssueFact {
  key: string; // e.g. "root_cause", "fix_author", "regression_of"
  value: string;
  confidence: number;
  source: string; // "bre", "claude", "human", "github"
  observedAt: Date;
}

export interface RegressionChainEntry {
  issueNumber: number;
  fixPR?: number;
  fixRelease?: string;
  regressedInRelease?: string;
  engineer?: string;
  date?: Date;
}

export interface InvestigationSummary {
  /** When this investigation happened */
  timestamp: Date;
  /** What triggered it */
  trigger: "initial" | "reprocess" | "retest" | "manual";
  /** Outcome */
  outcome: string;
  /** Evidence quality at the time */
  evidenceQuality?: string;
  /** Whether reproduction was attempted */
  reproductionAttempted: boolean;
  /** Reproduction result if attempted */
  reproductionResult?: string;
  /** Fix assessment at that point */
  fixStatus?: string;
  /** Key insight from this investigation */
  insight?: string;
}

// ============================================================================
// Memory Retrieval
// ============================================================================

export type MemoryPriority = "critical" | "high" | "medium" | "low";

export interface MemoryContext {
  /** Engineering knowledge relevant to the current query */
  engineeringKnowledge?: IssueKnowledgeChain;
  /** User preferences for the current actor */
  userProfile?: UserProfile;
  /** Issue memory for the issue being discussed */
  issueMemory?: IssueMemoryEntry;
  /** Related issue memories (similar bugs, regressions) */
  relatedMemories?: IssueMemoryEntry[];
  /**
   * Human corrections Lexi should not repeat. Advisory facts only —
   * never a permission and never an instruction to follow blindly.
   */
  lessons?: Array<{
    issueNumber: number;
    category: string;
    originalDecision: string;
    correction: string;
    reason?: string;
  }>;
  /** Priority of this context (affects token budget) */
  priority: MemoryPriority;
  /** How many tokens this context would consume (approximate) */
  estimatedTokens: number;
}

export interface MemoryQuery {
  /** The user making the query */
  actorSlackId?: string;
  /** Issue being discussed (if any) */
  issueNumber?: number;
  /** Repository context */
  repo?: string;
  /** Component being discussed */
  component?: string;
  /** Free-text query for semantic retrieval (future) */
  query?: string;
  /** Maximum tokens to allocate for memory context */
  maxTokenBudget?: number;
}

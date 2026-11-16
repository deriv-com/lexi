export {
  bugSubmissionSchema,
  intakeResponseSchema,
  type BugSubmission,
  type IntakeResponse,
} from "./intake/bug-submission.schema";
export { validateCompleteness } from "./intake/completeness-validator";
export { evaluateValidityPolicy, type ValidityRecommendation } from "./intake/validity-policy";
export { IntakeService, type IntakeServiceOptions } from "./intake/intake-service";
export { normalizeIssueBody } from "./intake/issue-body-normalizer";
export {
  evaluateCompleteness,
  evaluateIntakeDecision,
  type IntakeDecisionDependencies,
  type IntakeDecisionConfig,
} from "./intake/intake-decision.service";
export type {
  IntakeDisposition,
  IntakeDecisionResult,
  IntakeDraft,
  IntakeDraftFields,
  IntakeDraftStatus,
} from "./intake/intake-decision.types";
export { createsNewIssue, requiresHumanInput } from "./intake/intake-decision.types";

export { lexicalDuplicateSearch, type IssueSearchCandidate } from "./duplicate/lexical-search";
export {
  InMemoryVectorIndexProvider,
  DisabledVectorIndexProvider,
  type VectorIndexProvider,
  type VectorDocument,
  type SemanticMatch,
  type SemanticIndexStatus,
  type SemanticIndexHealth,
} from "./duplicate/semantic-index";
export {
  DuplicateEngine,
  resolveClosedIssueAction,
  type DuplicateEngineConfig,
} from "./duplicate/duplicate-engine";
export {
  ClosedIssueResolver,
  followCanonicalChain,
  raisePriorityLabels,
  type ClosedIssueResolution,
  type ClosedIssueResolverOptions,
  type CanonicalChainResult,
} from "./duplicate/closed-issue-resolver";
export {
  evaluateDuplicatePolicy,
  HeuristicDuplicateAdjudicator,
  type DuplicateAdjudicationProvider,
  type DuplicateCandidateDecision,
  type DuplicateVerdict,
  type DuplicatePolicyOutcome,
} from "./duplicate/adjudication";

// Persistent semantic duplicate detection
export {
  OpenAiEmbeddingProvider,
  DisabledEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderConfig,
  type EmbeddingResult,
  type EmbeddingBatchResult,
  type EmbeddingProviderHealth,
} from "./duplicate/embedding-provider";
export {
  PgVectorIndexProvider,
  computeTextHash,
  type PgVectorIndexProviderConfig,
  type PgVectorQueryExecutor,
} from "./duplicate/pgvector-index-provider";
export { DegradedVectorIndexProvider } from "./duplicate/degraded-vector-provider";
export {
  LlmDuplicateAdjudicator,
  type LlmAdjudicationConfig,
} from "./duplicate/llm-adjudication-provider";
export {
  ConsolidationService,
  extractUniqueInformation,
  buildConsolidationComment,
  type ConsolidationInput,
  type ConsolidationResult,
  type ConsolidationGitHubAdapter,
  type ConsolidationPersistence,
} from "./duplicate/consolidation.service";
export {
  HumanAdjudicationService,
  formatAdjudicationSlackMessage,
  type HumanAdjudicationInput,
  type HumanAdjudicationRecord,
  type HumanAdjudicationConfig,
  type HumanAdjudicationSlackAdapter,
  type HumanAdjudicationPersistence,
  type AdjudicationStatus,
} from "./duplicate/human-adjudication.service";
export {
  hybridRetrieval,
  type HybridRetrievalResult,
  type HybridRetrievalConfig,
  type HybridCandidate,
  type StructuredMatch,
} from "./duplicate/hybrid-retrieval";
export {
  computeCandidateSimilarity,
  DEFAULT_SIMILARITY_WEIGHTS,
  DEFAULT_CORROBORATION_FLOOR,
  RRF_SCORE_CEILING,
  type CandidateTierScores,
  type CandidateSimilarityOptions,
  type CandidateSimilarityWeights,
} from "./duplicate/candidate-similarity";
export {
  EmbeddingIndexService,
  issueToEmbeddingText,
  type IndexableIssue,
  type BackfillResult,
  type ReindexResult,
  type IndexHealthReport,
  type EmbeddingIndexPersistence,
  type EmbeddingIndexVectorStore,
} from "./duplicate/embedding-index.service";
export {
  DuplicateOrchestrator,
  type DuplicateOrchestratorConfig,
  type DuplicateOrchestratorOutcome,
} from "./duplicate/duplicate-orchestrator";
export {
  DuplicateMetricsCollector,
  type DuplicateMetrics,
  type MetricsSample,
} from "./duplicate/duplicate-metrics";
export {
  generateDuplicateExplanation,
  generateDuplicateCommentBody,
  generateReplayExplanation,
  type DuplicateExplanationInput,
} from "./duplicate/duplicate-explanation";
export {
  DuplicateAuditService,
  type DuplicateAuditRecord,
  type DuplicateAuditPersistence,
} from "./duplicate/duplicate-audit.service";

export {
  evaluateSeverityPriority,
  type SeverityPriorityConfig,
  type SeverityPriorityInputs,
} from "./severity/severity-priority-policy";

export {
  evaluatePendingClosure,
  shouldCancelPendingClosure,
  type PendingClosureConfig,
  type PendingClosureContext,
} from "./pending-closure/pending-closure-policy";

export {
  CANCELLATION_REASON_CODES,
  type CancellationReasonCode,
  type ClosureCancellationRecord,
} from "./pending-closure/cancellation-reason-codes";
export {
  evaluateCancellationSignals,
  toClosureCancellationRecord,
  type CancellationSignalContext,
  type CancellationEvaluation,
} from "./pending-closure/cancellation-signals";

export { RunBudgetTracker, type RunBudgetConfig, type BudgetAction } from "./budgets/run-budget-tracker";

export { RollbackService, type RollbackResult } from "./rollback/rollback-service";

export { buildDigest, formatDigestMarkdown, type DigestReport } from "./digest/digest-builder";

export {
  evaluateQuickFixEligibility,
  QUICK_FIX_REASON_CODES,
  type QuickFixPolicyConfig,
  type QuickFixContext,
  type QuickFixOutcome,
  type QuickFixReasonCode,
  type QuickFixSpecEvidence,
  type QuickFixSpecReference,
  type QuickFixEligibilityResult,
} from "./quick-fix/quick-fix-eligibility";

// Spec approval authority, the feature
// policy family, and the unified run-budget vocabulary.
export * from "./spec";
export {
  assertBudgetPolicyComplete,
  budgetPolicySchema,
  budgetsSchema,
  BudgetResolutionError,
  BUDGET_KEYS,
  loadBudgetPolicy,
  resolveBudgetLimit,
  toLegacyRunBudgetConfig,
  toLegacyRunBudgetLimits,
  type BudgetCompletenessResult,
  type BudgetKey,
  type BudgetPolicy,
  type LoadBudgetPolicyResult,
} from "./budgets/budget-policy";
export {
  capabilityProblems,
  classifiedActions,
  formatGracePeriod,
  grantablePermissions,
  loadGrantablePermissions,
  renderCapabilityMatrix,
  type CapabilityModuleRecord,
  type CapabilitySnapshot,
  type CapabilityToolRecord,
} from "./capability-matrix/capability-matrix";

export {
  GOVERNANCE_POLICIES,
  createPolicyEvaluation,
  type PolicyEvaluationRecord,
} from "./policy-registry/policy-evaluation";

export { PendingClosureExecutor, type PendingClosureExecutorResult } from "./pending-closure/pending-closure-executor";
export { GitHubIntakeWatcher, type ReposConfig } from "./intake/github-intake-watcher";
export { loadGovernanceConfig } from "./config/load-governance-config";
export { governanceConfigDir, governanceConfigPath } from "./config/config-dir";
export type { GovernanceConfig } from "./config/governance-config.schema";
export { NoopReproductionProvider } from "./reproduction/noop-reproduction-provider";

export { RepositoryRegistry, RepositoryIntelligenceService, ProjectsV2Service, ProjectsV2PrismaPersistence, type ProjectsV2Config, type ProjectsV2GitHubPort, type ProjectsPersistence, type ProjectsPrismaClient, type ProjectsPersistenceOptions, type ReposConfig as RepositoryReposConfig, type ProductEntry, type RepositoryResolution, type EngineeringContext } from "./repository";

export * from "./authorization";

export * from "./notification";

export * from "./evidence-pipeline";

export * from "./memory";

export * from "./blast-radius";

export const GOVERNANCE_PACKAGE_TOKEN = Symbol("GOVERNANCE_PACKAGE_TOKEN");


// Advanced agent intelligence
export * from "./agent-intelligence";


// Platform hardening
export * from "./platform";


// Evaluation infrastructure
export * from "./evaluation";

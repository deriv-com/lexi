/**
 * @lexi/programme — the rebuild programme domain.
 *
 * State machines, the task DAG, the auto-merge and hardening gates,
 * milestone planning, brief assembly, the review Block Kit and the policy
 * loader (all pure), plus the engine that runs a programme
 * (`ProgrammeBuildService`), its persistence (in-memory and Prisma stores),
 * the milestone review service and the agent tool module. Every external
 * system is reached through a narrow port the server wires in.
 */

export {
  ALL_PROGRAMME_STATUSES,
  InvalidProgrammeTransitionError,
  ProgrammeStateMachine,
} from "./programme-state-machine";

export {
  ALL_MILESTONE_STATUSES,
  InvalidMilestoneTransitionError,
  MilestoneStateMachine,
} from "./milestone-state-machine";

export {
  ALL_BUILD_TASK_STATUSES,
  BuildTaskStateMachine,
  InvalidBuildTaskTransitionError,
} from "./build-task-state-machine";

export {
  readyTasks,
  topologicalOrder,
  validateTaskGraph,
  type TaskGraphValidation,
  type TaskNode,
} from "./task-graph";

export {
  applyCriterionMapping,
  applyRefinements,
  deferredCriteria,
  deriveMilestonePlan,
  deriveSharedInfraTasks,
  parseCriteriaByScreen,
  screenSlug,
  sharedInfraTaskId,
  validateMilestonePlanAgainstShared,
  SHARED_INFRA_MILESTONE_ID,
  type MilestonePlanInput,
  type PlannedTask,
  type PlanRefinement,
  type RefinementOutcome,
  type SharedInfraSlot,
} from "./milestone-plan";

export {
  buildTaskBrief,
  InvalidBuildBriefError,
  type BuildBriefArgs,
} from "./build-brief";

export { featureSpecsForScreens, isFeatureSpecIndex, matchFeatureSpecs } from "./feature-specs";

export {
  evaluateAutoMergeGate,
  criterionReason,
  parseCriterionReason,
  type AutoMergeGateInput,
  type EvidenceRow,
} from "./auto-merge-gate";

export { deriveAcStatuses, evaluateAcMatrix } from "./ac-matrix-evaluate";

export {
  filterOpenApiSpec,
  InvalidOpenApiError,
  type FilteredOpenApi,
} from "./api-contract";

export {
  evaluateHardeningGate,
  type HardeningGateInput,
  type HardeningGateVerdict,
} from "./hardening-gate";

export {
  hardeningConcludeBlocks,
  MILESTONE_REVIEW_ACTION_PREFIX,
  MILESTONE_REVIEW_ACTIONS,
  milestoneReviewBlocks,
  milestoneReviewFallbackText,
  parseHardeningConcludeClick,
  parseMilestoneReviewClick,
  type HardeningConcludeClick,
  type MilestoneReviewBlockArgs,
  type MilestoneReviewClick,
  type MilestoneReviewDecision,
} from "./milestone-review-blocks";

export {
  PROGRAMME_POLICY_PATH,
  loadProgrammePolicy,
  parseProgrammePolicy,
  programmeWorkingBranch,
  repoSettingsFor,
  type ProgrammePolicy,
} from "./load-programme-policy";

export {
  createProgrammeToolModule,
  programmeToolDefinitions,
  PROGRAMME_PROMPT_SECTION,
  READ_ONLY_PROGRAMME_TOOLS,
  PROGRAMME_FLAG,
  PROGRAMME_INTENT_CLASSES,
  PROGRAMME_PERMISSIONS,
  PROGRAMME_TOOL_MODULE_NAME,
  PROGRAMME_TOOL_NAMES,
  PROGRAMME_TOOL_PERMISSIONS,
  HUMAN_ONLY_PROGRAMME_TOOLS,
  isProgrammeToolName,
  type ProgrammeToolInvoker,
  type ProgrammeToolModuleDeps,
  type ProgrammeToolName,
  type ProgrammeToolOptions,
} from "./programme-tool-module";

export {
  applyProgrammeGraphSection,
  buildProgrammeGraphViews,
  PROGRAMME_GRAPH_BEGIN_MARKER,
  PROGRAMME_GRAPH_END_MARKER,
  renderProgrammeGraphSection,
} from "./graph/programme-graph";

export { modelForAttempt, type ModelLadderInput } from "./model-ladder";
export {
  isPreAgentHandback,
  infrastructureStageOf,
  type InfrastructureStage,
  refundForInfraFault,
  refundForMergeConflict,
  type AttemptRefund,
  type ConflictRefund,
} from "./attempt-accounting";
export type { PlannedTaskKind } from "./milestone-plan";

export {
  extractParityInventory,
  isParityEnvExamplePath,
  isParityLocalePath,
  isParityManifestPath,
  isParityRoutePath,
  isParityScreenPath,
  isParitySourcePath,
  PARITY_LIST_CAP,
  selectParityFiles,
  type ParityFileSelection,
  type ParityInventoryExtract,
  type ParityInventoryFile,
  type ParityInventoryInput,
} from "./parity-inventory";

export {
  CACHE_WRITE_RATE_MULTIPLIER,
  CACHED_INPUT_RATE_MULTIPLIER,
  estimateEntryCostUsd,
  formatCacheHitRate,
  formatTokenCount,
  formatUsageSummary,
  parseTokenUsageChecks,
  summarizeTokenUsage,
  TOKEN_USAGE_CHECK_NAME,
  type TokenUsageEntry,
  type UsageModelSummary,
  type UsagePricing,
  type UsageSummary,
} from "./token-usage";
export {
  benchArmOf,
  benchArmTaskId,
  BENCH_EFFORTS,
  benchModelSlug,
  isBenchBaseRef,
  isBenchEffort,
  isBenchTask,
  MAX_BENCH_MODELS,
  planModelBench,
  withoutBenchTasks,
  type BenchArmMetadata,
  type BenchArmRow,
  type BenchEffort,
  type BenchPlan,
  type BenchSourceTask,
} from "./model-bench-plan";

export {
  InMemoryProgrammeStore,
  mergeStructuralMetadata,
  parseRenderedAcceptanceCriteria,
  type ApprovedSpecView,
  type BuildTaskRecord,
  type MilestoneRecord,
  type ProgrammeRecord,
  type ProgrammeSpecReader,
  type ProgrammeStore,
} from "./programme-store";

export {
  ProgrammeMilestoneReviewService,
  type HardeningConclusionPort,
  type MilestoneReviewResult,
  type ProgrammeAuthzPort,
  type ProgrammeMilestoneReviewDeps,
  type ReviewLogger,
} from "./programme-milestone-review";

export { ProgrammeBuildService } from "./engine/programme-build.service";
export {
  attemptSpendFromEvidence,
  gateRefusalLine,
  markdownSection,
  milestoneTechnicalSpecPath,
  milestoneTechnicalSpecTaskId,
  resolveBenchSource,
  TECHNICAL_SPEC_SECTIONS,
  technicalSpecPath,
} from "./engine/helpers";
export type {
  PreviewProbePort,
  ProgrammeApiContractPort,
  ProgrammeAttemptStore,
  ProgrammeBuildDeps,
  ProgrammeBuildResult,
  ProgrammeDesignContextPort,
  ProgrammeEvidenceArtifactPort,
  ProgrammeEvidencePort,
  ProgrammeFlags,
  ProgrammeGithubPort,
  ProgrammeInvocationContext,
  ProgrammeLogger,
  ProgrammeNotifierPort,
  ProgrammeRepoRegistry,
  ProgrammeToolResult,
  RunEvidenceListRow,
} from "./engine/ports";

// Prisma-backed stores (structural client access; no @lexi/database import).
export { PrismaProgrammeStore, PrismaProgrammeSpecReader } from "./prisma/programme-store.prisma";
export {
  PrismaRunEvidenceStore,
  parseRunEvidenceBundle,
  runEvidenceBundleKey,
  claimedEvidenceRepository,
  REPOSITORY_MISMATCH,
  RUN_EVIDENCE_LIMITS,
  type ParsedRunEvidence,
  type RunEvidenceIngestOptions,
} from "./prisma/run-evidence.prisma";
export type { PrismaDelegate, PrismaDelegateHost } from "./prisma/prisma-delegate";

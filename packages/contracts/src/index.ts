/**
 * @lexi/contracts — the cross-package type surface.
 *
 * Types only. This package holds no runtime logic and depends on no other
 * @lexi package, so every package can import it without pulling in another
 * package's implementation.
 */

export type {
  DecisionNote,
  EntityRef,
  MemoryEntityType,
  MemoryEpisodeInput,
  MemoryEpisodeKind,
  MemoryEpisodeRecord,
  MemoryPack,
  MemoryPort,
  MemoryScope,
  MemoryTemporalStatus,
  RecallQuery,
  ThreadState,
  TokenBudget,
  TurnDigest,
} from "./memory";

export type {
  AcceptanceCriterion,
  CoverageDimension,
  CoverageEntry,
  CoverageRecord,
  CoverageStatus,
  SpecChangedSection,
  SpecEvidenceKind,
  SpecEvidenceLink,
  SpecNamedOwner,
  SpecRef,
  SpecStatus,
} from "./spec";

export type {
  DirectFixSettings,
  PreviewLinkSettings,
  RepoDescriptor,
  RepoRole,
  WorkItemKind,
  WorkItemRef,
  WorkItemStatus,
} from "./work-items";

export type {
  ConformancePoint,
  ConformanceSource,
  SpecConformanceReport,
  SpecProvenance,
} from "./spec-provenance";

export type { IntentClass } from "./agent";

export type {
  EmbeddingBatchResult,
  EmbeddingProvider,
  EmbeddingProviderHealth,
  EmbeddingResult,
} from "./embedding";

export type {
  ReproductionEvidenceItem,
  ReproductionProvider,
  ReproductionRequest,
  ReproductionResult,
  ReproductionStatus,
  ReproductionSubmission,
} from "./reproduction";

export type { AutonomyTier } from "./work-items";

export type {
  ApiReferenceDocument,
  AutoMergeVerdict,
  BuildTaskBrief,
  BuildTaskStatus,
  MilestoneStatus,
  ProgrammeStatus,
} from "./programme";

export type {
  FailingTestProof,
  RunCheckResult,
  RunCheckStatus,
  RunEvidenceArtifact,
  RunEvidenceBundle,
  RunEvidencePhase,
  RunEvidenceReceipt,
} from "./run-evidence";

export type {
  AcceptanceTestBinding,
  AcceptanceTestKind,
  AcceptanceTestStatus,
  AcTestMatrixEvaluation,
} from "./acceptance-test-matrix";

export type { ApiContractDocument, ApiContractOperation } from "./api-contract";

export type { DesignContextDocument, DesignContextNode, DesignContextState } from "./design-context";

export type { ParityInventoryDocument, ParityPlatform } from "./parity-inventory";

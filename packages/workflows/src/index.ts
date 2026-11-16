export * from "./types";
export { WORKFLOW_ORCHESTRATOR_TOKEN } from "./tokens";
export { WorkflowRepository, WORKFLOW_REPOSITORY_TOKEN } from "./workflow-repository.interface";
export { WorkflowStateMachine, InvalidWorkflowTransitionError } from "./workflow-state-machine";
export {
  WorkflowOrchestrator,
  WorkflowOrchestratorOptions,
  WorkflowStageNotification,
  // (module x platform) routing port. A module-inference service in the host
  // application satisfies `ModuleRouter` structurally; a package cannot import an app.
  type ModuleRouter,
  type ModuleRoutingInference,
  type ModuleRoutingTarget,
  type ModuleLabelWriteOutcome,
} from "./workflow-orchestrator";
export { CrossOrgClosureChecker, ClosureEvidence } from "./cross-org-closure-checker";
export { PrismaWorkflowRepository } from "./prisma-workflow.repository";
export { InMemoryWorkflowRepository } from "./testing/in-memory-workflow.repository";
export { evaluateAutoClose, AutoCloseContext, AutoCloseEvaluation } from "./auto-close-policy";
export {
  LifecycleCoverage,
  inferRequiredLifecycleStates,
  mergeLifecycleCoverage,
  enrichResultDetailsWithLifecycle,
} from "./lifecycle-coverage";
export {
  evaluateEscalation,
  buildDeterministicDecision,
  remapCompleteCoverageClassification,
  type EscalationEvaluation,
} from "./escalation-policy";
export { PolicyEngine, PolicyEngineOptions } from "./policy-engine";
export {
  buildVerificationReport,
  buildVerificationReportComment,
  VerificationReport,
} from "./verification-report";
export { IssueVerificationService } from "./issue-verification.service";
export {
  IssueReplayService,
  IssueReplayServiceOptions,
  type ReplayPlannerPort,
  type ReplayScenarioCandidate,
} from "./issue-replay.service";
export {
  ReplayReport,
  ReplayStep,
  ReplayAt,
  ReplayEvidenceView,
  ReplayEvidenceRecordView,
  REPLAY_AT_VALUES,
  REPLAY_STAGE_NOT_YET_AVAILABLE,
  isReplayAt,
  formatReplayReport,
  formatTimeTravelReplay,
} from "./replay-report";
export {
  ALL_WORKFLOW_STATES,
  applyWorkflowGraphSection,
  buildWorkflowGraph,
  renderWorkflowGraphNotes,
  renderWorkflowGraphSection,
  renderWorkflowMermaid,
  WORKFLOW_GRAPH_BEGIN_MARKER,
  WORKFLOW_GRAPH_END_MARKER,
  type WorkflowGraph,
  type WorkflowGraphEdge,
  type WorkflowGraphSyncResult,
} from "./graph/workflow-graph";

// Unified verification contract
export {
  type VerificationResult,
  type VerificationVerdict,
  type VerificationExecutor,
  type VerificationBlocker,
  type EvidenceReference,
  VERIFICATION_CONTRACT_VERSION,
  isValidNegativeEvidence,
  isValidPositiveEvidence,
  canNeverBecomeNegativeEvidence,
  isCapabilityGap,
  unsupportedResult,
  inconclusiveResult,
  notObservedResult,
  observedResult,
} from "./verification-contract";
export {
  mapReproductionResultToVerification,
  mapAssistedResultToVerification,
  mapManualInvestigationToVerification,
  type ReproductionVerificationDetails,
  type AssistedVerificationResult,
  type ManualInvestigationInput,
} from "./verification-adapters";
export {
  evaluateVerificationAutoClose,
  evaluateVerificationEscalation,
  extractCapabilityGap,
  type VerificationAutoCloseConfig,
  type VerificationAutoCloseEvaluation,
  type VerificationEscalation,
  type CapabilityGap,
} from "./verification-policy";
export {
  CapabilityIntelligenceService,
  type CapabilityGapSummary,
  type CapabilityIntelligenceReport,
  type CapabilityGapPersistence,
} from "./capability-intelligence";
// Spec conformance. Reconstructs expectations from the APPROVED spec revision
// and compares them with what was built. Reports drift; it never blocks.
// Flag: feature-policy.yaml verification.specConformanceEnabled AND
// SPEC_CONFORMANCE_ENABLED.
export {
  SpecConformanceService,
  type SpecConformanceDeps,
} from "./spec-conformance/spec-conformance.service";
export {
  buildJudgeInput,
  hashSpecBody,
  isSpecConformanceEnabled,
  normaliseJudgement,
  rollUpVerdict,
  type ConformanceVerdict,
} from "./spec-conformance/spec-conformance-policy";
export {
  renderConformanceReport,
  resolveConformanceDestination,
} from "./spec-conformance/spec-conformance-report";
export type {
  ApprovedSpecRevisionPort,
  BuiltArtefact,
  ConformanceDestination,
  ConformanceDestinationKind,
  RawConformanceJudgement,
  SpecConformanceJudge,
  SpecConformanceJudgeInput,
  SpecConformanceOptions,
  SpecProvenancePort,
} from "./spec-conformance/spec-conformance.types";

export {
  decideNotReproduced,
  priorityFromLabels,
  isHighPriority,
  shouldNotifyQaOnConfirmed,
  type NotReproducedAction,
  type NotReproducedDecision,
} from "./not-reproduced-closure";

export {
  classifyReproductionWorkflow,
  buildWorkflowClassificationPrompt,
  parseWorkflowAnswer,
  workflowVocabulary,
  type WorkflowVocabularySource,
  type WorkflowClassification,
  type WorkflowClassificationInput,
  type WorkflowClassifierPort,
} from "./workflow-classifier";

export { evaluateReviewGate, summariseReviewGate } from "./review-verdict-gate";
export {
  REVIEW_DOMAINS,
  type ReviewDomain,
  type ReviewEvidence,
  type ReviewException,
  type ReviewGateEvaluation,
  type ReviewGateInput,
  type ReviewGateRefusal,
  type ReviewGateRefusalCode,
  type ReviewVerdictOutcome,
  type ReviewVerdictRecord,
} from "./review-verdict.types";

export { evaluateAcTestMatrix } from "./ac-test-matrix";
export { evaluateSecurityCriteria } from "./security-criteria";
export {
  SECURITY_REVIEW_CRITERIA,
  type SecurityCriteriaEvaluation,
  type SecurityCriteriaRefusal,
  type SecurityCriteriaRefusalCode,
  type SecurityReviewCriterion,
} from "./security-criteria.types";
export { evaluateDeliveryControls } from "./delivery-controls";
export {
  DELIVERY_CONTROLS,
  type DeliveryControl,
  type DeliveryControlsEvaluation,
} from "./delivery-controls.types";
export { GITHUB_ISSUE_NUMBER_MAX, isGithubIssueNumber } from "./github-issue-number";


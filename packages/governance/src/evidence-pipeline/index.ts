// Types
export type { IssueAnalysis, IssueAnalysisInput } from "./issue-analysis.types";
export type {
  ObservationAssessment,
  IssueSourceType,
} from "./evidence-assessment.types";
export { SOURCE_TRUST_DEFAULTS } from "./evidence-assessment.types";
export type {
  EngineeringInvestigation,
  LinkedIssue,
  LinkedPullRequest,
  ProjectStatus,
  CodeEvidence,
  ReleaseEvidence,
} from "./engineering-investigation.types";
export type { FixAssessment, FixStatus } from "./fix-assessment.types";
export type {
  ReproductionDecision,
  ReproductionNecessityInput,
  ReproductionAlternativeAction,
  ReproductionPriority,
} from "./reproduction-necessity-policy.types";
export type { EvidenceFreshness, FreshnessConfig } from "./evidence-freshness";

// Services (deterministic, no LLM dependency)
export { assessEvidence, type EvidenceAssessmentInput } from "./evidence-assessment.service";
export { assessFixLikelihood } from "./fix-assessment.service";
export { evaluateReproductionNecessity } from "./reproduction-necessity-policy";
export { evaluateEvidenceFreshness, evidenceDecayFactor } from "./evidence-freshness";
export {
  EngineeringChangeInvestigationService,
  type InvestigationGitHubPort,
  type InvestigationError,
  type InvestigationConfig,
} from "./engineering-investigation.service";
export {
  IssueAnalysisService,
  type AnalysisLLMClient,
  type IssueAnalysisServiceConfig,
  type IssueAnalysisResult,
} from "./issue-analysis.service";
export {
  EvidenceFirstRouter,
  type EvidenceRoutingOutcome,
  type EvidenceFirstRouterConfig,
} from "./evidence-first-router";

export {
  AgentPlanExecutionEngine,
  PlanBuilder,
  type AgentPlan,
  type PlanStep,
  type PlanStepKind,
  type PlanStepStatus,
  type PlanStatus,
  type PlanBudget,
  type AgentPlanPersistence,
  type StepExecutor,
} from "./agent-plan.service";

export {
  generateHypotheses,
  selectBestAction,
  updateProbabilities,
  isInvestigationConcluded,
  type Hypothesis,
  type HypothesisStatus,
  type EvidenceAction,
  type EvidenceActionCost,
  type InvestigationState,
  type InvestigationConclusion,
  type IssueAnalysisForHypothesis,
} from "./hypothesis-investigation.service";

export {
  CrossIssueReasoningService,
  type CrossIssueQueryPort,
  type CrossIssueReport,
  type ComponentHotspot,
  type DuplicateClusterGrowth,
  type ManualReviewDebt,
  type PortfolioInsight,
} from "./cross-issue-reasoning.service";

export {
  FeedbackLearningService,
  type FeedbackRecord,
  type FeedbackCategory,
  type FeedbackRecommendation,
  type FeedbackReport,
  type FeedbackPersistence,
} from "./feedback-learning.service";
export { PrismaFeedbackPersistence, type FeedbackCorrectionPrisma } from "./prisma-feedback-persistence";

export {
  LexiCapabilityRegistry,
  buildCapabilityRegistry,
  type LexiCapability,
  type CapabilityStatus,
} from "./capability-registry";

export {
  evaluateCounterfactual,
  formatCounterfactualForDisplay,
  type CounterfactualAction,
  type CounterfactualOutcome,
  type CounterfactualDeps,
} from "./counterfactual.service";

/**
 * @lexi/specs — the clarification loop and spec pipeline.
 *
 * Everything here is deterministic code with zero LLM calls: coverage state,
 * the readiness stop condition, question batching, spec rendering and the spec
 * lifecycle. The model's job in this pipeline is to elicit answers and to
 * classify them into dimensions; every *decision* — when to stop asking, what
 * to ask next, what the document says, which repo it lands in — is made here
 *.
 */

export { COVERAGE_DIMENSIONS, isCoverageDimension } from "./coverage-dimensions";

export {
  coverageStatusFor,
  createCoverageRecord,
  deferDimension,
  isDimensionSettled,
  normalizeCoverageRecord,
  openDimensions,
  recordCoverage,
  settledDimensions,
} from "./coverage";
export type { CoverageState, CoverageUpdate, SpecCoverageEntry, SpecCoverageRecord } from "./coverage";

export {
  DEFAULT_MIN_DIMENSION_CONFIDENCE,
  loadSpecPolicy,
  parseSpecPolicy,
  SPEC_POLICY_PATH,
} from "./load-spec-policy";
export type { SpecPolicy, SpecRiskClassifierRule } from "./load-spec-policy";

export { isReadyToDraft, readinessPolicyFrom } from "./readiness";
export type { ReadinessOptions, ReadinessPolicy, ReadinessReason, ReadinessResult } from "./readiness";

export { QUESTION_PROMPTS } from "./question-prompts";
export type { QuestionPrompt } from "./question-prompts";

export { coverageDelta, nextQuestionBatch, questionPolicyFrom } from "./question-policy";
export type { PendingQuestion, QuestionBatch, QuestionPolicy } from "./question-policy";

export {
  ALL_SPEC_STATUSES,
  buildSpecGraph,
  InvalidSpecTransitionError,
  renderSpecMermaid,
  SpecStateMachine,
} from "./spec-state-machine";
export type { SpecGraph, SpecGraphEdge } from "./spec-state-machine";

export { classifySpecRisk, riskTierAtLeast } from "./risk-tier";
export type { SpecRiskClassification, SpecRiskInput, SpecRiskPolicy } from "./risk-tier";

export {
  parseSpecFrontmatter,
  renderSpec,
  SPEC_OPEN_QUESTIONS_SECTION_ID,
  SPEC_REVISION_LEDGER_SECTION_ID,
  SPEC_SECTIONS,
  SPEC_TASK_BREAKDOWN_SECTION_ID,
} from "./spec-template";
export type {
  RenderedSpec,
  RenderedSpecSection,
  SpecDocumentContent,
  SpecDraftInput,
  SpecFrontmatter,
  SpecRevisionLedger,
  SpecSection,
  SpecTaskBreakdownItem,
} from "./spec-template";

export {
  assertSpecRepo,
  buildSpecAnnouncement,
  buildSpecIssue,
  specIssueLabels,
  specIssueTitle,
  SpecRepoRoleError,
  toSpecDocumentMirror,
} from "./spec-output";
export type {
  SpecAnnouncement,
  SpecDocumentMirror,
  SpecIssuePayload,
  SpecLabelPolicy,
} from "./spec-output";

/**
 * The human approval surface. `approve_spec` is withheld from the model
 * payload entirely, so these are the only route by which a spec is ever
 * approved — the Block Kit payload, the parser for the click, and the label
 * flip. The governed chain that acts on a parsed click lives in the
 * orchestrator, where the authorization service and the database are.
 */
export {
  parseSpecApprovalAction,
  specApprovalBlocks,
  specLabelTransition,
  SPEC_APPROVAL_ACTION_PREFIX,
  SPEC_APPROVAL_ACTIONS,
} from "./spec-approval";
export type {
  SpecApprovalBlockArgs,
  SpecApprovalClick,
  SpecApprovalDecision,
  SpecLabelTransition,
} from "./spec-approval";

export {
  advanceSpecSession,
  applyAnswers,
  approveSession,
  deriveTaskBreakdown,
  draftSpec,
  rejectSession,
  requestChanges,
  startSpecSession,
  submitForReview,
  validateTaskBreakdown,
} from "./spec-session";
export type {
  DerivedTask,
  DimensionAnswer,
  DraftedSpec,
  SessionAnswers,
  SpecSessionState,
  SpecSessionStep,
  TaskBreakdownValidation,
} from "./spec-session";

export {
  acceptanceCriterionId,
  parseAcceptanceCriteria,
  splitAcceptanceCriteria,
  toDispatchCandidate,
} from "./task-candidates";
export type { SpecTaskCandidate } from "./task-candidates";

export { FEATURE_INTAKE_FIELDS, featureFieldSchemaFor } from "./feature-intake-fields";
export type { IntakeFieldDescriptor } from "./feature-intake-fields";

export {
  diffSpecRevisions,
  summariseSpecDiff,
  type SpecFieldChange,
  type SpecRevisionDiff,
  type SpecRevisionSide,
  type SpecSectionChange,
  type SpecSectionChangeKind,
} from "./spec-diff";

export {
  approverOwner,
  inferSpecEvidenceKind,
  isSpecEvidenceHref,
  ledgerFromDiff,
  parseChangedSections,
  parseSpecEvidenceLink,
  requesterOwner,
  sanitizeEvidenceLinks,
  sanitizeNamedOwners,
} from "./spec-revision-ledger";
export type {
  SpecChangedSection,
  SpecEvidenceKind,
  SpecEvidenceLink,
  SpecNamedOwner,
} from "./spec-revision-ledger";
export {
  seedAnswersForTool,
  seedSessionFromDocument,
  splitSections,
  type SeedFromDocumentOptions,
} from "./seed-from-document";

// OpenSpec — reviewed product behaviour as Requirement -> Scenario pairs
// (openspec/specs/<domain>/spec.md). Strict parser: a
// scenario it cannot read is reported, never silently dropped.
export {
  parseOpenSpec,
  openSpecAcceptanceCriteria,
  acceptanceCriteriaFromOpenSpec,
} from "./openspec";
export type { OpenSpecDocument, OpenSpecRequirement, OpenSpecScenario } from "./openspec";

// OpenSpec → spec-session seeding. Distinct from seedSessionFromDocument:
// OpenSpec's headings match no coverage synonym, but its scenarios ARE the
// acceptance criteria, and they round-trip to identical AC ids.
export { seedSessionFromOpenSpec, openSpecSeedAnswersForTool } from "./openspec-seed";
export type { OpenSpecSeedOptions, OpenSpecSeedResult } from "./openspec-seed";

// Business PRODUCT_SPEC.md → spec-session seeding. One
// criterion per behaviour, rule, state, validation and error statement of the
// named domains, minted with the same AC-id rule as every other seeder.
export { parseProductSpec, seedSessionFromProductSpec } from "./product-spec";
export type {
  ProductSpecDocument,
  ProductSpecDomain,
  ProductSpecJourney,
  ProductSpecSeedOptions,
  ProductSpecSeedResult,
} from "./product-spec";

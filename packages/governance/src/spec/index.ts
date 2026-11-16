/**
 * Spec and feature governance.
 *
 * The chassis these sit on lives in `../blast-radius` and is unchanged: action
 * classes, the mutation guard and run budgets never knew what a "bug" was and
 * needed no fork. What is here is the part that does not generalise — the
 * approval authority rules for specs, and the per-kind vocabulary that
 * replaces reproduction/priority/severity for work that is not a bug.
 */

export {
  evaluateSpecGate,
  SPEC_GATE_REASONS,
  type SpecGateAction,
  type SpecGateDecision,
  type SpecGateInput,
  type SpecGateReason,
} from "./spec-gate";

export {
  loadSpecPolicy,
  riskTierRank,
  specApprovalSchema,
  specPolicySchema,
  SPEC_RISK_TIERS,
  twoPersonRuleSchema,
  type SpecApprovalPolicy,
  type SpecPolicy,
  type SpecRiskTier,
  type TwoPersonRuleConfig,
} from "./spec-policy.schema";

export {
  featurePolicySchema,
  featureVocabularySchema,
  isKnownWorkItemKind,
  loadFeaturePolicy,
  WORK_ITEM_KINDS,
  WORK_ITEM_PREDICATES,
  type FeaturePolicy,
  type FeatureVocabulary,
  type WorkItemKind,
  type WorkItemPredicate,
} from "./feature-policy.schema";

export {
  buildSpecProvenance,
  loadSpecProvenance,
  loadSpecProvenanceRecord,
  specProvenanceMetadata,
  SPEC_PROVENANCE_METADATA_KEY,
  SPEC_PROVENANCE_STATUS,
  SPEC_PROVENANCE_STATUS_METADATA_KEY,
  type ResolvedSpecEvidence,
  type SpecProvenanceRecord,
  type SpecProvenanceStatus,
  type SpecProvenanceWorkItemStore,
} from "./spec-provenance";

export {
  evaluateRequiredFields,
  evaluateWorkItemNeverTouch,
  WORK_ITEM_GUARD_REASONS,
  type RequiredFieldsResult,
  type WorkItemGuardReason,
  type WorkItemNeverTouchEvaluation,
  type WorkItemNeverTouchInput,
} from "./work-item-guard";

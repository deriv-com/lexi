/**
 * Contract Versioning — schema evolution tracking for all system contracts.
 *
 * Every typed contract in the system has a version. Consumers can detect
 * when they're reading data from a newer or older schema and handle
 * migration accordingly.
 */

export interface ContractVersion {
  contract: string;
  version: string;
  introducedAt: string;
  deprecated?: boolean;
  deprecatedAt?: string;
  migrationNotes?: string;
}

/** All system contract versions — single source of truth. */
export const CONTRACT_VERSIONS: Record<string, ContractVersion> = {
  "verification_result": {
    contract: "VerificationResult",
    version: "1.0.0",
    introducedAt: "2026-08-09",
  },
  "event_log": {
    contract: "DomainEvent",
    version: "1.0.0",
    introducedAt: "2026-08-09",
  },
  "agent_plan": {
    contract: "AgentPlan",
    version: "1.0.0",
    introducedAt: "2026-08-09",
  },
  "intake_decision": {
    contract: "IntakeDecisionResult",
    version: "1.0.0",
    introducedAt: "2026-08-08",
  },
  "duplicate_adjudication": {
    contract: "DuplicateAdjudicationRecord",
    version: "1.0.0",
    introducedAt: "2026-08-09",
  },
  "embedding": {
    contract: "IssueEmbedding",
    version: "1.0.0",
    introducedAt: "2026-08-09",
  },
  "tool_result_envelope": {
    contract: "AgentToolResultEnvelope",
    version: "1.0.0",
    introducedAt: "2026-08-08",
  },
  "policy_evaluation": {
    contract: "PolicyEvaluation",
    version: "1.0.0",
    introducedAt: "2026-08-03",
  },
  "feedback_correction": {
    contract: "FeedbackCorrection",
    version: "1.0.0",
    introducedAt: "2026-08-09",
  },
};

/**
 * Check if a contract version is compatible with the current system.
 */
export function isCompatible(contract: string, dataVersion: string): boolean {
  const current = CONTRACT_VERSIONS[contract];
  if (!current) return false;
  // Simple semver major check: same major = compatible
  const [currentMajor] = current.version.split(".");
  const [dataMajor] = dataVersion.split(".");
  return currentMajor === dataMajor;
}

/**
 * Get the current version for a contract.
 */
export function getCurrentVersion(contract: string): string {
  return CONTRACT_VERSIONS[contract]?.version ?? "0.0.0";
}

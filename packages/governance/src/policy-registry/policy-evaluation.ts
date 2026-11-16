export interface PolicyEvaluationRecord {
  policyId: string;
  policyVersion: string;
  inputs: Record<string, unknown>;
  outcome: string;
  reasons: string[];
  timestamp: string;
  runId?: string;
}

export interface PolicyRegistryEntry {
  id: string;
  version: string;
  description: string;
  configPath?: string;
}

export const GOVERNANCE_POLICIES: PolicyRegistryEntry[] = [
  { id: "intake-acceptance", version: "1.0.0", description: "Intake acceptance policy", configPath: "config/intake-policy.yaml" },
  { id: "intake-rejection", version: "1.0.0", description: "Intake rejection policy", configPath: "config/intake-policy.yaml" },
  { id: "duplicate", version: "1.0.0", description: "Duplicate detection policy", configPath: "config/duplicate-policy.yaml" },
  { id: "reproduction-escalation", version: "1.0.0", description: "Reproduction escalation", configPath: "config/reproduction-policy.yaml" },
  { id: "lifecycle-coverage", version: "1.0.0", description: "Lifecycle coverage gates" },
  { id: "auto-close", version: "1.0.0", description: "Auto-close policy" },
  { id: "pending-closure", version: "1.0.0", description: "Grace-period closure", configPath: "config/reproduction-policy.yaml" },
  { id: "assignment", version: "1.0.0", description: "Ownership assignment" },
  { id: "severity-priority", version: "1.0.0", description: "Severity/priority rules", configPath: "config/severity-priority.yaml" },
  { id: "quick-fix-eligibility", version: "1.0.0", description: "Quick-fix PR eligibility", configPath: "config/autofix-policy.yaml" },
  { id: "slack-authorization", version: "1.0.0", description: "Slack command auth", configPath: "config/slack-authorization.yaml" },
  { id: "rollback", version: "1.0.0", description: "Run rollback policy" },
  { id: "evidence-retention", version: "1.0.0", description: "Evidence retention", configPath: "config/evidence-retention.yaml" },
];

export function createPolicyEvaluation(
  policyId: string,
  policyVersion: string,
  inputs: Record<string, unknown>,
  outcome: string,
  reasons: string[],
  runId?: string,
): PolicyEvaluationRecord {
  return {
    policyId,
    policyVersion,
    inputs,
    outcome,
    reasons,
    timestamp: new Date().toISOString(),
    runId,
  };
}

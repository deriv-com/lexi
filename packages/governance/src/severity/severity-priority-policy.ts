export type Severity = "S1" | "S2" | "S3" | "S4";
export type Priority = "P0" | "P1" | "P2" | "P3" | "P4";

export interface SeverityPriorityInputs {
  affectedUsers?: number;
  revenueImpact?: boolean;
  tradingImpact?: boolean;
  moneyMovement?: boolean;
  dataIntegrity?: boolean;
  authentication?: boolean;
  withdrawalDeposit?: boolean;
  tradeExecution?: boolean;
  frequency?: "rare" | "occasional" | "frequent" | "constant";
  workaroundAvailable?: boolean;
  regression?: boolean;
  duplicateVolume?: number;
  customerFacing?: boolean;
  existingPriorityLabel?: string;
  existingSeverityLabel?: string;
}

export interface SeverityPriorityRule {
  id: string;
  when: Partial<Record<string, boolean | string | number>>;
  severity: Severity;
  priority: Priority;
  explanation: string;
}

export interface SeverityPriorityConfig {
  version: string;
  rules: SeverityPriorityRule[];
  priorityOrder: Priority[];
  severityOrder: Severity[];
  humanPriorityProtection: boolean;
}

export interface SeverityPriorityDecision {
  severity: Severity;
  priority: Priority;
  ruleId: string;
  explanation: string;
  humanPriorityPreserved: boolean;
}

function matchesRule(rule: SeverityPriorityRule, inputs: SeverityPriorityInputs): boolean {
  for (const [key, expected] of Object.entries(rule.when)) {
    const value = inputs[key as keyof SeverityPriorityInputs];
    if (value === undefined) return false;
    if (value !== expected) return false;
  }
  return true;
}

function parsePriorityFromLabel(label: string): Priority | undefined {
  const match = label.match(/p([0-4])/i);
  if (!match) return undefined;
  return `P${match[1]}` as Priority;
}

function higherPriority(a: Priority, b: Priority, order: Priority[]): Priority {
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

/**
 * Deterministic severity and priority from configured rules. AI extracts inputs; policy computes output.
 */
export function evaluateSeverityPriority(
  inputs: SeverityPriorityInputs,
  config: SeverityPriorityConfig,
): SeverityPriorityDecision {
  let severity: Severity = "S4";
  let priority: Priority = "P4";
  let ruleId = "default";
  let explanation = "No matching rule — default low severity/priority.";

  for (const rule of config.rules) {
    if (matchesRule(rule, inputs)) {
      severity = rule.severity;
      priority = rule.priority;
      ruleId = rule.id;
      explanation = rule.explanation;
      break;
    }
  }

  let humanPriorityPreserved = false;
  if (config.humanPriorityProtection && inputs.existingPriorityLabel) {
    const human = parsePriorityFromLabel(inputs.existingPriorityLabel);
    if (human) {
      const preserved = higherPriority(human, priority, config.priorityOrder);
      if (preserved !== priority) {
        humanPriorityPreserved = true;
        priority = preserved;
        explanation += ` Human-set priority preserved (${human}).`;
      }
    }
  }

  return { severity, priority, ruleId, explanation, humanPriorityPreserved };
}

/**
 * Manual Queue SLA tracking.
 *
 * NEEDS_MANUAL_INVESTIGATION is NOT a safe terminal outcome
 * unless someone owns the queue. This service tracks:
 * - Queue size, oldest item, median response time
 * - SLA breaches and abandoned items
 * - Escalation triggers
 */

export interface ManualQueueItem {
  issueId: string;
  issueNumber: number;
  priority?: string;
  assignedTo?: string;
  enteredAt: Date;
  firstResponseAt?: Date;
  resolvedAt?: Date;
  status: "unowned" | "owned" | "in_progress" | "resolved" | "returned_to_automation";
}

export interface ManualQueueMetrics {
  totalItems: number;
  unownedItems: number;
  oldestItemAge: number; // hours
  medianFirstResponseHours: number | null;
  slaBreaches: number;
  abandonedItems: number; // >7 days untouched
  itemsWithoutOwner: number;
  returnedToAutomation: number;
}

export interface EscalationRule {
  condition: "unowned_hours" | "p1_untouched_hours" | "untouched_days";
  threshold: number;
  action: "notify_lead" | "escalate" | "governance_incident";
}

export interface EscalationTrigger {
  issueNumber: number;
  issueId: string;
  rule: EscalationRule;
  triggeredAt: Date;
  message: string;
}

export interface ManualQueueSLAConfig {
  escalationRules: EscalationRule[];
  slaResponseHours: number; // Default: 24h for first response
  abandonmentDays: number;  // Default: 7 days
}

const DEFAULT_SLA_CONFIG: ManualQueueSLAConfig = {
  escalationRules: [
    { condition: "unowned_hours", threshold: 4, action: "notify_lead" },
    { condition: "p1_untouched_hours", threshold: 24, action: "escalate" },
    { condition: "untouched_days", threshold: 7, action: "governance_incident" },
  ],
  slaResponseHours: 24,
  abandonmentDays: 7,
};

/**
 * Evaluate the manual queue and produce metrics + escalation triggers.
 */
export function evaluateManualQueue(
  items: ManualQueueItem[],
  config: ManualQueueSLAConfig = DEFAULT_SLA_CONFIG,
): { metrics: ManualQueueMetrics; escalations: EscalationTrigger[] } {
  const now = Date.now();
  const activeItems = items.filter((i) => i.status !== "resolved" && i.status !== "returned_to_automation");
  const resolvedItems = items.filter((i) => i.status === "resolved" || i.status === "returned_to_automation");

  // Metrics
  const unownedItems = activeItems.filter((i) => i.status === "unowned");
  const abandonedItems = activeItems.filter((i) => {
    const ageHours = (now - i.enteredAt.getTime()) / (1000 * 60 * 60);
    return ageHours >= config.abandonmentDays * 24 && !i.firstResponseAt;
  });

  let oldestItemAge = 0;
  for (const item of activeItems) {
    const ageHours = (now - item.enteredAt.getTime()) / (1000 * 60 * 60);
    if (ageHours > oldestItemAge) oldestItemAge = ageHours;
  }

  // Median first response time
  const responseTimes = resolvedItems
    .filter((i) => i.firstResponseAt)
    .map((i) => (i.firstResponseAt!.getTime() - i.enteredAt.getTime()) / (1000 * 60 * 60));
  const medianFirstResponseHours = responseTimes.length > 0
    ? responseTimes.sort((a, b) => a - b)[Math.floor(responseTimes.length / 2)]
    : null;

  // SLA breaches: items that exceeded response SLA
  const slaBreaches = activeItems.filter((i) => {
    const ageHours = (now - i.enteredAt.getTime()) / (1000 * 60 * 60);
    return ageHours > config.slaResponseHours && !i.firstResponseAt;
  }).length;

  const metrics: ManualQueueMetrics = {
    totalItems: activeItems.length,
    unownedItems: unownedItems.length,
    oldestItemAge: Math.round(oldestItemAge),
    medianFirstResponseHours,
    slaBreaches,
    abandonedItems: abandonedItems.length,
    itemsWithoutOwner: unownedItems.length,
    returnedToAutomation: items.filter((i) => i.status === "returned_to_automation").length,
  };

  // Escalation triggers
  const escalations: EscalationTrigger[] = [];

  for (const item of activeItems) {
    const ageHours = (now - item.enteredAt.getTime()) / (1000 * 60 * 60);
    const ageDays = ageHours / 24;

    for (const rule of config.escalationRules) {
      let triggered = false;
      let message = "";

      switch (rule.condition) {
        case "unowned_hours":
          if (item.status === "unowned" && ageHours >= rule.threshold) {
            triggered = true;
            message = `Issue #${item.issueNumber} has been unowned for ${Math.round(ageHours)}h (threshold: ${rule.threshold}h)`;
          }
          break;
        case "p1_untouched_hours":
          if (item.priority === "P1" && !item.firstResponseAt && ageHours >= rule.threshold) {
            triggered = true;
            message = `P1 issue #${item.issueNumber} untouched for ${Math.round(ageHours)}h (threshold: ${rule.threshold}h)`;
          }
          break;
        case "untouched_days":
          if (!item.firstResponseAt && ageDays >= rule.threshold) {
            triggered = true;
            message = `Issue #${item.issueNumber} untouched for ${Math.round(ageDays)} days — governance incident`;
          }
          break;
      }

      if (triggered) {
        escalations.push({
          issueNumber: item.issueNumber,
          issueId: item.issueId,
          rule,
          triggeredAt: new Date(),
          message,
        });
      }
    }
  }

  return { metrics, escalations };
}

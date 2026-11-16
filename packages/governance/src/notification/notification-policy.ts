export interface NotificationPolicyInput {
  classification: string;
  severity?: string;
  priority?: string;
  team?: string;
  channel?: string;
  issueNumber: number;
  writesEnabled: boolean;
  notificationsEnabled: boolean;
}

export interface NotificationPolicyConfig {
  enabled: boolean;
  minPriority: string;
  dedupWindowMs: number;
  quietHoursStart?: number; // 0-23 UTC
  quietHoursEnd?: number;
  maxNotificationsPerHour: number;
}

export interface NotificationPolicyDecision {
  allowed: boolean;
  destination?: string;
  deliveryMode: "thread" | "channel" | "dm" | "none";
  mentionOwner: boolean;
  reason: string;
  deduplicationKey: string;
}

const PRIORITY_ORDER = ["P0", "P1", "P2", "P3", "P4"];

/**
 * Deterministic notification policy. The conversation model does NOT decide
 * whether to notify — this policy does.
 */
export function evaluateNotificationPolicy(
  input: NotificationPolicyInput,
  config: NotificationPolicyConfig,
  recentNotifications: Array<{ key: string; sentAt: number }> = [],
): NotificationPolicyDecision {
  const dedupKey = `notify:${input.issueNumber}:${input.classification}`;

  if (!config.enabled || !input.notificationsEnabled) {
    return { allowed: false, deliveryMode: "none", mentionOwner: false, reason: "Notifications disabled.", deduplicationKey: dedupKey };
  }

  // Priority threshold
  const inputPriorityIdx = PRIORITY_ORDER.indexOf(input.priority ?? "P4");
  const minPriorityIdx = PRIORITY_ORDER.indexOf(config.minPriority);
  if (inputPriorityIdx > minPriorityIdx && minPriorityIdx >= 0) {
    return { allowed: false, deliveryMode: "none", mentionOwner: false, reason: `Priority ${input.priority ?? "unset"} is below threshold ${config.minPriority}.`, deduplicationKey: dedupKey };
  }

  // Quiet hours (UTC)
  if (config.quietHoursStart !== undefined && config.quietHoursEnd !== undefined) {
    const hour = new Date().getUTCHours();
    if (config.quietHoursStart < config.quietHoursEnd) {
      if (hour >= config.quietHoursStart && hour < config.quietHoursEnd) {
        return { allowed: false, deliveryMode: "none", mentionOwner: false, reason: `Quiet hours (${config.quietHoursStart}-${config.quietHoursEnd} UTC).`, deduplicationKey: dedupKey };
      }
    } else {
      if (hour >= config.quietHoursStart || hour < config.quietHoursEnd) {
        return { allowed: false, deliveryMode: "none", mentionOwner: false, reason: `Quiet hours (${config.quietHoursStart}-${config.quietHoursEnd} UTC).`, deduplicationKey: dedupKey };
      }
    }
  }

  // Deduplication
  const now = Date.now();
  const isDuplicate = recentNotifications.some(
    (n) => n.key === dedupKey && (now - n.sentAt) < config.dedupWindowMs,
  );
  if (isDuplicate) {
    return { allowed: false, deliveryMode: "none", mentionOwner: false, reason: "Duplicate notification within deduplication window.", deduplicationKey: dedupKey };
  }

  // Rate limit
  const oneHourAgo = now - 3_600_000;
  const recentCount = recentNotifications.filter((n) => n.sentAt > oneHourAgo).length;
  if (recentCount >= config.maxNotificationsPerHour) {
    return { allowed: false, deliveryMode: "none", mentionOwner: false, reason: `Rate limit: ${config.maxNotificationsPerHour} notifications/hour exceeded.`, deduplicationKey: dedupKey };
  }

  // Determine delivery mode
  const deliveryMode = input.channel ? "channel" : "none";
  const destination = input.channel;

  return {
    allowed: true,
    destination,
    deliveryMode,
    mentionOwner: true, // subject to confidence gating downstream
    reason: "Notification policy allows delivery.",
    deduplicationKey: dedupKey,
  };
}

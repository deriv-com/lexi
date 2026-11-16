/**
 * Manual Review Queue — managed workflow for NEEDS_MANUAL_INVESTIGATION.
 *
 * A manual queue with no owner is a governance failure, not a safe fallback.
 * This service provides durable queue items with states, SLA deadlines,
 * escalation triggers, and Lexi-queryable status.
 */

import { randomUUID } from "node:crypto";

export type ManualReviewStatus =
  | "UNASSIGNED"
  | "ASSIGNED"
  | "ACKNOWLEDGED"
  | "INVESTIGATING"
  | "BLOCKED"
  | "RESOLVED"
  | "ABANDONED";

export interface ManualReviewItem {
  id: string;
  issueId: string;
  issueNumber: number;
  repo: string;
  reason: string;
  priority?: string;
  severity?: string;
  owningTeam?: string;
  assignee?: string;
  status: ManualReviewStatus;
  enteredAt: Date;
  slaDeadline: Date;
  acknowledgedAt?: Date;
  lastHumanActivityAt?: Date;
  resolvedAt?: Date;
  resolutionNote?: string;
  escalationLevel: number; // 0 = none, 1 = lead notified, 2 = escalated, 3 = incident
  metadata: Record<string, unknown>;
}

export interface CreateManualReviewInput {
  issueId: string;
  issueNumber: number;
  repo: string;
  reason: string;
  priority?: string;
  severity?: string;
  owningTeam?: string;
  assignee?: string;
  slaHours?: number;
  metadata?: Record<string, unknown>;
}

export interface ManualReviewQueueStore {
  create(item: ManualReviewItem): Promise<ManualReviewItem>;
  findByIssue(issueId: string): Promise<ManualReviewItem | null>;
  findActive(filter?: { status?: ManualReviewStatus; owningTeam?: string; assignee?: string }): Promise<ManualReviewItem[]>;
  update(id: string, patch: Partial<ManualReviewItem>): Promise<ManualReviewItem>;
}

export interface ManualReviewQueueConfig {
  defaultSlaHours: number;
  p1SlaHours: number;
  p2SlaHours: number;
}

const DEFAULT_CONFIG: ManualReviewQueueConfig = {
  defaultSlaHours: 48,
  p1SlaHours: 8,
  p2SlaHours: 24,
};

/**
 * Manual Review Queue service.
 *
 * Lexi can query: "What manual investigations are overdue?"
 * Teams can be held accountable: unowned items escalate automatically.
 */
export class ManualReviewQueueService {
  constructor(
    private readonly store: ManualReviewQueueStore,
    private readonly config: ManualReviewQueueConfig = DEFAULT_CONFIG,
  ) {}

  /**
   * Create a new manual review item when an issue enters NEEDS_MANUAL_INVESTIGATION.
   * Idempotent: if the issue already has an active review item, returns it.
   */
  async createReviewItem(input: CreateManualReviewInput): Promise<ManualReviewItem> {
    // Check for existing active item
    const existing = await this.store.findByIssue(input.issueId);
    if (existing && !this.isTerminal(existing.status)) {
      return existing;
    }

    const slaHours = input.slaHours ?? this.getSlaHours(input.priority);
    const item: ManualReviewItem = {
      id: randomUUID(),
      issueId: input.issueId,
      issueNumber: input.issueNumber,
      repo: input.repo,
      reason: input.reason,
      priority: input.priority,
      severity: input.severity,
      owningTeam: input.owningTeam,
      assignee: input.assignee,
      status: input.assignee ? "ASSIGNED" : "UNASSIGNED",
      enteredAt: new Date(),
      slaDeadline: new Date(Date.now() + slaHours * 60 * 60 * 1000),
      escalationLevel: 0,
      metadata: input.metadata ?? {},
    };

    return this.store.create(item);
  }

  /**
   * Assign a review item to an engineer.
   */
  async assign(itemId: string, assignee: string, team?: string): Promise<ManualReviewItem> {
    return this.store.update(itemId, {
      assignee,
      owningTeam: team,
      status: "ASSIGNED",
    });
  }

  /**
   * Acknowledge that the assignee is aware of the item.
   */
  async acknowledge(itemId: string): Promise<ManualReviewItem> {
    return this.store.update(itemId, {
      status: "ACKNOWLEDGED",
      acknowledgedAt: new Date(),
      lastHumanActivityAt: new Date(),
    });
  }

  /**
   * Mark as actively being investigated.
   */
  async startInvestigating(itemId: string): Promise<ManualReviewItem> {
    return this.store.update(itemId, {
      status: "INVESTIGATING",
      lastHumanActivityAt: new Date(),
    });
  }

  /**
   * Mark as blocked (waiting on something external).
   */
  async markBlocked(itemId: string, reason: string): Promise<ManualReviewItem> {
    return this.store.update(itemId, {
      status: "BLOCKED",
      lastHumanActivityAt: new Date(),
      metadata: { blockedReason: reason },
    });
  }

  /**
   * Resolve the review item.
   */
  async resolve(itemId: string, note: string, returnToAutomation = false): Promise<ManualReviewItem> {
    return this.store.update(itemId, {
      status: "RESOLVED",
      resolvedAt: new Date(),
      resolutionNote: note,
      lastHumanActivityAt: new Date(),
      metadata: { returnedToAutomation: returnToAutomation },
    });
  }

  /**
   * Escalate an item (increment escalation level).
   */
  async escalate(itemId: string): Promise<ManualReviewItem> {
    const item = await this.store.findActive().then((items) => items.find((i) => i.id === itemId));
    const newLevel = (item?.escalationLevel ?? 0) + 1;
    return this.store.update(itemId, { escalationLevel: newLevel });
  }

  /**
   * Get all overdue items (past SLA deadline and not resolved).
   */
  async getOverdueItems(): Promise<ManualReviewItem[]> {
    const active = await this.store.findActive();
    const now = new Date();
    return active.filter((item) => item.slaDeadline < now);
  }

  /**
   * Get all unassigned items.
   */
  async getUnassignedItems(): Promise<ManualReviewItem[]> {
    return this.store.findActive({ status: "UNASSIGNED" });
  }

  /**
   * Get items for a specific team.
   */
  async getTeamItems(team: string): Promise<ManualReviewItem[]> {
    return this.store.findActive({ owningTeam: team });
  }

  /**
   * Get items assigned to a specific person.
   */
  async getAssigneeItems(assignee: string): Promise<ManualReviewItem[]> {
    return this.store.findActive({ assignee });
  }

  /**
   * Get queue summary for Lexi to answer questions like
   * "What manual investigations are overdue?"
   */
  async getQueueSummary(): Promise<{
    total: number;
    unassigned: number;
    overdue: number;
    byStatus: Record<ManualReviewStatus, number>;
    oldestItemHours: number;
  }> {
    const active = await this.store.findActive();
    const now = Date.now();

    const byStatus: Record<ManualReviewStatus, number> = {
      UNASSIGNED: 0, ASSIGNED: 0, ACKNOWLEDGED: 0,
      INVESTIGATING: 0, BLOCKED: 0, RESOLVED: 0, ABANDONED: 0,
    };
    for (const item of active) {
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    }

    const overdue = active.filter((i) => i.slaDeadline.getTime() < now).length;
    const oldest = active.reduce((max, i) => {
      const age = (now - i.enteredAt.getTime()) / (1000 * 60 * 60);
      return age > max ? age : max;
    }, 0);

    return {
      total: active.length,
      unassigned: byStatus.UNASSIGNED,
      overdue,
      byStatus,
      oldestItemHours: Math.round(oldest),
    };
  }

  private getSlaHours(priority?: string): number {
    if (priority === "P0" || priority === "P1") return this.config.p1SlaHours;
    if (priority === "P2") return this.config.p2SlaHours;
    return this.config.defaultSlaHours;
  }

  private isTerminal(status: ManualReviewStatus): boolean {
    return status === "RESOLVED" || status === "ABANDONED";
  }
}

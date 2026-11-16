/**
 * Immutable Event Log Service — append-only event stream.
 *
 * Every significant system action is recorded as an event:
 * - Workflow transitions
 * - Tool calls (agent)
 * - Plan creation/execution/approval
 * - Policy decisions (auto-close, escalation)
 * - Authorization checks
 * - GitHub mutations
 * - Verification results
 * - Intake decisions
 * - Feedback corrections
 * - Memory updates
 * - Embedding operations
 * - Duplicate adjudications
 *
 * Principles:
 * - Append-only: events are NEVER modified or deleted
 * - Idempotent: duplicate eventId is rejected (safe retry)
 * - Ordered: events are sequenced per aggregate
 * - Causal: correlationId + causationId enable trace reconstruction
 * - Typed: eventType + aggregateType enable filtered replay
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type EventAggregateType =
  | "issue"
  | "workflow"
  | "plan"
  | "reproduction"
  | "verification"
  | "intake"
  | "duplicate"
  | "project"
  | "release"
  | "feedback"
  | "system";

export type EventActorType = "system" | "user" | "scheduler" | "agent" | "webhook";

export interface DomainEvent {
  eventId: string;
  eventType: string;
  aggregateType: EventAggregateType;
  aggregateId: string;
  actorId?: string;
  actorType: EventActorType;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
  occurredAt: Date;
}

// ---------------------------------------------------------------------------
// Persistence interface
// ---------------------------------------------------------------------------

export interface EventLogPersistence {
  append(event: DomainEvent): Promise<void>;
  appendBatch(events: DomainEvent[]): Promise<void>;
  queryByAggregate(aggregateType: string, aggregateId: string, afterVersion?: number): Promise<DomainEvent[]>;
  queryByCorrelation(correlationId: string): Promise<DomainEvent[]>;
  queryByType(eventType: string, since: Date, limit?: number): Promise<DomainEvent[]>;
  queryByActor(actorId: string, since: Date, limit?: number): Promise<DomainEvent[]>;
  queryRange(since: Date, until: Date, eventTypes?: string[]): Promise<DomainEvent[]>;
}

// ---------------------------------------------------------------------------
// Event log service
// ---------------------------------------------------------------------------

export class EventLogService {
  private currentCorrelationId?: string;

  constructor(private readonly persistence: EventLogPersistence) {}

  /**
   * Set a correlation ID for the current request/operation.
   * All events emitted within this scope share the correlation.
   */
  withCorrelation(correlationId: string): EventLogService {
    const scoped = new EventLogService(this.persistence);
    scoped.currentCorrelationId = correlationId;
    return scoped;
  }

  /**
   * Emit a single event (append-only, idempotent).
   */
  async emit(
    eventType: string,
    aggregateType: EventAggregateType,
    aggregateId: string,
    payload: Record<string, unknown>,
    options?: {
      actorId?: string;
      actorType?: EventActorType;
      metadata?: Record<string, unknown>;
      causationId?: string;
      correlationId?: string;
    },
  ): Promise<string> {
    const eventId = randomUUID();
    const event: DomainEvent = {
      eventId,
      eventType,
      aggregateType,
      aggregateId,
      actorId: options?.actorId,
      actorType: options?.actorType ?? "system",
      payload,
      metadata: options?.metadata,
      correlationId: options?.correlationId ?? this.currentCorrelationId,
      causationId: options?.causationId,
      occurredAt: new Date(),
    };
    await this.persistence.append(event);
    return eventId;
  }

  /**
   * Emit a batch of events atomically.
   */
  async emitBatch(events: Array<Omit<DomainEvent, "eventId" | "occurredAt"> & { occurredAt?: Date }>): Promise<string[]> {
    const full: DomainEvent[] = events.map((e) => ({
      ...e,
      eventId: randomUUID(),
      occurredAt: e.occurredAt ?? new Date(),
      correlationId: e.correlationId ?? this.currentCorrelationId,
    }));
    await this.persistence.appendBatch(full);
    return full.map((e) => e.eventId);
  }

  // ---- Convenience emitters for common event types ----

  async emitWorkflowTransition(issueId: string, from: string, to: string, actor?: string): Promise<string> {
    return this.emit("workflow.transitioned", "workflow", issueId, { from, to }, { actorId: actor });
  }

  async emitToolCall(toolName: string, args: Record<string, unknown>, result: unknown, actor?: string): Promise<string> {
    return this.emit("agent.tool_called", "system", toolName, { args, result }, { actorId: actor, actorType: "agent" });
  }

  async emitPolicyDecision(issueId: string, policy: string, decision: string, reason: string): Promise<string> {
    return this.emit("policy.decided", "issue", issueId, { policy, decision, reason });
  }

  async emitMutation(resource: string, action: string, target: Record<string, unknown>, actor?: string): Promise<string> {
    return this.emit("mutation.executed", "system", resource, { action, target }, { actorId: actor });
  }

  async emitVerification(issueId: string, verdict: string, executor: string, confidence: number): Promise<string> {
    return this.emit("verification.completed", "verification", issueId, { verdict, executor, confidence });
  }

  async emitIntakeDecision(requestId: string, disposition: string, issueNumber?: number): Promise<string> {
    return this.emit("intake.decided", "intake", requestId, { disposition, issueNumber });
  }

  async emitFeedback(issueNumber: number, category: string, actor: string): Promise<string> {
    return this.emit("feedback.recorded", "feedback", String(issueNumber), { category }, { actorId: actor, actorType: "user" });
  }

  async emitPlanAction(planId: string, action: string, stepId?: string, actor?: string): Promise<string> {
    return this.emit(`plan.${action}`, "plan", planId, { stepId }, { actorId: actor, actorType: actor ? "user" : "agent" });
  }

  // ---- Query methods (for replay and audit) ----

  async getIssueHistory(issueId: string): Promise<DomainEvent[]> {
    return this.persistence.queryByAggregate("issue", issueId);
  }

  async getRequestTrace(correlationId: string): Promise<DomainEvent[]> {
    return this.persistence.queryByCorrelation(correlationId);
  }

  async getEventsByType(eventType: string, since: Date, limit = 100): Promise<DomainEvent[]> {
    return this.persistence.queryByType(eventType, since, limit);
  }

  async getActorActivity(actorId: string, since: Date, limit = 50): Promise<DomainEvent[]> {
    return this.persistence.queryByActor(actorId, since, limit);
  }

  async getEventsInRange(since: Date, until: Date, eventTypes?: string[]): Promise<DomainEvent[]> {
    return this.persistence.queryRange(since, until, eventTypes);
  }
}

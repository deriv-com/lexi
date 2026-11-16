/**
 * Backpressure — intake flood protection, queue depth control, admission control.
 *
 * Prevents the system from being overwhelmed by:
 * - Sudden spikes in intake submissions
 * - Queue depth exceeding safe processing capacity
 * - Too many concurrent reproductions
 * - Resource exhaustion
 *
 * When backpressure is active, the system:
 * 1. Defers new intake requests (returns 429)
 * 2. Pauses scheduled automation
 * 3. Prioritizes existing work over new work
 * 4. Records backpressure events for observability
 */

export interface BackpressureConfig {
  /** Maximum intake submissions per minute before throttling. */
  intakeRateLimit: number;
  /** Maximum pending reproductions before deferring new ones. */
  maxPendingReproductions: number;
  /** Maximum workflow executions in active state. */
  maxActiveWorkflows: number;
  /** Maximum queue depth before pausing scheduler. */
  maxQueueDepth: number;
  /** Cooldown period after backpressure triggers (ms). */
  cooldownMs: number;
}

export const DEFAULT_BACKPRESSURE_CONFIG: BackpressureConfig = {
  intakeRateLimit: 30,
  maxPendingReproductions: 20,
  maxActiveWorkflows: 100,
  maxQueueDepth: 500,
  cooldownMs: 60_000,
};

export type BackpressureReason =
  | "intake_rate_exceeded"
  | "reproduction_capacity"
  | "workflow_capacity"
  | "queue_depth"
  | "none";

export interface BackpressureState {
  active: boolean;
  reason: BackpressureReason;
  since?: string;
  currentLoad: {
    intakeRatePerMinute: number;
    pendingReproductions: number;
    activeWorkflows: number;
    queueDepth: number;
  };
}

export interface AdmissionDecision {
  admitted: boolean;
  reason: string;
  retryAfterMs?: number;
}

/**
 * Backpressure controller.
 */
export class BackpressureController {
  private intakeTimestamps: number[] = [];
  private backpressureSince?: string;
  private lastCooldownEnd = 0;

  constructor(private readonly config: BackpressureConfig = DEFAULT_BACKPRESSURE_CONFIG) {}

  /**
   * Check if a new intake request should be admitted.
   */
  evaluateIntakeAdmission(): AdmissionDecision {
    const now = Date.now();

    // Rate limit check: count requests in the last minute
    this.intakeTimestamps = this.intakeTimestamps.filter((t) => now - t < 60_000);

    if (this.intakeTimestamps.length >= this.config.intakeRateLimit) {
      return {
        admitted: false,
        reason: `Intake rate limit exceeded (${this.intakeTimestamps.length}/${this.config.intakeRateLimit} per minute).`,
        retryAfterMs: this.config.cooldownMs,
      };
    }

    // Cooldown check
    if (now < this.lastCooldownEnd) {
      return {
        admitted: false,
        reason: "System in cooldown after backpressure event.",
        retryAfterMs: this.lastCooldownEnd - now,
      };
    }

    this.intakeTimestamps.push(now);
    return { admitted: true, reason: "Admitted." };
  }

  /**
   * Evaluate system-wide backpressure state.
   */
  evaluateState(load: {
    pendingReproductions: number;
    activeWorkflows: number;
    queueDepth: number;
  }): BackpressureState {
    const intakeRate = this.intakeTimestamps.filter((t) => Date.now() - t < 60_000).length;

    const currentLoad = {
      intakeRatePerMinute: intakeRate,
      pendingReproductions: load.pendingReproductions,
      activeWorkflows: load.activeWorkflows,
      queueDepth: load.queueDepth,
    };

    if (load.queueDepth >= this.config.maxQueueDepth) {
      return this.activateBackpressure("queue_depth", currentLoad);
    }
    if (load.activeWorkflows >= this.config.maxActiveWorkflows) {
      return this.activateBackpressure("workflow_capacity", currentLoad);
    }
    if (load.pendingReproductions >= this.config.maxPendingReproductions) {
      return this.activateBackpressure("reproduction_capacity", currentLoad);
    }
    if (intakeRate >= this.config.intakeRateLimit) {
      return this.activateBackpressure("intake_rate_exceeded", currentLoad);
    }

    this.backpressureSince = undefined;
    return { active: false, reason: "none", currentLoad };
  }

  private activateBackpressure(
    reason: BackpressureReason,
    currentLoad: BackpressureState["currentLoad"],
  ): BackpressureState {
    if (!this.backpressureSince) {
      this.backpressureSince = new Date().toISOString();
      this.lastCooldownEnd = Date.now() + this.config.cooldownMs;
    }
    return { active: true, reason, since: this.backpressureSince, currentLoad };
  }

  /**
   * Should the scheduler pause?
   */
  shouldPauseScheduler(load: { queueDepth: number; activeWorkflows: number }): boolean {
    return load.queueDepth >= this.config.maxQueueDepth || load.activeWorkflows >= this.config.maxActiveWorkflows;
  }
}

/**
 * SLO and Degradation Modes — explicit safe behavior for every dependency failure.
 *
 * Every external dependency has:
 * - A health check
 * - An SLO (target availability, latency, error rate)
 * - Defined safe degradation behavior when the SLO is breached
 *
 * The system NEVER fails silently. When degraded, it:
 * 1. Records the degradation event
 * 2. Switches to explicit safe fallback behavior
 * 3. Reports the degradation to monitoring and to Lexi's capability registry
 * 4. Continues operating with reduced capability
 */

export type DependencyStatus = "healthy" | "degraded" | "unavailable" | "unknown";

export interface DependencySLO {
  name: string;
  targetAvailability: number; // e.g., 0.99
  targetLatencyP95Ms: number;
  targetErrorRate: number; // e.g., 0.01
  checkIntervalMs: number;
}

export interface DependencyHealth {
  name: string;
  status: DependencyStatus;
  lastCheckAt: string;
  latencyMs?: number;
  errorRate?: number;
  consecutiveFailures: number;
  degradedSince?: string;
  safeBehavior: string;
}

export interface DegradationPolicy {
  /** Number of consecutive failures before marking degraded. */
  failureThreshold: number;
  /** Number of consecutive failures before marking unavailable. */
  unavailableThreshold: number;
  /** What to do when degraded. */
  degradedBehavior: string;
  /** What to do when unavailable. */
  unavailableBehavior: string;
}

/**
 * System dependencies with their SLOs and degradation policies.
 */
export const SYSTEM_DEPENDENCIES: Record<string, { slo: DependencySLO; policy: DegradationPolicy }> = {
  github_api: {
    slo: { name: "GitHub API", targetAvailability: 0.99, targetLatencyP95Ms: 3000, targetErrorRate: 0.02, checkIntervalMs: 60_000 },
    policy: { failureThreshold: 3, unavailableThreshold: 10, degradedBehavior: "Queue mutations, continue reads from cache", unavailableBehavior: "Block all GitHub operations, defer work" },
  },
  slack_api: {
    slo: { name: "Slack API", targetAvailability: 0.99, targetLatencyP95Ms: 2000, targetErrorRate: 0.01, checkIntervalMs: 30_000 },
    policy: { failureThreshold: 3, unavailableThreshold: 10, degradedBehavior: "Queue messages, continue processing", unavailableBehavior: "Log-only mode for notifications" },
  },
  model_gateway: {
    slo: { name: "Model gateway", targetAvailability: 0.95, targetLatencyP95Ms: 30_000, targetErrorRate: 0.05, checkIntervalMs: 60_000 },
    policy: { failureThreshold: 2, unavailableThreshold: 5, degradedBehavior: "Fall back to deterministic analysis", unavailableBehavior: "Skip LLM-dependent stages entirely" },
  },
  reproduction: {
    slo: { name: "Reproduction", targetAvailability: 0.9, targetLatencyP95Ms: 120_000, targetErrorRate: 0.1, checkIntervalMs: 300_000 },
    policy: { failureThreshold: 3, unavailableThreshold: 8, degradedBehavior: "Mark reproductions as INCONCLUSIVE", unavailableBehavior: "Skip reproduction, route to manual" },
  },
  vector_index: {
    slo: { name: "Vector Index (pgvector)", targetAvailability: 0.95, targetLatencyP95Ms: 1000, targetErrorRate: 0.05, checkIntervalMs: 60_000 },
    policy: { failureThreshold: 3, unavailableThreshold: 10, degradedBehavior: "Use lexical-only duplicate search", unavailableBehavior: "Disable duplicate semantic tier" },
  },
  database: {
    slo: { name: "PostgreSQL", targetAvailability: 0.999, targetLatencyP95Ms: 500, targetErrorRate: 0.001, checkIntervalMs: 10_000 },
    policy: { failureThreshold: 1, unavailableThreshold: 3, degradedBehavior: "Read-only mode", unavailableBehavior: "Full system pause, alert on-call" },
  },
  issue_sync: {
    slo: { name: "Issue sync", targetAvailability: 0.95, targetLatencyP95Ms: 60_000, targetErrorRate: 0.05, checkIntervalMs: 900_000 },
    policy: { failureThreshold: 3, unavailableThreshold: 10, degradedBehavior: "Continue with stale issue data", unavailableBehavior: "Mark issue data as stale in all responses" },
  },
};

/**
 * Dependency health tracker.
 */
export class DependencyHealthTracker {
  private health = new Map<string, DependencyHealth>();

  constructor() {
    for (const [key, { slo, policy }] of Object.entries(SYSTEM_DEPENDENCIES)) {
      this.health.set(key, {
        name: slo.name,
        status: "unknown",
        lastCheckAt: new Date().toISOString(),
        consecutiveFailures: 0,
        safeBehavior: policy.degradedBehavior,
      });
    }
  }

  /**
   * Record a health check result.
   */
  recordCheck(dependency: string, success: boolean, latencyMs?: number): void {
    const entry = this.health.get(dependency);
    if (!entry) return;

    const policy = SYSTEM_DEPENDENCIES[dependency]?.policy;
    if (!policy) return;

    entry.lastCheckAt = new Date().toISOString();
    entry.latencyMs = latencyMs;

    if (success) {
      entry.consecutiveFailures = 0;
      entry.status = "healthy";
      entry.degradedSince = undefined;
    } else {
      entry.consecutiveFailures++;
      if (entry.consecutiveFailures >= policy.unavailableThreshold) {
        entry.status = "unavailable";
        entry.safeBehavior = policy.unavailableBehavior;
      } else if (entry.consecutiveFailures >= policy.failureThreshold) {
        if (entry.status !== "degraded") {
          entry.degradedSince = new Date().toISOString();
        }
        entry.status = "degraded";
        entry.safeBehavior = policy.degradedBehavior;
      }
    }
  }

  /**
   * Get current health status for all dependencies.
   */
  getAll(): DependencyHealth[] {
    return [...this.health.values()];
  }

  /**
   * Get status for a specific dependency.
   */
  getStatus(dependency: string): DependencyHealth | undefined {
    return this.health.get(dependency);
  }

  /**
   * Check if any dependency is degraded or unavailable.
   */
  hasIssues(): boolean {
    return [...this.health.values()].some((h) => h.status === "degraded" || h.status === "unavailable");
  }

  /**
   * Get a human-readable summary.
   */
  getSummary(): string {
    const all = this.getAll();
    const healthy = all.filter((h) => h.status === "healthy").length;
    const degraded = all.filter((h) => h.status === "degraded");
    const unavailable = all.filter((h) => h.status === "unavailable");

    if (degraded.length === 0 && unavailable.length === 0) {
      return `All ${healthy} dependencies healthy.`;
    }

    const parts: string[] = [];
    if (degraded.length > 0) parts.push(`Degraded: ${degraded.map((d) => d.name).join(", ")}`);
    if (unavailable.length > 0) parts.push(`Unavailable: ${unavailable.map((d) => d.name).join(", ")}`);
    return parts.join(". ");
  }
}

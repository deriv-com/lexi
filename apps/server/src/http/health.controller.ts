import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { AUTHORIZATION_SERVICE_TOKEN, CONFIG_TOKEN, PRISMA_SERVICE_TOKEN } from "../tokens";

export interface ReadinessReport {
  status: "ready" | "not_ready";
  checks: {
    database: "ok" | "unavailable";
    authorization: "ok" | "unavailable";
    config: "ok";
  };
  configRevision?: string;
}

/**
 * Liveness and readiness.
 *
 * `/health` answers as long as the process is serving HTTP. `/health/ready`
 * also checks the database and that the authorization policy loaded; a server
 * whose policy failed to load still runs (it refuses every governed action),
 * but it is reported as not ready so the problem is visible.
 */
@Controller("health")
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN) private readonly database: { $queryRaw(query: TemplateStringsArray): Promise<unknown> },
    @Inject(AUTHORIZATION_SERVICE_TOKEN) private readonly authorization: { isReady(): boolean },
    @Inject(CONFIG_TOKEN) private readonly config: { CONFIG_REVISION?: string },
  ) {}

  @Get()
  liveness(): { status: "ok"; uptimeSeconds: number } {
    return { status: "ok", uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  @Get("ready")
  async readiness(): Promise<ReadinessReport> {
    let database: ReadinessReport["checks"]["database"] = "ok";
    try {
      await this.database.$queryRaw`SELECT 1`;
    } catch {
      database = "unavailable";
    }
    const authorization = this.authorization.isReady() ? "ok" : "unavailable";
    const report: ReadinessReport = {
      status: database === "ok" && authorization === "ok" ? "ready" : "not_ready",
      checks: { database, authorization, config: "ok" },
      ...(this.config.CONFIG_REVISION ? { configRevision: this.config.CONFIG_REVISION } : {}),
    };
    if (report.status !== "ready") throw new ServiceUnavailableException(report);
    return report;
  }
}

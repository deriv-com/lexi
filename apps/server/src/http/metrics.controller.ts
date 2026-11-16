import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { MetricsRegistry } from "@lexi/metrics";
import { METRICS_REGISTRY_TOKEN } from "../tokens";

/** Prometheus exposition. */
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY_TOKEN) private readonly metrics: MetricsRegistry) {}

  @Get()
  async scrape(@Res() res: { setHeader(name: string, value: string): void; send(body: string): void }): Promise<void> {
    const body = await this.metrics.metrics();
    res.setHeader("Content-Type", this.metrics.contentType);
    res.send(body);
  }
}

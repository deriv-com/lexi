import { describe, it, expect } from "vitest";
import { MetricsRegistry } from "./metrics-registry";

describe("MetricsRegistry", () => {
  it("exposes all required metrics in Prometheus text format", async () => {
    const metrics = new MetricsRegistry({ prefix: "lexi_", collectDefault: false });
    metrics.incIssuesProcessed("VERIFIED");
    metrics.incVerificationSuccess("success");
    metrics.incGithubUpdate("add_labels");
    metrics.incSlackNotification("VERIFIED");
    metrics.incQuickFixOutcome("shipped", "slack");
    metrics.observeWorkflowDuration("ai_analysis", 1.23);
    metrics.setQueueDepth("reproduction", 4);

    const output = await metrics.metrics();
    expect(output).toContain("lexi_issues_processed_total");
    expect(output).toContain("lexi_verification_success_total");
    expect(output).toContain("lexi_github_updates_total");
    expect(output).toContain("lexi_slack_notifications_total");
    expect(output).toContain("lexi_quick_fix_outcomes_total");
    expect(output).toContain("lexi_workflow_duration_seconds");
    expect(output).toContain("lexi_queue_depth");
  });

  it("keeps direct-fix outcomes separable by outcome and dispatch path", async () => {
    // The split is the point of the metric: the Slack and unattended
    // dispatchers build their briefs differently, so a blended series would
    // hide whichever path is worse behind whichever path is busier.
    const metrics = new MetricsRegistry({ prefix: "lexi_", collectDefault: false });
    metrics.incQuickFixOutcome("shipped", "unattended");
    metrics.incQuickFixOutcome("handback", "slack");
    metrics.incQuickFixOutcome("handback", "slack");

    const output = await metrics.metrics();
    expect(output).toContain('lexi_quick_fix_outcomes_total{outcome="shipped",path="unattended"} 1');
    expect(output).toContain('lexi_quick_fix_outcomes_total{outcome="handback",path="slack"} 2');
  });

  it("reports the correct Prometheus content type", () => {
    const metrics = new MetricsRegistry({ collectDefault: false });
    expect(metrics.contentType).toContain("text/plain");
  });
});

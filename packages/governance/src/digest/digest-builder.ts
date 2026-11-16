export interface DigestSection {
  title: string;
  items: string[];
}

export interface DigestReport {
  runId: string;
  generatedAt: string;
  sections: DigestSection[];
  budgetUtilization?: Record<string, { used: number; limit: number }>;
}

/**
 * `null` means "not measured", which is deliberately distinct from `0`.
 * Reporting 0 for an uninstrumented counter tells an operator that nothing
 * happened when in fact nothing was observed — a correctness defect, not a
 * cosmetic one.
 */
export interface DigestInput {
  runId: string;
  scannedCount: number;
  intakeAccepted: number | null;
  intakeRejected: number | null;
  intakeNeedsInfo: number | null;
  triaged: number;
  assigned: number | null;
  duplicateClusters: number | null;
  reproductionOutcomes: Record<string, number> | null;
  pendingClosures: number | null;
  closures: number | null;
  manualReviewQueue: number | null;
  reproductionDegradation: boolean | null;
  quickFixPrs: number | null;
  policyBlocks: number | null;
  reopenSignals: number | null;
  deferredByBudget: number;
}

/** Renders a nullable counter, preserving the not-measured/zero distinction. */
function renderCount(value: number | null): string {
  return value === null ? "not measured" : String(value);
}

/**
 * An empty outcome map is indistinguishable from an uninstrumented one, so both
 * report "not measured" rather than rendering an empty section.
 */
function reproductionItems(outcomes: Record<string, number> | null): string[] {
  const entries = outcomes ? Object.entries(outcomes) : [];
  if (entries.length === 0) {
    return ["not measured"];
  }
  return entries.map(([k, v]) => `${k}: ${v}`);
}

/**
 * Build daily Lexi governance digest for Slack and GitHub rolling issue.
 */
export function buildDigest(input: DigestInput): DigestReport {
  const sections: DigestSection[] = [
    {
      title: "Scan summary",
      items: [
        `Scanned: ${input.scannedCount}`,
        `Intake accepted: ${renderCount(input.intakeAccepted)}`,
        `Intake rejected: ${renderCount(input.intakeRejected)}`,
        `Intake needs-info: ${renderCount(input.intakeNeedsInfo)}`,
      ],
    },
    {
      title: "Backlog actions",
      items: [
        `Triaged: ${input.triaged}`,
        `Assigned: ${renderCount(input.assigned)}`,
        `Duplicate clusters: ${renderCount(input.duplicateClusters)}`,
        `Closures: ${renderCount(input.closures)}`,
        `Pending closures: ${renderCount(input.pendingClosures)}`,
      ],
    },
    {
      title: "Reproduction",
      items: reproductionItems(input.reproductionOutcomes),
    },
    {
      title: "Queues and risk",
      items: [
        `Manual review queue: ${renderCount(input.manualReviewQueue)}`,
        `Reproduction degradation: ${input.reproductionDegradation === null ? "not measured" : input.reproductionDegradation ? "yes" : "no"}`,
        `Quick-fix PRs: ${renderCount(input.quickFixPrs)}`,
        `Policy blocks: ${renderCount(input.policyBlocks)}`,
        `Reopen signals: ${renderCount(input.reopenSignals)}`,
        `Deferred by budget: ${input.deferredByBudget}`,
      ],
    },
  ];

  return {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    sections,
  };
}

export function formatDigestMarkdown(report: DigestReport): string {
  const lines = [`# Lexi Daily Digest`, `Run: ${report.runId}`, `Generated: ${report.generatedAt}`, ""];
  for (const section of report.sections) {
    lines.push(`## ${section.title}`);
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  if (report.budgetUtilization) {
    lines.push("## Budget utilization");
    for (const [action, usage] of Object.entries(report.budgetUtilization)) {
      lines.push(`- ${action}: ${usage.used}/${usage.limit}`);
    }
  }
  return lines.join("\n");
}

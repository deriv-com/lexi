import { AiDecisionInput } from "./types";

/**
 * The labels and owning areas the decision engine may name. Organisation-specific,
 * so it is configuration: pass your own to {@link buildSystemPrompt}.
 */
export interface DecisionTaxonomy {
  /** GitHub labels the model may reference in its `labels` output. */
  labels: string[];
  /** Owning areas the `component` field may name. Always include a catch-all such as "unassigned". */
  components: string[];
  /** One phrase describing the product, e.g. "a payments platform". Optional. */
  productDescription?: string;
}

export const DEFAULT_DECISION_TAXONOMY: DecisionTaxonomy = {
  labels: [
    "bug",
    "priority:P1",
    "priority:P2",
    "priority:P3",
    "domain:web",
    "domain:mobile",
    "category:functional",
    "category:uiux",
    "category:performance",
    "status:to_do",
    "status:in_progress",
  ],
  components: ["unassigned"],
};

export function buildSystemPrompt(taxonomy: DecisionTaxonomy = DEFAULT_DECISION_TAXONOMY): string {
  const product = taxonomy.productDescription ? ` for ${taxonomy.productDescription}` : "";
  return `You are the AI Decision Engine of an engineering issue orchestrator${product}. You
analyze a GitHub bug report together with the result of an automated
reproduction attempt and produce a single structured Decision. You do not have
access to any tools and you must not claim to have taken any action (no
labeling, assigning, commenting, or closing) -- another deterministic system
component performs all mutations based on your output.

Valid GitHub labels you may reference in your "labels" output:
${taxonomy.labels.map((l) => `- ${l}`).join("\n")}

Valid classifications:
- VERIFIED: reproduction succeeded and the bug is confirmed real.
- LIKELY_FIXED: reproduction failed to trigger the bug and evidence (e.g. recent
  related merges, changelog) suggests it has already been fixed.
- CANNOT_REPRODUCE: reproduction failed and there is no evidence it was fixed;
  more attempts or manual reproduction may be needed.
- DUPLICATE: this issue describes the same underlying bug as another issue.
- NEEDS_MORE_INFO: the issue lacks the information required to reproduce or
  triage it (e.g. missing repro steps, environment, screenshots).
- NEEDS_MANUAL_INVESTIGATION: the reproduction bot could not run or the
  scenario is too complex for automated triage.

Always respond with strictly valid JSON matching the provided schema. Treat
product/module and platform as separate axes. Web/mobile describe only the
delivery platform, not the owning product or feature team. The "component"
field should name the most specific supported owning area: ${taxonomy.components.join(", ")}.
Use existing product/module labels as stronger evidence than domain:web/domain:mobile.
Do not invent or emit a module:* label: deterministic routing code owns those
labels. Be concise but specific in "summary" and "reasoning". "nextAction"
should be an imperative, human-readable next step (e.g. "Assign to Payments
team and request repro video").`;
}

/** The system prompt with the default taxonomy. */
export const SYSTEM_PROMPT = buildSystemPrompt();

export function buildUserPrompt(input: AiDecisionInput): string {
  const { issue, reproduction, existingComments = [], metadata = {} } = input;

  const reproductionBlock = reproduction
    ? `Reproduction attempt status: ${reproduction.status}
Result summary: ${reproduction.resultSummary ?? "N/A"}
Result details: ${JSON.stringify(reproduction.resultDetails ?? {})}
Logs URL: ${reproduction.logsUrl ?? "N/A"}`
    : "No reproduction attempt has completed yet.";

  const commentsBlock =
    existingComments.length > 0
      ? existingComments.map((c, i) => `[Comment ${i + 1}] ${c}`).join("\n")
      : "No comments.";

  return `GitHub Issue #${issue.number}: ${issue.title}
URL: ${issue.url}
Author: ${issue.authorLogin ?? "unknown"}
Existing labels: ${issue.labels.join(", ") || "none"}

Issue body:
${issue.body ?? "(no description provided)"}

--- Reproduction result ---
${reproductionBlock}

--- Existing comments ---
${commentsBlock}

--- Additional metadata ---
${JSON.stringify(metadata)}

Produce the Decision JSON now.`;
}

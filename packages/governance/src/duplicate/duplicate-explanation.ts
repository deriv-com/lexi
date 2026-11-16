/**
 * Lexi conversational explanation of duplicate reasoning.
 *
 * Transforms raw adjudication results into human-friendly explanations
 * that Lexi can communicate in Slack threads. Explains:
 * - Why the issue was flagged as a potential duplicate
 * - What signals overlap between the issues
 * - What the confidence level means
 * - What happens next (auto-close, human review, or reporter rejection)
 * - How the reporter can dispute the decision
 */

import type { DuplicateCandidateDecision } from "./adjudication";
import type { SemanticIndexHealth } from "./semantic-index";
import type { HybridRetrievalResult } from "./hybrid-retrieval";

export interface DuplicateExplanationInput {
  decision: DuplicateCandidateDecision;
  retrievalResult: HybridRetrievalResult;
  semanticHealth: SemanticIndexHealth;
  canonicalTitle: string;
  canonicalUrl: string;
  action: "REJECT_DUPLICATE" | "NEEDS_HUMAN_ADJUDICATION" | "CREATE_WITH_REVIEW" | "CREATE_NEW";
  consolidationPerformed: boolean;
}

/**
 * Generate a conversational explanation for Lexi to present in Slack.
 */
export function generateDuplicateExplanation(input: DuplicateExplanationInput): string {
  const { decision, retrievalResult, semanticHealth, canonicalTitle, canonicalUrl, action } = input;
  const parts: string[] = [];

  // Header
  if (action === "REJECT_DUPLICATE") {
    parts.push(
      `I've identified this as a duplicate of *<${canonicalUrl}|#${decision.issueNumber}: ${canonicalTitle}>* (${formatConfidence(decision.confidence)} confidence).`,
    );
  } else if (action === "NEEDS_HUMAN_ADJUDICATION") {
    parts.push(
      `I found a possible match: *<${canonicalUrl}|#${decision.issueNumber}: ${canonicalTitle}>* (${formatConfidence(decision.confidence)} confidence). A reviewer will confirm.`,
    );
  } else if (action === "CREATE_WITH_REVIEW") {
    parts.push(
      `I noticed some similarity with *<${canonicalUrl}|#${decision.issueNumber}: ${canonicalTitle}>*, but I'm not confident enough to call it a duplicate (${formatConfidence(decision.confidence)} confidence).`,
    );
  }

  // Evidence
  if (decision.overlappingSignals.length > 0) {
    parts.push(
      `\n*Shared signals:* ${decision.overlappingSignals.slice(0, 5).map((s) => `\`${s}\``).join(", ")}`,
    );
  }

  if (decision.differingSignals.length > 0) {
    parts.push(
      `*Differences:* ${decision.differingSignals.slice(0, 3).map((s) => `\`${s}\``).join(", ")}`,
    );
  }

  // Retrieval transparency
  const sources = retrievalResult.candidates.find((c) => c.issueNumber === decision.issueNumber)?.sources ?? [];
  if (sources.length > 0) {
    const sourceNames = sources.map((s) => {
      switch (s) {
        case "structured": return "exact signal match";
        case "lexical": return "keyword overlap";
        case "semantic": return "meaning similarity";
        default: return s;
      }
    });
    parts.push(`\n_Found via: ${sourceNames.join(", ")}_`);
  }

  // Semantic health note
  if (semanticHealth.status !== "operational") {
    parts.push(`\n⚠️ _Semantic search was not available for this analysis. Duplicate detection relied on keyword matching only._`);
  }

  // Next steps
  if (action === "REJECT_DUPLICATE") {
    parts.push(`\n*What happens next:*`);
    if (input.consolidationPerformed) {
      parts.push(`• Unique information from your report has been preserved on the canonical issue.`);
    }
    parts.push(`• This issue will be closed as a duplicate.`);
    parts.push(`• If you believe this is _not_ a duplicate, react with ❌ or reply "not a duplicate" with your reasoning.`);
  } else if (action === "NEEDS_HUMAN_ADJUDICATION") {
    parts.push(`\n*What happens next:*`);
    parts.push(`• A team member will review and confirm or reject the duplicate match.`);
    parts.push(`• Your issue remains open until a decision is made.`);
    parts.push(`• You can also weigh in — reply "not a duplicate" if you disagree.`);
  }

  return parts.join("\n");
}

/**
 * Generate a brief explanation for the duplicate reasoning (for GitHub comments).
 */
export function generateDuplicateCommentBody(input: {
  sourceNumber: number;
  canonicalNumber: number;
  confidence: number;
  reasoning: string;
  overlappingSignals: string[];
}): string {
  return `## Duplicate Detection

This issue appears to be a duplicate of #${input.canonicalNumber} (${formatConfidence(input.confidence)} confidence).

**Reasoning:** ${input.reasoning}

${input.overlappingSignals.length > 0 ? `**Shared signals:** ${input.overlappingSignals.slice(0, 5).join(", ")}` : ""}

---
_Identified by Lexi duplicate intelligence. If this is incorrect, comment "not a duplicate" with your reasoning._`;
}

/**
 * Generate explanation for a replay/audit report.
 */
export function generateReplayExplanation(input: {
  retrievalResult: HybridRetrievalResult;
  decisions: DuplicateCandidateDecision[];
  semanticHealth: SemanticIndexHealth;
  action: string;
}): string {
  const lines: string[] = [];

  lines.push(`## Duplicate Detection Replay`);
  lines.push(``);
  lines.push(`### Retrieval`);
  lines.push(`- Structured matches: ${input.retrievalResult.tierResults.structured.length}`);
  lines.push(`- Lexical matches: ${input.retrievalResult.tierResults.lexical.length}`);
  lines.push(`- Semantic matches: ${input.retrievalResult.tierResults.semantic.length}`);
  lines.push(`- Merged candidates: ${input.retrievalResult.candidates.length}`);
  lines.push(`- Semantic health: ${input.semanticHealth.status} (${input.semanticHealth.detail})`);
  lines.push(``);
  lines.push(`### Adjudication`);

  for (const d of input.decisions) {
    lines.push(`- #${d.issueNumber}: ${d.verdict} (${formatConfidence(d.confidence)}) — ${d.reasoning.slice(0, 100)}`);
  }

  lines.push(``);
  lines.push(`### Outcome: ${input.action}`);

  return lines.join("\n");
}

function formatConfidence(confidence: number): string {
  return `${(confidence * 100).toFixed(0)}%`;
}

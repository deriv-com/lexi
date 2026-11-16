import type { SpecStatus } from "@lexi/contracts";

/**
 * The spec lifecycle, as its own small machine.
 *
 * Deliberately NOT an extension of the 20-state bug workflow. A spec is not a
 * defect: it has no reproduction, no retest, and no severity, and folding it
 * into that machine would drag all three along with it. Work items *reference*
 * the bug workflow; they do not replace it, and neither does this.
 *
 * Same shape as `WorkflowStateMachine` — an explicit adjacency list, purely
 * functional, callers hold the current status and ask before persisting — and
 * the same generated-Mermaid pattern, so the committed diagram cannot drift
 * from the transitions the runtime actually permits.
 */

export const ALL_SPEC_STATUSES = [
  "DRAFTING",
  "DRAFT_READY",
  "IN_REVIEW",
  "APPROVED",
  "CHANGES_REQUESTED",
  "REJECTED",
  "SUPERSEDED",
] as const satisfies readonly SpecStatus[];

const TRANSITIONS: Record<SpecStatus, SpecStatus[]> = {
  // The clarification loop lives here. DRAFT_READY is reached only through
  // isReadyToDraft(), which is deterministic code, not a model judgement.
  DRAFTING: ["DRAFT_READY"],
  // Submitting for review is a separate, deliberate act: a draft being ready
  // is not the same as someone asking for a decision on it.
  DRAFT_READY: ["IN_REVIEW", "DRAFTING"],
  // Only a human Slack interaction can drive IN_REVIEW -> APPROVED; approve_spec
  // is withheld from the model payload entirely. The machine permits the
  // edge, authorization decides who may walk it.
  IN_REVIEW: ["APPROVED", "CHANGES_REQUESTED", "REJECTED"],
  // Feedback loops straight back to drafting rather than to a fresh session, so
  // the coverage record and its answers survive the round trip.
  CHANGES_REQUESTED: ["DRAFTING"],
  // An approved spec is referenceable by trigger_code_task. It can only be
  // retired by a newer revision superseding it — never edited back into review,
  // which would let an approved reference silently change underneath the work
  // that cited it.
  APPROVED: ["SUPERSEDED"],
  // Terminal. A rejected idea comes back as a new spec, not as a revival, so
  // the rejection stays on the record.
  REJECTED: [],
  SUPERSEDED: [],
};

export class InvalidSpecTransitionError extends Error {
  constructor(from: SpecStatus, to: SpecStatus) {
    super(`Invalid spec transition: ${from} -> ${to}`);
    this.name = "InvalidSpecTransitionError";
  }
}

export class SpecStateMachine {
  canTransition(from: SpecStatus, to: SpecStatus): boolean {
    // Re-applying the current status is a no-op, which keeps every persistence
    // path safe to retry.
    if (from === to) {
      return true;
    }
    return TRANSITIONS[from]?.includes(to) ?? false;
  }

  assertTransition(from: SpecStatus, to: SpecStatus): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidSpecTransitionError(from, to);
    }
  }

  nextStates(from: SpecStatus): SpecStatus[] {
    return TRANSITIONS[from] ?? [];
  }

  isTerminal(status: SpecStatus): boolean {
    // APPROVED is deliberately not terminal: it is the *useful* state, and it
    // still has one legal exit when a newer revision replaces it.
    return status === "REJECTED" || status === "SUPERSEDED";
  }
}

export interface SpecGraphEdge {
  from: SpecStatus;
  to: SpecStatus;
}

export interface SpecGraph {
  states: SpecStatus[];
  edges: SpecGraphEdge[];
  terminalStates: SpecStatus[];
}

/** Derives the graph from the live machine rather than a hand-maintained copy. */
export function buildSpecGraph(machine = new SpecStateMachine()): SpecGraph {
  const states = [...ALL_SPEC_STATUSES];
  const edges: SpecGraphEdge[] = [];

  for (const from of states) {
    for (const to of machine.nextStates(from)) {
      edges.push({ from, to });
    }
  }

  return { states, edges, terminalStates: states.filter((state) => machine.isTerminal(state)) };
}

export function renderSpecMermaid(graph: SpecGraph = buildSpecGraph()): string {
  const lines: string[] = [];
  lines.push("```mermaid");
  lines.push("flowchart TD");

  for (const edge of graph.edges) {
    lines.push(`    ${edge.from} --> ${edge.to}`);
  }

  if (graph.terminalStates.length > 0) {
    lines.push("");
    for (const state of graph.terminalStates) {
      lines.push(`    class ${state} terminalState;`);
    }
    lines.push("    classDef terminalState stroke-width:3px;");
  }

  lines.push("```");
  return lines.join("\n");
}

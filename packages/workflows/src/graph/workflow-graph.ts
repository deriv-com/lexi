import { WorkflowStatus } from "@lexi/database";
import { WorkflowStateMachine } from "../workflow-state-machine";

/**
 * Derives the workflow graph from the **live** state machine rather than a
 * hand-maintained copy.
 *
 * Hand-drawn Mermaid diagrams silently drift from the real `TRANSITIONS`
 * adjacency list (and from the `WorkflowStatus` enum in schema.prisma).
 * Everything here is computed by asking `WorkflowStateMachine.nextStates()`
 * for every enum value, so the documentation cannot describe a transition the
 * runtime does not permit — and `applyWorkflowGraphSection` reports drift when
 * a committed document falls behind.
 *
 * This is documentation generation only. It adds no new runtime concept and
 * does not change any transition.
 */

export interface WorkflowGraphEdge {
  from: WorkflowStatus;
  to: WorkflowStatus;
}

export interface WorkflowGraph {
  states: WorkflowStatus[];
  edges: WorkflowGraphEdge[];
  terminalStates: WorkflowStatus[];
  /**
   * States reachable from (nearly) every other state — `FAILED` and
   * `CANCELLED` in v1.0. Rendering all ~19 inbound edges for these produces an
   * unreadable hairball, so they are summarized in a note instead of drawn.
   */
  universalTargets: WorkflowStatus[];
  /** States that can restart a fresh cycle by returning to QUEUED. */
  requeueableStates: WorkflowStatus[];
}

/** A target is "universal" when at least this fraction of states can reach it. */
const UNIVERSAL_TARGET_THRESHOLD = 0.6;

export const ALL_WORKFLOW_STATES: WorkflowStatus[] = Object.values(WorkflowStatus);

export function buildWorkflowGraph(machine = new WorkflowStateMachine()): WorkflowGraph {
  const states = [...ALL_WORKFLOW_STATES];
  const edges: WorkflowGraphEdge[] = [];
  const inboundCount = new Map<WorkflowStatus, number>();

  for (const from of states) {
    for (const to of machine.nextStates(from)) {
      edges.push({ from, to });
      inboundCount.set(to, (inboundCount.get(to) ?? 0) + 1);
    }
  }

  const universalTargets = states.filter(
    (state) => (inboundCount.get(state) ?? 0) >= states.length * UNIVERSAL_TARGET_THRESHOLD,
  );

  const terminalStates = states.filter((state) => machine.isTerminal(state));

  // Uses nextStates (not canTransition) because canTransition short-circuits
  // `from === to` to true, which would list QUEUED as trivially re-queueable.
  const requeueableStates = states.filter(
    (state) => state !== WorkflowStatus.NEW && machine.nextStates(state).includes(WorkflowStatus.QUEUED),
  );

  return { states, edges, terminalStates, universalTargets, requeueableStates };
}

/**
 * Renders the graph as a Mermaid flowchart. Universal targets (FAILED /
 * CANCELLED) are declared but their inbound edges are summarized in text,
 * keeping the diagram legible while remaining accurate.
 */
export function renderWorkflowMermaid(graph: WorkflowGraph = buildWorkflowGraph()): string {
  const lines: string[] = [];
  lines.push("```mermaid");
  lines.push("flowchart TD");

  const universal = new Set(graph.universalTargets);
  const terminal = new Set(graph.terminalStates);

  const drawnEdges = graph.edges.filter((edge) => !universal.has(edge.to));

  for (const edge of drawnEdges) {
    lines.push(`    ${edge.from} --> ${edge.to}`);
  }

  if (graph.universalTargets.length > 0) {
    lines.push("");
    for (const target of graph.universalTargets) {
      lines.push(`    ${target}["${target}<br/>(reachable from nearly every state)"]`);
    }
  }

  if (terminal.size > 0) {
    lines.push("");
    for (const state of graph.terminalStates) {
      lines.push(`    class ${state} terminalState;`);
    }
    lines.push("    classDef terminalState stroke-width:3px;");
  }

  lines.push("```");
  return lines.join("\n");
}

/** Human-readable summary of the facts the diagram deliberately omits. */
export function renderWorkflowGraphNotes(graph: WorkflowGraph = buildWorkflowGraph()): string {
  const lines: string[] = [];
  lines.push(
    `- **${graph.states.length} states**, **${graph.edges.length} legal transitions** (guarded by \`WorkflowStateMachine.assertTransition\`).`,
  );
  if (graph.universalTargets.length > 0) {
    lines.push(
      `- ${graph.universalTargets
        .map((s) => `\`${s}\``)
        .join(" and ")} are reachable from nearly every state and are drawn without inbound edges for legibility.`,
    );
  }
  lines.push(`- Terminal states: ${graph.terminalStates.map((s) => `\`${s}\``).join(", ")}.`);
  lines.push(
    `- Re-queueable states (start a fresh cycle): ${graph.requeueableStates.map((s) => `\`${s}\``).join(", ")}.`,
  );
  return lines.join("\n");
}

export const WORKFLOW_GRAPH_BEGIN_MARKER = "<!-- BEGIN GENERATED WORKFLOW GRAPH -->";
export const WORKFLOW_GRAPH_END_MARKER = "<!-- END GENERATED WORKFLOW GRAPH -->";

/** The full marker-delimited block written into a Markdown document. */
export function renderWorkflowGraphSection(graph: WorkflowGraph = buildWorkflowGraph()): string {
  return [
    WORKFLOW_GRAPH_BEGIN_MARKER,
    "",
    "<!-- Generated from the workflow state machine. Do not edit by hand — edit TRANSITIONS in",
    "     packages/workflows/src/workflow-state-machine.ts and regenerate. -->",
    "",
    renderWorkflowMermaid(graph),
    "",
    renderWorkflowGraphNotes(graph),
    "",
    WORKFLOW_GRAPH_END_MARKER,
  ].join("\n");
}

export interface WorkflowGraphSyncResult {
  inSync: boolean;
  reason?: string;
  updatedContent?: string;
}

/**
 * Replaces the marker-delimited region of `markdown` with the freshly
 * generated section. Used both by the generator script (to write) and the
 * drift test (to compare).
 */
export function applyWorkflowGraphSection(
  markdown: string,
  graph: WorkflowGraph = buildWorkflowGraph(),
): WorkflowGraphSyncResult {
  const beginIndex = markdown.indexOf(WORKFLOW_GRAPH_BEGIN_MARKER);
  const endIndex = markdown.indexOf(WORKFLOW_GRAPH_END_MARKER);

  if (beginIndex === -1 || endIndex === -1) {
    return {
      inSync: false,
      reason: `Missing ${WORKFLOW_GRAPH_BEGIN_MARKER} / ${WORKFLOW_GRAPH_END_MARKER} markers.`,
    };
  }
  if (endIndex < beginIndex) {
    return { inSync: false, reason: "Workflow graph end marker appears before the begin marker." };
  }

  const before = markdown.slice(0, beginIndex);
  const after = markdown.slice(endIndex + WORKFLOW_GRAPH_END_MARKER.length);
  const updatedContent = `${before}${renderWorkflowGraphSection(graph)}${after}`;

  return {
    inSync: updatedContent === markdown,
    reason: updatedContent === markdown ? undefined : "Generated workflow graph differs from committed docs.",
    updatedContent,
  };
}

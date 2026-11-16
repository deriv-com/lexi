import { describe, it, expect } from "vitest";
import { WorkflowStatus } from "@lexi/database";
import { WorkflowStateMachine } from "../workflow-state-machine";
import {
  ALL_WORKFLOW_STATES,
  applyWorkflowGraphSection,
  buildWorkflowGraph,
  renderWorkflowGraphNotes,
  renderWorkflowGraphSection,
  renderWorkflowMermaid,
} from "./workflow-graph";

describe("buildWorkflowGraph", () => {
  it("derives every state from the WorkflowStatus enum", () => {
    const graph = buildWorkflowGraph();
    expect(graph.states).toEqual(ALL_WORKFLOW_STATES);
    // Guards against the enum growing without the graph noticing.
    expect(graph.states).toContain(WorkflowStatus.WRITE_BLOCKED);
    expect(graph.states).toContain(WorkflowStatus.CLOSE_RECOMMENDED);
  });

  it("derives edges from the live state machine, not a duplicated table", () => {
    const machine = new WorkflowStateMachine();
    const graph = buildWorkflowGraph(machine);

    for (const edge of graph.edges) {
      expect(machine.canTransition(edge.from, edge.to)).toBe(true);
    }

    // And every legal transition is represented — no silent omissions.
    const edgeKeys = new Set(graph.edges.map((e) => `${e.from}->${e.to}`));
    for (const from of ALL_WORKFLOW_STATES) {
      for (const to of machine.nextStates(from)) {
        expect(edgeKeys.has(`${from}->${to}`)).toBe(true);
      }
    }
  });

  it("identifies FAILED and CANCELLED as universal targets", () => {
    const graph = buildWorkflowGraph();
    expect(graph.universalTargets).toContain(WorkflowStatus.CANCELLED);
    expect(graph.universalTargets).toContain(WorkflowStatus.FAILED);
  });

  it("reports the real terminal states", () => {
    const graph = buildWorkflowGraph();
    expect(graph.terminalStates).toEqual([WorkflowStatus.CLOSED, WorkflowStatus.CANCELLED]);
  });
});

describe("renderWorkflowMermaid", () => {
  it("emits a mermaid flowchart block", () => {
    const mermaid = renderWorkflowMermaid();
    expect(mermaid.startsWith("```mermaid")).toBe(true);
    expect(mermaid).toContain("flowchart TD");
    expect(mermaid.trimEnd().endsWith("```")).toBe(true);
  });

  it("draws real pipeline edges", () => {
    const mermaid = renderWorkflowMermaid();
    expect(mermaid).toContain("QUEUED --> SENT_TO_REPRODUCTION");
    expect(mermaid).toContain("AI_ANALYSIS --> VERIFIED");
  });

  it("omits inbound edges to universal targets for legibility but still declares them", () => {
    const mermaid = renderWorkflowMermaid();
    expect(mermaid).not.toContain("QUEUED --> FAILED");
    expect(mermaid).toContain("FAILED[");
  });

  it("summarizes the omitted facts in the notes instead of hiding them", () => {
    const notes = renderWorkflowGraphNotes();
    expect(notes).toMatch(/legal transitions/);
    expect(notes).toContain("`FAILED`");
    expect(notes).toContain("Terminal states");
  });
});

describe("workflow graph drift detection", () => {
  // A document that embeds the generated section, as a project's architecture
  // doc would. Regenerating it must be a no-op.
  const doc = `# Architecture\n\nIntro.\n\n${renderWorkflowGraphSection()}\n\nTrailer.\n`;

  it("reports a freshly generated section as in sync with the live WorkflowStateMachine", () => {
    const result = applyWorkflowGraphSection(doc);
    expect(result.inSync, result.reason).toBe(true);
  });

  it("fails loudly when the markers are missing rather than silently doing nothing", () => {
    const result = applyWorkflowGraphSection("# Docs with no markers\n");
    expect(result.inSync).toBe(false);
    expect(result.reason).toMatch(/Missing/);
    expect(result.updatedContent).toBeUndefined();
  });

  it("detects a hand-edited diagram as drift", () => {
    const tampered = doc.replace("QUEUED --> SENT_TO_REPRODUCTION", "QUEUED --> CLOSED_BY_HAND");
    // Only meaningful if the replace actually hit something.
    expect(tampered).not.toBe(doc);
    expect(applyWorkflowGraphSection(tampered).inSync).toBe(false);
  });
});

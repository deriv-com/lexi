import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_WORK_ITEM_STATUSES, WorkItemStateMachine } from "../work-item-state-machine";
import {
  applyWorkItemGraphSection,
  buildWorkItemGraph,
  renderWorkItemGraphNotes,
  renderWorkItemMermaid,
  WORK_ITEM_GRAPH_BEGIN_MARKER,
  WORK_ITEM_GRAPH_END_MARKER,
} from "./work-item-graph";

/**
 * Same generated-Mermaid-fails-build pattern as
 * `packages/workflows/src/graph/workflow-graph.spec.ts`: the diagram is
 * derived from the live machine, and the committed doc is compared against a
 * fresh render so hand-editing either one fails the build.
 */
describe("buildWorkItemGraph", () => {
  it("derives every state from the frozen status list", () => {
    expect(buildWorkItemGraph().states).toEqual([...ALL_WORK_ITEM_STATUSES]);
  });

  it("derives edges from the live state machine, not a duplicated table", () => {
    const machine = new WorkItemStateMachine();
    const graph = buildWorkItemGraph(machine);

    for (const edge of graph.edges) {
      expect(machine.canTransition(edge.from, edge.to)).toBe(true);
    }

    const edgeKeys = new Set(graph.edges.map((e) => `${e.from}->${e.to}`));
    for (const from of ALL_WORK_ITEM_STATUSES) {
      for (const to of machine.nextStates(from)) {
        expect(edgeKeys.has(`${from}->${to}`), `${from}->${to} missing from graph`).toBe(true);
      }
    }
  });

  it("identifies CANCELLED as the universal target", () => {
    expect(buildWorkItemGraph().universalTargets).toContain("CANCELLED");
  });

  it("reports VERIFIED and CANCELLED as terminal", () => {
    expect(buildWorkItemGraph().terminalStates).toEqual(["VERIFIED", "CANCELLED"]);
  });
});

describe("renderWorkItemMermaid", () => {
  it("emits a mermaid flowchart block", () => {
    const mermaid = renderWorkItemMermaid();
    expect(mermaid.startsWith("```mermaid")).toBe(true);
    expect(mermaid).toContain("flowchart TD");
    expect(mermaid.trimEnd().endsWith("```")).toBe(true);
  });

  it("draws the real lifecycle edges", () => {
    const mermaid = renderWorkItemMermaid();
    expect(mermaid).toContain("PROPOSED --> CLARIFYING");
    expect(mermaid).toContain("DELIVERED --> VERIFIED");
  });

  it("omits inbound edges to the universal target but still declares it", () => {
    const mermaid = renderWorkItemMermaid();
    expect(mermaid).not.toContain("PROPOSED --> CANCELLED");
    expect(mermaid).toContain("CANCELLED[");
  });

  it("summarizes the omitted facts in the notes instead of hiding them", () => {
    const notes = renderWorkItemGraphNotes();
    expect(notes).toMatch(/legal transitions/);
    expect(notes).toContain("`CANCELLED`");
    expect(notes).toContain("Terminal states");
  });
});

describe("WORK_ITEM_LIFECYCLE.md drift", () => {
  const docPath = resolve(__dirname, "../../WORK_ITEM_LIFECYCLE.md");

  it("is in sync with the live WorkItemStateMachine", () => {
    const markdown = readFileSync(docPath, "utf8");
    const result = applyWorkItemGraphSection(markdown);

    expect(
      result.inSync,
      `${result.reason ?? "drift detected"} — run \`npm run graph:workitem -w @lexi/workitems\` to regenerate.`,
    ).toBe(true);
  });

  it("fails loudly when the markers are missing rather than silently doing nothing", () => {
    const result = applyWorkItemGraphSection("# Docs with no markers\n");
    expect(result.inSync).toBe(false);
    expect(result.reason).toMatch(/Missing/);
    expect(result.updatedContent).toBeUndefined();
  });

  it("detects a hand-edited diagram as drift", () => {
    const markdown = readFileSync(docPath, "utf8");
    const tampered = markdown.replace("PROPOSED --> CLARIFYING", "PROPOSED --> SHIPPED_BY_HAND");
    expect(tampered).not.toBe(markdown);
    expect(applyWorkItemGraphSection(tampered).inSync).toBe(false);
  });

  it("exports both markers so the generator script and the test agree", () => {
    expect(WORK_ITEM_GRAPH_BEGIN_MARKER).toContain("BEGIN");
    expect(WORK_ITEM_GRAPH_END_MARKER).toContain("END");
  });
});

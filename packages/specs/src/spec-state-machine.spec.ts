import { describe, it, expect } from "vitest";
import type { SpecStatus } from "@lexi/contracts";
import {
  ALL_SPEC_STATUSES,
  buildSpecGraph,
  InvalidSpecTransitionError,
  renderSpecMermaid,
  SpecStateMachine,
} from "./spec-state-machine";

/**
 * The spec lifecycle, as its own small machine. It deliberately does
 * NOT extend the 20-state bug workflow: a spec is not a defect, and folding it
 * into that machine is what would sweep it into reproduction and retest.
 *
 * Same generated-Mermaid pattern as `workflow-graph.ts` — the diagram is
 * derived from the live adjacency list so documentation cannot describe a
 * transition the runtime forbids.
 */

const machine = new SpecStateMachine();

describe("spec statuses", () => {
  it("enumerates the seven frozen statuses", () => {
    const statuses: SpecStatus[] = [...ALL_SPEC_STATUSES];

    expect(statuses).toEqual([
      "DRAFTING",
      "DRAFT_READY",
      "IN_REVIEW",
      "APPROVED",
      "CHANGES_REQUESTED",
      "REJECTED",
      "SUPERSEDED",
    ]);
  });
});

describe("the happy path", () => {
  it("walks DRAFTING -> DRAFT_READY -> IN_REVIEW -> APPROVED", () => {
    expect(machine.canTransition("DRAFTING", "DRAFT_READY")).toBe(true);
    expect(machine.canTransition("DRAFT_READY", "IN_REVIEW")).toBe(true);
    expect(machine.canTransition("IN_REVIEW", "APPROVED")).toBe(true);
  });

  it("allows review to end in changes requested or rejection", () => {
    expect(machine.canTransition("IN_REVIEW", "CHANGES_REQUESTED")).toBe(true);
    expect(machine.canTransition("IN_REVIEW", "REJECTED")).toBe(true);
  });

  it("returns a changes-requested spec to drafting", () => {
    expect(machine.canTransition("CHANGES_REQUESTED", "DRAFTING")).toBe(true);
  });

  it("supersedes an approved spec when a newer revision replaces it", () => {
    expect(machine.canTransition("APPROVED", "SUPERSEDED")).toBe(true);
  });
});

describe("the paths that must not exist", () => {
  it("cannot approve straight from drafting — review is not optional", () => {
    expect(machine.canTransition("DRAFTING", "APPROVED")).toBe(false);
  });

  it("cannot approve a spec that was never submitted for review", () => {
    expect(machine.canTransition("DRAFT_READY", "APPROVED")).toBe(false);
  });

  it("cannot un-reject a spec — a new one supersedes it instead", () => {
    expect(machine.nextStates("REJECTED")).toEqual([]);
  });

  it("cannot revive a superseded spec", () => {
    expect(machine.nextStates("SUPERSEDED")).toEqual([]);
  });

  it("cannot move an approved spec back into review", () => {
    expect(machine.canTransition("APPROVED", "IN_REVIEW")).toBe(false);
    expect(machine.canTransition("APPROVED", "DRAFTING")).toBe(false);
  });
});

describe("transition assertions", () => {
  it("treats a self-transition as legal so persistence stays idempotent", () => {
    expect(machine.canTransition("IN_REVIEW", "IN_REVIEW")).toBe(true);
  });

  it("throws a named error on an illegal move", () => {
    expect(() => machine.assertTransition("DRAFTING", "APPROVED")).toThrow(InvalidSpecTransitionError);
    expect(() => machine.assertTransition("DRAFTING", "APPROVED")).toThrow(
      /Invalid spec transition: DRAFTING -> APPROVED/,
    );
  });

  it("does not throw on a legal move", () => {
    expect(() => machine.assertTransition("DRAFTING", "DRAFT_READY")).not.toThrow();
  });
});

describe("terminal states", () => {
  it("treats REJECTED and SUPERSEDED as terminal", () => {
    expect(machine.isTerminal("REJECTED")).toBe(true);
    expect(machine.isTerminal("SUPERSEDED")).toBe(true);
  });

  it("does not treat APPROVED as terminal — it can still be superseded", () => {
    expect(machine.isTerminal("APPROVED")).toBe(false);
  });
});

describe("generated Mermaid", () => {
  it("derives every edge from the live adjacency list", () => {
    const graph = buildSpecGraph();
    const mermaid = renderSpecMermaid(graph);

    for (const edge of graph.edges) {
      expect(mermaid).toContain(`${edge.from} --> ${edge.to}`);
    }
  });

  it("never renders an edge the machine forbids", () => {
    const mermaid = renderSpecMermaid();
    expect(mermaid).not.toContain("DRAFTING --> APPROVED");
  });

  it("is deterministic so a committed diagram does not churn", () => {
    expect(renderSpecMermaid()).toBe(renderSpecMermaid());
  });

  it("marks terminal states", () => {
    const mermaid = renderSpecMermaid();
    expect(mermaid).toContain("class REJECTED terminalState;");
    expect(mermaid).toContain("class SUPERSEDED terminalState;");
  });
});

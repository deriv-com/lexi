import { describe, it, expect, vi } from "vitest";
import { EngineeringMemoryRecorder } from "./engineering-memory-recorder";
import type { EngineeringKnowledgeGraphService } from "./engineering-knowledge-graph.service";
import type { IssueMemoryService } from "./issue-memory.service";

function graphStub(): EngineeringKnowledgeGraphService {
  return {
    upsertNode: vi.fn(async () => "node-1"),
    addEdge: vi.fn(async () => "edge-1"),
    recordRelation: vi.fn(async () => undefined),
    recordRelease: vi.fn(async () => undefined),
  } as unknown as EngineeringKnowledgeGraphService;
}

function memoryStub(): IssueMemoryService {
  return {
    recordInvestigation: vi.fn(async () => ({})),
  } as unknown as IssueMemoryService;
}

describe("EngineeringMemoryRecorder", () => {
  it("records a workflow decision into issue memory and ownership edge", async () => {
    const graph = graphStub();
    const issueMemory = memoryStub();
    const recorder = new EngineeringMemoryRecorder(graph, issueMemory);

    await recorder.recordWorkflowDecision({
      githubNumber: 856,
      repoOwner: "acme-internal",
      repoName: "issues",
      classification: "VERIFIED",
      confidence: 0.91,
      summary: "Cashier crash reproduced",
      owner: "bob",
      component: "cashier",
    });

    expect(issueMemory.recordInvestigation).toHaveBeenCalled();
    expect(graph.upsertNode).toHaveBeenCalled();
    expect(graph.addEdge).toHaveBeenCalled();
  });

  it("writes a duplicate_of edge", async () => {
    const graph = graphStub();
    const recorder = new EngineeringMemoryRecorder(graph, memoryStub());

    await recorder.recordDuplicate(910, "acme/issues", 856, "acme/issues", 0.9);

    expect(graph.recordRelation).toHaveBeenCalledWith(910, "acme/issues", 856, "acme/issues", "duplicate_of", 0.9);
  });

  it("ignores unsafe issue numbers", async () => {
    const graph = graphStub();
    const issueMemory = memoryStub();
    const recorder = new EngineeringMemoryRecorder(graph, issueMemory);

    await recorder.recordWorkflowDecision({
      githubNumber: -1,
      repoOwner: "acme",
      repoName: "issues",
      classification: "VERIFIED",
      confidence: 1,
      summary: "no",
    });

    expect(issueMemory.recordInvestigation).not.toHaveBeenCalled();
  });
});

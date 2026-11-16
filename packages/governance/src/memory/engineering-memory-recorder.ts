import type { EngineeringKnowledgeGraphService } from "./engineering-knowledge-graph.service";
import type { IssueMemoryService } from "./issue-memory.service";
import type { IssueFact } from "./memory.types";

const MAX_TEXT = 500;

export interface WorkflowMemoryEvent {
  githubNumber: number;
  repoOwner: string;
  repoName: string;
  classification: string;
  confidence: number;
  summary: string;
  owner?: string | null;
  team?: string;
  component?: string;
}

/**
 * Writes workflow and feedback outcomes into the engineering graph and
 * issue memory. Callers must treat failures as non-fatal — memory is
 * advisory and must never fail a governed mutation.
 */
export class EngineeringMemoryRecorder {
  constructor(
    private readonly graph: EngineeringKnowledgeGraphService,
    private readonly issueMemory: IssueMemoryService,
  ) {}

  async recordWorkflowDecision(event: WorkflowMemoryEvent): Promise<void> {
    if (!isSafeIssueNumber(event.githubNumber)) return;
    const repo = repoKey(event.repoOwner, event.repoName);

    const facts: IssueFact[] = [
      {
        key: "classification",
        value: event.classification.slice(0, 80),
        confidence: clampConfidence(event.confidence),
        source: "lexi",
        observedAt: new Date(),
      },
    ];
    if (event.component) {
      facts.push({
        key: "component",
        value: event.component.slice(0, 80),
        confidence: 0.8,
        source: "lexi",
        observedAt: new Date(),
      });
    }

    await this.issueMemory.recordInvestigation(
      event.githubNumber,
      repo,
      {
        timestamp: new Date(),
        trigger: "initial",
        outcome: event.classification.slice(0, 80),
        reproductionAttempted: true,
        insight: event.summary.slice(0, MAX_TEXT),
      },
      facts,
    );

    if (event.owner) {
      const issueNodeId = await this.graph.upsertNode("issue", String(event.githubNumber), repo);
      const engineerNodeId = await this.graph.upsertNode("engineer", event.owner, repo, event.owner);
      await this.graph.addEdge(issueNodeId, engineerNodeId, "owned_by", 0.7, { role: "assigned" });
    }
  }

  async recordDuplicate(
    sourceIssueNumber: number,
    sourceRepo: string,
    canonicalIssueNumber: number,
    canonicalRepo: string,
    confidence = 0.85,
  ): Promise<void> {
    if (!isSafeIssueNumber(sourceIssueNumber) || !isSafeIssueNumber(canonicalIssueNumber)) return;
    await this.graph.recordRelation(
      sourceIssueNumber,
      sourceRepo,
      canonicalIssueNumber,
      canonicalRepo,
      "duplicate_of",
      clampConfidence(confidence),
    );
  }

  async recordHumanCorrection(input: {
    issueNumber: number;
    repo: string;
    category: string;
    correction: string;
    originalDecision?: string;
    reason?: string;
  }): Promise<void> {
    if (!isSafeIssueNumber(input.issueNumber)) return;
    await this.issueMemory.recordInvestigation(
      input.issueNumber,
      input.repo,
      {
        timestamp: new Date(),
        trigger: "manual",
        outcome: "human_correction",
        reproductionAttempted: false,
        insight: input.correction.slice(0, MAX_TEXT),
      },
      [
        {
          key: `correction:${input.category.slice(0, 40)}`,
          value: input.correction.slice(0, MAX_TEXT),
          confidence: 1,
          source: "human",
          observedAt: new Date(),
        },
      ],
    );
  }
}

function repoKey(owner: string, name: string): string {
  return `${owner.slice(0, 100)}/${name.slice(0, 100)}`;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function isSafeIssueNumber(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 10_000_000;
}

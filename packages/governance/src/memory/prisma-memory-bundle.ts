import type { PrismaClient } from "@lexi/database";
import { FeedbackLearningService } from "../agent-intelligence/feedback-learning.service";
import { PrismaFeedbackPersistence } from "../agent-intelligence/prisma-feedback-persistence";
import { EngineeringKnowledgeGraphService } from "./engineering-knowledge-graph.service";
import { EngineeringMemoryRecorder } from "./engineering-memory-recorder";
import { IssueMemoryService } from "./issue-memory.service";
import { MemoryRetrievalService } from "./memory-retrieval.service";
import { UserPreferenceService } from "./user-preference.service";

/** The tables the engineering memory services read and write. `PrismaService` satisfies it. */
export type EngineeringMemoryPrisma = Pick<
  PrismaClient,
  "knowledgeNode" | "knowledgeEdge" | "issueMemory" | "userPreference" | "feedbackCorrection"
>;

export interface EngineeringMemoryBundle {
  graph: EngineeringKnowledgeGraphService;
  issueMemory: IssueMemoryService;
  userPreferences: UserPreferenceService;
  feedback: FeedbackLearningService;
  /**
   * Reads the other four for a conversation turn. Structurally a
   * `GovernanceMemoryPort`, so it can be handed to the memory facade as is.
   */
  retrieval: MemoryRetrievalService;
  /** Writes workflow outcomes into the graph and issue memory. */
  recorder: EngineeringMemoryRecorder;
}

/**
 * The engineering memory services on the application database, built once so
 * every consumer — the agent's recall, the workflow recorder, the correction
 * path — shares the same stores rather than each opening its own view.
 *
 * The services' store ports were written as subsets of the generated client's
 * delegates, so the client is passed straight through; a schema change that
 * breaks one of them fails here at compile time instead of at the first write.
 *
 * `defaultRepo` is the `owner/name` slug issue lookups use when a question
 * names an issue number without a repository.
 */
export function createEngineeringMemoryBundle(prisma: EngineeringMemoryPrisma, defaultRepo: string): EngineeringMemoryBundle {
  const graph = new EngineeringKnowledgeGraphService(prisma);
  const issueMemory = new IssueMemoryService(prisma);
  const userPreferences = new UserPreferenceService(prisma);
  const feedback = new FeedbackLearningService(new PrismaFeedbackPersistence(prisma));
  const retrieval = new MemoryRetrievalService(graph, userPreferences, issueMemory, defaultRepo, feedback);
  const recorder = new EngineeringMemoryRecorder(graph, issueMemory);
  return { graph, issueMemory, userPreferences, feedback, retrieval, recorder };
}

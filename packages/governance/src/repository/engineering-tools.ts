/**
 * Engineering Intelligence Tools — governed tools for Lexi agent.
 *
 * These tools answer and act on engineering questions:
 * - "Put this on the Mobile team's board"
 * - "Which P1 Cashier issues are not on any team board?"
 *
 * All write actions go through the governed pipeline (authorization + audit).
 * Read actions are freely available to the agent.
 */

import type { ProjectsV2Service } from "./projects-v2.service";
import type { RepositoryRegistry, RepositoryResolution } from "./repository-registry";

export interface EngineeringToolResult {
  success: boolean;
  data?: unknown;
  summary: string;
  confidence: "high" | "medium" | "low";
  notes?: string[];
}

/**
 * Read tool: Get issue status on project board.
 * Answers: "What's the board status of #856?"
 */
export async function getProjectBoardStatus(
  projects: ProjectsV2Service,
  issueNumber: number,
  issueRepository: string,
  projectOrg: string,
  projectNumber: number,
): Promise<EngineeringToolResult> {
  const status = await projects.getIssueProjectStatus(
    issueNumber,
    issueRepository,
    projectOrg,
    projectNumber,
  );

  if (!status) {
    return {
      success: true,
      data: { onBoard: false },
      summary: `Issue #${issueNumber} is not on project ${projectOrg}/${projectNumber}.`,
      confidence: "high",
    };
  }

  if (!status.onBoard) {
    return {
      success: true,
      data: status,
      summary: `Issue #${issueNumber} is not on the project board.`,
      confidence: "high",
    };
  }

  return {
    success: true,
    data: status,
    summary: `Issue #${issueNumber} is on the board with status: ${status.status ?? "unset"}.`,
    confidence: "high",
  };
}

/**
 * Write tool: Add issue to project board (governed).
 * Implements: "Put this on the Mobile team's board"
 */
export async function addToProjectBoard(
  projects: ProjectsV2Service,
  issueNumber: number,
  issueRepository: string,
  projectOrg: string,
  projectNumber: number,
): Promise<EngineeringToolResult> {
  const result = await projects.addToBoard(
    issueNumber,
    issueRepository,
    projectOrg,
    projectNumber,
  );

  return {
    success: result.added,
    data: result,
    summary: result.added
      ? `Added #${issueNumber} to project ${projectOrg}/${projectNumber}.`
      : `Could not add to board: ${result.reason}`,
    confidence: "high",
  };
}

/**
 * Write tool: Update issue status on project board (governed).
 * Implements: "Move #856 to In Progress"
 */
export async function updateProjectBoardStatus(
  projects: ProjectsV2Service,
  issueNumber: number,
  issueRepository: string,
  projectOrg: string,
  projectNumber: number,
  newStatus: string,
): Promise<EngineeringToolResult> {
  const result = await projects.updateStatus(
    issueNumber,
    issueRepository,
    projectOrg,
    projectNumber,
    newStatus,
  );

  return {
    success: result.updated,
    data: result,
    summary: result.updated
      ? `Updated #${issueNumber} status to "${newStatus}".`
      : `Could not update: ${result.reason}`,
    confidence: "high",
  };
}

/**
 * Read tool: Find issues not on any board.
 * Answers: "Which P1 Cashier issues are not on any team board?"
 */
export async function findUnboardedIssues(
  projects: ProjectsV2Service,
  repository: string,
  projectOrg: string,
  projectNumber: number,
  filters?: { labels?: string[]; priority?: string },
): Promise<EngineeringToolResult> {
  const issues = await projects.findUnboardedIssues(repository, projectOrg, projectNumber, filters);

  return {
    success: true,
    data: issues,
    summary: issues.length > 0
      ? `Found ${issues.length} issue(s) not on the board: ${issues.slice(0, 5).map((i) => `#${i.issueNumber}`).join(", ")}${issues.length > 5 ? "..." : ""}`
      : "All matching issues are already on the board.",
    confidence: "high",
  };
}

/**
 * Read tool: Resolve which repository/team should fix an issue.
 * Answers: "Which repo is fixing this bug?"
 */
export async function resolveImplementationRepo(
  registry: RepositoryRegistry,
  team: string,
  platform?: "web" | "mobile",
): Promise<EngineeringToolResult> {
  const repos = platform
    ? [registry.resolveForTeam(team, platform)].filter((r): r is RepositoryResolution => r !== null)
    : registry.resolveAllForTeam(team);

  if (repos.length === 0) {
    return {
      success: true,
      data: null,
      summary: `No implementation repository registered for team "${team}"${platform ? ` (${platform})` : ""}.`,
      confidence: "high",
      notes: ["Check config/repos.yaml if this team should have a registered repository."],
    };
  }

  const operational = repos.filter((r) => !r.placeholder);
  const placeholders = repos.filter((r) => r.placeholder);

  return {
    success: true,
    data: repos,
    summary: operational.length > 0
      ? `${team} implementation: ${operational.map((r) => r.fullName).join(", ")}${placeholders.length > 0 ? ` (${placeholders.length} placeholder)` : ""}`
      : `All repositories for "${team}" are placeholders — not yet operational.`,
    confidence: operational.length > 0 ? "high" : "medium",
  };
}

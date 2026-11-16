/**
 * GitHub Projects v2 Service — governed integration with GitHub project boards.
 *
 * Enables Lexi to:
 * - "Put this on the Mobile team's board"
 * - "Which P1 Cashier issues are not on any team board?"
 * - "What's the status of #856 on the board?"
 * - "Move #856 to In Progress"
 *
 * All mutations go through the governed action pipeline — never direct agent access.
 * Read operations are available to the agent freely.
 *
 * Uses GitHub Projects v2 GraphQL API.
 * EXTERNAL_CONFIGURATION: Requires GitHub App with project:write scope.
 */

export interface ProjectFieldOption {
  id: string;
  name: string;
}

export interface ProjectField {
  id: string;
  name: string;
  type: "single_select" | "iteration" | "text" | "number" | "date";
  options?: ProjectFieldOption[];
}

export interface ProjectItem {
  id: string;
  contentId: string;
  contentType: "Issue" | "PullRequest" | "DraftIssue";
  issueNumber?: number;
  issueRepository?: string;
  title?: string;
  status?: string;
  iteration?: string;
  priority?: string;
  assignees?: string[];
}

export interface ProjectBoardState {
  projectId: string;
  organization: string;
  projectNumber: number;
  title: string;
  fields: ProjectField[];
  items: ProjectItem[];
  totalItems: number;
}

export interface ProjectsV2GitHubPort {
  /** Get project metadata and fields. */
  getProject(org: string, projectNumber: number): Promise<{
    id: string;
    title: string;
    fields: ProjectField[];
  } | null>;

  /** List items on a project board (paginated). */
  listProjectItems(
    org: string,
    projectNumber: number,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: ProjectItem[]; hasNext: boolean; endCursor?: string }>;

  /** Add an issue to a project board. Returns the project item ID. */
  addIssueToProject(
    projectId: string,
    issueNodeId: string,
  ): Promise<string>;

  /** Update a field value on a project item. */
  updateProjectItemField(
    projectId: string,
    itemId: string,
    fieldId: string,
    value: string | { singleSelectOptionId: string } | { iterationId: string },
  ): Promise<void>;

  /** Get the GitHub GraphQL node ID for an issue (needed for project mutations). */
  getIssueNodeId(owner: string, repo: string, issueNumber: number): Promise<string>;
}

export interface ProjectsPersistence {
  upsertBoardItem(item: {
    issueNumber: number;
    issueRepository: string;
    projectOrg: string;
    projectNumber: number;
    projectItemId: string | null;
    status: string | null;
    iteration: string | null;
    priority: string | null;
    assignee: string | null;
  }): Promise<void>;

  getBoardItem(
    issueNumber: number,
    issueRepository: string,
    projectOrg: string,
    projectNumber: number,
  ): Promise<{
    projectItemId: string | null;
    status: string | null;
    iteration: string | null;
    priority: string | null;
  } | null>;

  getIssuesNotOnBoard(
    repository: string,
    projectOrg: string,
    projectNumber: number,
    filters?: { labels?: string[]; priority?: string },
  ): Promise<Array<{ issueNumber: number; title: string; labels: string[] }>>;

  getProjectItems(
    projectOrg: string,
    projectNumber: number,
    filters?: { status?: string; assignee?: string },
  ): Promise<Array<{
    issueNumber: number;
    issueRepository: string;
    status: string | null;
    priority: string | null;
    assignee: string | null;
  }>>;
}

export interface ProjectsV2Config {
  enabled: boolean;
  writesEnabled: boolean;
}

/**
 * GitHub Projects v2 integration service.
 */
export class ProjectsV2Service {
  constructor(
    private readonly github: ProjectsV2GitHubPort | null,
    private readonly persistence: ProjectsPersistence,
    private readonly config: ProjectsV2Config,
    private readonly logger: { log(msg: string, ctx?: string): void; warn(msg: string, ctx?: string): void },
  ) {}

  /**
   * Get the current status of an issue on a project board.
   */
  async getIssueProjectStatus(
    issueNumber: number,
    issueRepository: string,
    projectOrg: string,
    projectNumber: number,
  ): Promise<{ onBoard: boolean; status: string | null; iteration: string | null; priority: string | null } | null> {
    const item = await this.persistence.getBoardItem(issueNumber, issueRepository, projectOrg, projectNumber);
    if (!item) {
      return { onBoard: false, status: null, iteration: null, priority: null };
    }
    return { onBoard: true, ...item };
  }

  /**
   * Add an issue to a project board (governed action).
   * Returns the project item ID or null if the action was blocked.
   */
  async addToBoard(
    issueNumber: number,
    issueRepository: string,
    projectOrg: string,
    projectNumber: number,
  ): Promise<{ added: boolean; itemId?: string; reason?: string }> {
    if (!this.config.enabled) {
      return { added: false, reason: "Projects v2 integration is disabled." };
    }
    if (!this.config.writesEnabled) {
      // Record intent in persistence but don't actually add
      await this.persistence.upsertBoardItem({
        issueNumber,
        issueRepository,
        projectOrg,
        projectNumber,
        projectItemId: null,
        status: null,
        iteration: null,
        priority: null,
        assignee: null,
      });
      return { added: false, reason: "Writes disabled (dry-run mode). Board placement recorded." };
    }
    if (!this.github) {
      return { added: false, reason: "GitHub Projects API not configured." };
    }

    try {
      // Get project metadata
      const project = await this.github.getProject(projectOrg, projectNumber);
      if (!project) {
        return { added: false, reason: `Project #${projectNumber} not found in ${projectOrg}.` };
      }

      // Get issue node ID
      const [owner, repo] = issueRepository.split("/");
      const issueNodeId = await this.github.getIssueNodeId(owner, repo, issueNumber);

      // Add to project
      const itemId = await this.github.addIssueToProject(project.id, issueNodeId);

      // Persist
      await this.persistence.upsertBoardItem({
        issueNumber,
        issueRepository,
        projectOrg,
        projectNumber,
        projectItemId: itemId,
        status: null,
        iteration: null,
        priority: null,
        assignee: null,
      });

      this.logger.log(
        `Added #${issueNumber} to project ${projectOrg}/${projectNumber} (item: ${itemId})`,
        "ProjectsV2Service",
      );

      return { added: true, itemId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.logger.warn(`Failed to add #${issueNumber} to project: ${msg}`, "ProjectsV2Service");
      return { added: false, reason: msg };
    }
  }

  /**
   * Update the status of an issue on a project board (governed action).
   */
  async updateStatus(
    issueNumber: number,
    issueRepository: string,
    projectOrg: string,
    projectNumber: number,
    newStatus: string,
  ): Promise<{ updated: boolean; reason?: string }> {
    if (!this.config.enabled || !this.config.writesEnabled || !this.github) {
      return { updated: false, reason: "Projects v2 writes not enabled." };
    }

    const item = await this.persistence.getBoardItem(issueNumber, issueRepository, projectOrg, projectNumber);
    if (!item?.projectItemId) {
      return { updated: false, reason: "Issue not on this project board." };
    }

    try {
      const project = await this.github.getProject(projectOrg, projectNumber);
      if (!project) {
        return { updated: false, reason: "Project not found." };
      }

      const statusField = project.fields.find((f) => f.name.toLowerCase() === "status");
      if (!statusField || !statusField.options) {
        return { updated: false, reason: "Status field not found on project." };
      }

      const option = statusField.options.find(
        (o) => o.name.toLowerCase() === newStatus.toLowerCase(),
      );
      if (!option) {
        return {
          updated: false,
          reason: `Status "${newStatus}" not found. Available: ${statusField.options.map((o) => o.name).join(", ")}`,
        };
      }

      await this.github.updateProjectItemField(
        project.id,
        item.projectItemId,
        statusField.id,
        { singleSelectOptionId: option.id },
      );

      await this.persistence.upsertBoardItem({
        issueNumber,
        issueRepository,
        projectOrg,
        projectNumber,
        projectItemId: item.projectItemId,
        status: newStatus,
        iteration: null,
        priority: null,
        assignee: null,
      });

      return { updated: true };
    } catch (err) {
      return { updated: false, reason: err instanceof Error ? err.message : "unknown" };
    }
  }

  /**
   * Find issues that should be on a board but aren't.
   * Answers: "Which P1 Cashier issues are not on any team board?"
   */
  async findUnboardedIssues(
    repository: string,
    projectOrg: string,
    projectNumber: number,
    filters?: { labels?: string[]; priority?: string },
  ): Promise<Array<{ issueNumber: number; title: string; labels: string[] }>> {
    return this.persistence.getIssuesNotOnBoard(repository, projectOrg, projectNumber, filters);
  }

  /**
   * Sync project board state from GitHub.
   */
  async syncBoard(projectOrg: string, projectNumber: number): Promise<number> {
    if (!this.github) return 0;

    let synced = 0;
    let cursor: string | undefined;
    let hasNext = true;

    while (hasNext) {
      const page = await this.github.listProjectItems(projectOrg, projectNumber, cursor, 50);

      for (const item of page.items) {
        if (item.issueNumber && item.issueRepository) {
          await this.persistence.upsertBoardItem({
            issueNumber: item.issueNumber,
            issueRepository: item.issueRepository,
            projectOrg,
            projectNumber,
            projectItemId: item.id,
            status: item.status ?? null,
            iteration: item.iteration ?? null,
            priority: item.priority ?? null,
            assignee: item.assignees?.[0] ?? null,
          });
          synced++;
        }
      }

      hasNext = page.hasNext;
      cursor = page.endCursor;
    }

    this.logger.log(`Synced ${synced} items from project ${projectOrg}/${projectNumber}`, "ProjectsV2Service");
    return synced;
  }
}

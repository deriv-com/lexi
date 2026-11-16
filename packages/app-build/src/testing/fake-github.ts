import type { GithubCommentDto, GithubIssueDto, GithubWorkflowRunDto, ListedPullRequestDto, ListPullRequestsOptions } from "@lexi/github";
import type { AppBuildGithubPort } from "../github-port";

/**
 * Test doubles for the app-build specs: an in-memory GitHub that honours the
 * filters app-build uses, and builders for the comments the loop posts.
 * Fictional repositories and people only.
 */

export const REPO = { owner: "acme", repo: "web", slug: "acme/web", defaultBranch: "main" };
export const PR_URL = (n: number) => `https://github.com/acme/web/pull/${n}`;
export const RUN_URL = (id: number) => `https://github.com/acme/web/actions/runs/${id}`;
export const LOOP_BOT = "acme-builder[bot]";

export function reportBody(opts: {
  app: "web" | "mobile";
  session: number;
  phase?: string;
  questions?: string[];
  cost?: string;
  gate?: string;
  stop?: string;
  runId?: number;
}): string {
  const lines = [
    "<!-- app-build:report -->",
    `<!-- app-build:session app=${opts.app} session=${opts.session} phase=${opts.phase ?? "build"} -->`,
    `## Session ${opts.session} — Acme Markets ${opts.app} app`,
    "",
    `[Run log](${RUN_URL(opts.runId ?? 1000 + opts.session)}) · commit \`abc1234\``,
    "",
    `Built the sign-in screen in session ${opts.session}.`,
    "",
  ];
  if (opts.questions) lines.push("## Questions only a person can answer", ...opts.questions.map((q) => `- ${q}`), "");
  if (opts.cost) lines.push(opts.cost, "");
  if (opts.gate) lines.push("### Phase gate", opts.gate, "");
  lines.push(
    opts.stop ? `_The build loop stopped: ${opts.stop}._` : `_Session ${opts.session + 1} starts now. Comment here any time to steer it._`,
  );
  return lines.join("\n");
}

export function assessmentBody(app: "web" | "mobile", session: number): string {
  return [
    `<!-- app-build:assessment app=${app} session=${session} -->`,
    "| Check | Result |",
    "|---|---|",
    "| build | ✅ pass |",
    "| lint | ✅ pass |",
    "| e2e | ❌ fail |",
    "Review: 0 blockers, 1 major",
  ].join("\n");
}

export interface FakePr {
  number: number;
  app: "web" | "mobile";
  state: "open" | "closed";
  labels: string[];
}

export interface FakeRun {
  runId: number;
  status: string;
  conclusion?: string | null;
  displayTitle?: string;
}

function issueDto(number: number, labels: string[]): GithubIssueDto {
  return {
    githubIssueId: 90_000 + number,
    githubNumber: number,
    repoOwner: REPO.owner,
    repoName: REPO.repo,
    title: `Build PR ${number}`,
    body: null,
    url: PR_URL(number),
    authorLogin: LOOP_BOT,
    labels: [...labels],
    state: "open",
    stateReason: null,
    assignees: [],
    githubCreatedAt: "2026-01-01T00:00:00Z",
    githubUpdatedAt: "2026-01-01T00:00:00Z",
  };
}

export class FakeGithub implements AppBuildGithubPort {
  prs: FakePr[] = [];
  comments = new Map<number, GithubCommentDto[]>();
  runs: FakeRun[] = [];
  runsReadable = true;
  pullsReadable = true;
  files = new Map<string, string>();
  defaultBranch: string | null = "main";
  dispatches: Array<{ workflowFile: string; ref: string; inputs: Record<string, string> }> = [];
  labelAdds: Array<{ n: number; labels: string[] }> = [];
  labelRemovals: Array<{ n: number; labels: string[] }> = [];
  posted: Array<{ n: number; body: string }> = [];
  dispatchError: Error | null = null;
  writeError: Error | null = null;
  /** What `findDispatchedRun` answers; null = not visible yet. */
  dispatchedRun: { runId: number; runUrl: string; status: string } | null = null;
  headQueries: string[] = [];
  private nextCommentId = 5000;

  addLoopComment(prNumber: number, body: string, author: string | null = LOOP_BOT): number {
    const list = this.comments.get(prNumber) ?? [];
    const id = this.nextCommentId++;
    list.push({ id, authorLogin: author, body, createdAt: "2026-01-02T00:00:00Z" });
    this.comments.set(prNumber, list);
    return id;
  }

  async listPullRequests(_o: string, _r: string, options?: ListPullRequestsOptions): Promise<ListedPullRequestDto[] | null> {
    if (!this.pullsReadable) return null;
    this.headQueries.push(options?.head ?? "");
    const prefix = options?.head?.replace(/(web|mobile)$/, "") ?? "";
    const app = options?.head?.slice(prefix.length);
    return this.prs
      .filter((pr) => pr.app === app)
      .map((pr) => ({
        number: pr.number,
        title: `Build the ${pr.app} app`,
        url: PR_URL(pr.number),
        state: pr.state,
        draft: true,
        authorLogin: LOOP_BOT,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        headRef: options?.head ?? null,
        baseRef: "main",
      }));
  }

  async getIssue(_o: string, _r: string, n: number): Promise<GithubIssueDto> {
    return issueDto(n, this.prs.find((pr) => pr.number === n)?.labels ?? []);
  }

  async listComments(_o: string, _r: string, n: number): Promise<GithubCommentDto[]> {
    return [...(this.comments.get(n) ?? [])];
  }

  async addComment(_o: string, _r: string, n: number, body: string): Promise<GithubCommentDto> {
    if (this.writeError) throw this.writeError;
    this.posted.push({ n, body });
    return { id: 777, authorLogin: LOOP_BOT, body, createdAt: "2026-01-03T00:00:00Z" };
  }

  async addLabels(_o: string, _r: string, n: number, labels: string[]): Promise<string[]> {
    if (this.writeError) throw this.writeError;
    this.labelAdds.push({ n, labels });
    const pr = this.prs.find((p) => p.number === n);
    if (pr) pr.labels.push(...labels);
    return pr?.labels ?? labels;
  }

  async removeLabels(_o: string, _r: string, n: number, labels: string[]): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.labelRemovals.push({ n, labels });
    const pr = this.prs.find((p) => p.number === n);
    if (pr) pr.labels = pr.labels.filter((l) => !labels.includes(l));
  }

  async dispatchWorkflow(_o: string, _r: string, workflowFile: string, ref: string, inputs: Record<string, string>): Promise<void> {
    if (this.dispatchError) throw this.dispatchError;
    if (this.writeError) throw this.writeError;
    this.dispatches.push({ workflowFile, ref, inputs });
  }

  async findDispatchedRun(): Promise<{ runId: number; runUrl: string; status: string } | null> {
    return this.dispatchedRun;
  }

  async listWorkflowRuns(): Promise<GithubWorkflowRunDto[] | null> {
    if (!this.runsReadable) return null;
    return this.runs.map((run) => ({
      runId: run.runId,
      runUrl: RUN_URL(run.runId),
      status: run.status,
      conclusion: run.conclusion ?? null,
      displayTitle: run.displayTitle ?? "app-build",
      name: "app-build",
    }));
  }

  async getDefaultBranch(): Promise<string | null> {
    return this.defaultBranch;
  }

  async getFileContents(_o: string, _r: string, path: string, ref?: string): Promise<string | null> {
    return this.files.get(`${ref ?? ""}:${path}`) ?? null;
  }
}

/** An in-memory `AuditLog` that honours the one JSON-path filter the audit store uses. */
export class FakeAuditPrisma {
  rows: Array<{ actor: string; action: string; details: Record<string, unknown>; createdAt: number }> = [];
  private tick = 0;

  auditLog = {
    create: async (args: { data: { actor: string; action: string; details: unknown } }) => {
      this.rows.push({ actor: args.data.actor, action: args.data.action, details: args.data.details as Record<string, unknown>, createdAt: this.tick++ });
      return {};
    },
    findMany: async (args: { where: Record<string, unknown>; take?: number }) => {
      const action = args.where.action as string | { in: string[] };
      const path = args.where.details as { path: string[]; equals: unknown } | undefined;
      return this.rows
        .filter((row) => (typeof action === "string" ? row.action === action : action.in.includes(row.action)))
        .filter((row) => !path || row.details[path.path[0]] === path.equals)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, args.take ?? 1000);
    },
  };
}

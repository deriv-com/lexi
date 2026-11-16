import type {
  ApiContractDocument,
  DesignContextDocument,
  MemoryPort,
  RepoDescriptor,
  RunCheckResult,
  RunEvidencePhase,
} from "@lexi/contracts";
import type {
  GithubIssueDto,
  GithubPullRequestDto,
  GithubWorkflowArtifact,
  MergedPullRequestDto,
  MergePullRequestOptions,
} from "@lexi/github";
import type { ProgrammePolicy } from "../load-programme-policy";
import type { ProgrammeAuthzPort } from "../programme-milestone-review";
import type { ProgrammeSpecReader, ProgrammeStore } from "../programme-store";
import type { UsagePricing } from "../token-usage";

/**
 * Every I/O seam the programme engine uses, as narrow structural ports. The
 * engine never imports a concrete client: the server wires real providers in,
 * and the specs wire in-memory doubles, so nothing here needs a network, a
 * database or a Slack workspace to be exercised.
 */

/**
 * The GitHub operations the engine performs. Structural: the server's
 * `GitHubMutationGateway` (or any `GitHubProvider` that also merges) satisfies
 * it. Several members are optional; a deployment whose provider lacks one
 * degrades to the narrower behaviour and says so, rather than refusing every
 * programme.
 */
export interface ProgrammeGithubPort {
  dispatchWorkflow(
    owner: string,
    repo: string,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void>;
  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto>;
  mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    options?: MergePullRequestOptions,
  ): Promise<MergedPullRequestDto>;
  getIssueForRepo?(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDto>;
  /** Open issues carrying a label: the hardening findings list. */
  listBugHuntIssues(options: {
    owner: string;
    repo: string;
    label: string;
    state?: "open" | "closed" | "all";
  }): Promise<Array<{ githubNumber: number; title: string }>>;
  getFileContents(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;
  /**
   * Files a merged pull request touched. Optional: without it a brief simply
   * carries no file hints.
   */
  getPullRequestFiles?(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<Array<{ filename: string; status: string }>>;
  listWorkflowRunArtifacts(owner: string, repo: string, runId: number): Promise<GithubWorkflowArtifact[]>;
  downloadWorkflowRunArtifact(owner: string, repo: string, artifactId: number): Promise<Buffer>;
  /**
   * Used to ask "has ANY pull request from this task's branch been merged",
   * which is how a task whose work landed under a different PR number is
   * recognised. Absent, only the task's current prNumber is checked.
   */
  listPullRequests?(
    owner: string,
    repo: string,
    options: { state?: "open" | "closed" | "all"; head?: string; perPage?: number },
  ): Promise<Array<{ number: number }> | null>;
  /**
   * Without it a run that ends WITHOUT uploading its result artifact
   * (cancelled, timed out, runner crashed) is indistinguishable from one still
   * running, and its task waits for a result that will never arrive.
   */
  getWorkflowRun?(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<{ status: string; conclusion: string | null } | null>;
  /**
   * Without it the fold cannot recover a run whose attempt produced no
   * evidence. Note the field is `runId`, not `id`.
   */
  findDispatchedRun?(
    owner: string,
    repo: string,
    workflowFile: string,
    since: Date,
    excludeRunIds?: readonly number[],
    nameContains?: string,
  ): Promise<{ runId: number } | null>;
  branchExists?(owner: string, repo: string, branch: string): Promise<boolean | null>;
  createBranch?(
    owner: string,
    repo: string,
    options: { name: string; from?: string },
  ): Promise<{ name: string; sha: string; url: string }>;
  createIssue?(
    owner: string,
    repo: string,
    title: string,
    body: string,
    labels?: string[],
  ): Promise<{ githubNumber: number; url: string }>;
  updateIssue?(
    owner: string,
    repo: string,
    issueNumber: number,
    patch: { title: string; body: string },
  ): Promise<unknown>;
  getTree?(
    owner: string,
    repo: string,
    path?: string,
    ref?: string,
  ): Promise<{ entries: Array<{ path: string; type: "blob" | "tree" }>; truncated: boolean }>;
  /** API reference documents. Optional: without them no brief carries a reference. */
  getFileSha?(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;
  getBlob?(owner: string, repo: string, sha: string, maxBytes?: number): Promise<string | null>;
}

/** The repository registry, structurally. `RepoRegistry` from `@lexi/workitems` satisfies it. */
export interface ProgrammeRepoRegistry {
  resolveRepo(key: string): RepoDescriptor | null;
  /** True when the key is registered `autonomyTier: autonomous`. */
  isAutonomous(key: string): boolean;
}

/**
 * The attempt ledger. Every dispatch is one row; its id goes on the wire and
 * is echoed back on every evidence bundle. The Prisma client's
 * `quickFixAttempt` delegate satisfies it structurally.
 */
export interface ProgrammeAttemptStore {
  quickFixAttempt: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface ProgrammeFlags {
  /** The env half of the kill switch (PROGRAMME_ENABLED). */
  programmeEnabled: boolean;
  dispatchEnabled: boolean;
  autoMergeEnabled: boolean;
  /** Public base URL briefs are served from, e.g. https://lexi.example.com. */
  publicBaseUrl: string;
  /** Channel milestone-review cards and digests post to. */
  reviewChannel: string;
}

/** One stored evidence bundle, as the engine reads it back. */
export interface RunEvidenceListRow {
  id: string;
  attemptId: string;
  phase: RunEvidencePhase | string;
  workflowRunId: string | number | bigint | null;
  commitSha: string | null;
  checks: RunCheckResult[] | unknown;
  failingTests: unknown;
  artifacts?: unknown;
  reportedAt: Date | null;
  receivedAt: Date;
}

/** The evidence read the advance job folds from. */
export interface ProgrammeEvidencePort {
  listByAttempt(attemptId: string): Promise<RunEvidenceListRow[]>;
}

/**
 * Reads evidence bundles off a run's uploaded artifact.
 *
 * Evidence normally reaches the orchestrator by POST from the runner. That
 * channel is authenticated by a shared token, and a token the repository never
 * rotated is indistinguishable from a runner that produced nothing: the POST
 * is refused and every task would freeze in DISPATCHED, because the phase
 * transitions are driven by evidence rows. The artifact is the fallback.
 */
export interface ProgrammeEvidenceArtifactPort {
  ingestFromWorkflowRun(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<{ ingested: number; deduplicated: number; rejected: number }>;
}

/** Design-context snapshots of a design file (for example a Figma prototype). */
export interface ProgrammeDesignContextPort {
  snapshotPrototype(
    fileKey: string,
    options: { platform?: string | null; programmeKey?: string; requestedBy?: string },
  ): Promise<DesignContextDocument>;
}

/** Filtered snapshots of the backend OpenAPI contract. */
export interface ProgrammeApiContractPort {
  snapshot(): Promise<ApiContractDocument>;
  latest(): Promise<ApiContractDocument | null>;
}

/**
 * A liveness check on a preview URL. Deliberately not a general HTTP client:
 * the only question is whether that one URL is serving.
 */
export interface PreviewProbePort {
  reachable(url: string): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Where review cards, digests and notices go. `SlackProvider` from
 * `@lexi/slack` satisfies it structurally.
 */
export interface ProgrammeNotifierPort {
  sendMessage(payload: {
    channel: string;
    text: string;
    blocks?: unknown[];
    threadTs?: string;
  }): Promise<{ ok: boolean; ts?: string; error?: string }>;
}

/** The slice of a logger the engine uses. */
export interface ProgrammeLogger {
  log(message: string, context?: string): void;
  warn(message: string, context?: string): void;
  error?(message: string, context?: string): void;
}

export interface ProgrammeBuildDeps {
  store: ProgrammeStore;
  specs: ProgrammeSpecReader;
  evidence: ProgrammeEvidencePort;
  /** Optional fallback read path for evidence (the run's evidence artifact). */
  evidenceArtifacts?: ProgrammeEvidenceArtifactPort;
  github: ProgrammeGithubPort;
  attempts: ProgrammeAttemptStore;
  registry: ProgrammeRepoRegistry;
  policy: ProgrammePolicy;
  authz: ProgrammeAuthzPort;
  notifier: ProgrammeNotifierPort;
  designContext?: ProgrammeDesignContextPort;
  /** Absent means briefs carry no API contract. */
  apiContracts?: ProgrammeApiContractPort;
  /**
   * Is the preview actually serving? Checked before a sweep is dispatched, so
   * a missing DNS record is not reported as a broken product. Absent → no check.
   */
  previewProbe?: PreviewProbePort;
  /**
   * The agent's memory. Read at brief time so what was learned on earlier
   * tasks reaches the coding agent; written on every task outcome and every
   * recorded decision. Optional: briefs say so when it is off.
   */
  memory?: MemoryPort;
  /** USD per million tokens by model. Absent → usage is reported unpriced. */
  pricing?: UsagePricing;
  /**
   * `owner/repo` of a shared findings repository, read in addition to the
   * programme's own repository when counting open hardening findings. Empty →
   * only the programme's repository is read.
   */
  findingsRepoSlug?: string;
  flags: ProgrammeFlags;
  logger: ProgrammeLogger;
  now?: () => Date;
  mintId?: () => string;
}

export interface ProgrammeToolResult {
  ok: boolean;
  text: string;
  executed: boolean;
}

/** Who asked, and from where. `userId` is the authenticated actor, never a model-supplied id. */
export interface ProgrammeInvocationContext {
  userId: string;
  channel?: string;
  threadTs?: string;
}

/** `result.json` inside the `programme-result` artifact — the structured return. */
export interface ProgrammeBuildResult {
  schemaVersion: number;
  taskId: string;
  attemptId: string;
  status: "shipped" | "handback" | "failed";
  branch?: string;
  prNumber?: number;
  headSha?: string;
  handbackReason?: string;
  /** `{model, phases}` — the token-usage detail as an object, sent on every path. */
  tokenUsage?: unknown;
}

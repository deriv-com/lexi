/**
 * Work-item and repo-registry contracts.
 *
 * Work items *reference* the 20-state bug workflow; they do not replace it.
 */

export type WorkItemKind = "bug" | "feature" | "chore" | "spec";

export type WorkItemStatus =
  | "PROPOSED"
  | "CLARIFYING"
  | "SPECED"
  | "TASKED"
  | "IN_PROGRESS"
  | "DELIVERED"
  | "VERIFIED"
  | "CANCELLED";

/**
 * Two repo keys, deliberately. A bug is tracked in `issues` while
 * its code lands in a product repo, so the keys differ; for a spec they are the
 * same product repo. Collapsing them is what would sweep specs into the bug
 * corpus's dedup, triage and reproduction machinery.
 */
export interface WorkItemRef {
  id: string;
  kind: WorkItemKind;
  status: WorkItemStatus;
  title: string;
  /** `config/repos.yaml` key with role `issues` — where the issue lives. */
  trackingRepoKey?: string;
  /** `config/repos.yaml` key with role `code` — where the change lands. */
  codeRepoKey?: string;
  /** GitHub issue backing this item, in `trackingRepoKey`. */
  issueNumber?: number;
  specId?: string;
  parentId?: string;
  assigneeGithub?: string;
  assigneeSlack?: string;
}

/**
 * What a repo is *for*. Role gates every repo-touching capability: `code`
 * gates code search, file reads, fix/task dispatch and doc chunking; `issues`
 * gates corpus sync, dedup and bug intake; `specs` gates spec-issue creation.
 */
export type RepoRole = "issues" | "code" | "specs";

/**
 * The `resolveRepo(key)` return shape.
 *
 * `platform` is deliberately a plain string, not a union: the hard-coded
 * `enum: ["web","mobile"]` that tool schemas used to carry is what this removes, so
 * adding a repo stays a config change rather than a code change.
 */
/**
 * The per-repo autonomy tier (`repos.yaml` `products.<key>.autonomyTier`).
 *
 * `standard` is every ordinary repo: merging a pull request stays prohibited.
 * `autonomous` marks an agent-owned rebuild repo where the deterministic merge
 * executor — never the model — may merge after the programme's auto-merge gate
 * passes. The tier is data on the repo, not a property of the action, so the
 * base action classification never changes and an unknown tier stays
 * prohibited.
 */
export type AutonomyTier = "standard" | "autonomous";

export interface RepoDescriptor {
  /** `config/repos.yaml` key, e.g. "web". */
  key: string;
  organization: string;
  repository: string;
  /** "organization/repository". */
  slug: string;
  roles: RepoRole[];
  platform?: string;
  team?: string;
  /**
   * Per-repo autonomy tier. Absent means `standard`: pull requests are never
   * merged without a human, exactly as before. Only a repository declared
   * `autonomous` in `repos.yaml` (an agent-owned rebuild repo) is eligible for
   * the deterministic auto-merge executor; the tier travels on the descriptor
   * so a merge carve-out can decide without a second registry lookup.
   */
  autonomyTier?: AutonomyTier;
  /**
   * Branch the fix workflow's `workflow_dispatch` targets. Product repos
   * inherit `main` unless `config/repos.yaml` sets `defaultBranch`. Absent on
   * the bug-corpus source repo.
   */
  defaultBranch?: string;
  /**
   * Repository-relative directory holding this app, for a repository that
   * holds more than one (`products.<key>.workdir` in `config/repos.yaml`).
   *
   * Absent means the repository root. A monorepo carrying, say, `web/` and
   * `mobile/` has two keys that share one `slug` and differ only here, which
   * makes `workdir` the disambiguator for a slug lookup — see
   * `RepoRegistry.resolveAllBySlug` — as well as the directory a build
   * workflow runs its checks in.
   */
  workdir?: string;
  /**
   * The Projects v2 board this repo's issues belong on, when one is configured
   * (`products.<key>.project` in `config/repos.yaml`).
   *
   * Optional and frequently absent: a board placement needs an org *and* a
   * project number, and no caller may invent either. An absent value means "no
   * board is configured for this repo", which callers must report rather than
   * guess around — placing a spec on the wrong board is worse than not placing
   * it, because the row looks tracked to everyone reading that board.
   */
  project?: {
    organization: string;
    projectNumber: number;
    /**
     * The column a card moves to when a quick fix for the issue ships — the
     * board's OWN spelling of it, verbatim (`In Review` on web, `In progress`
     * with a lowercase `p` on mobile). Never normalised, never cross-applied
     * between boards.
     *
     * Absent means no column has been agreed for this board, which callers must
     * treat as a skip rather than picking one that looks close: a card in the
     * wrong column reads as tracked to everyone looking at the board.
     */
    shippedStatus?: string;
  };
  /**
   * How this app's fix workflow is dispatched, when it differs from the default
   * (`direct-fix.yml`, dispatched at `defaultBranch`, no platform input).
   *
   * Absent on every entry but the ones that opted in, so the absence of the
   * block is exactly today's behaviour. See {@link DirectFixSettings}.
   */
  directFix?: DirectFixSettings;
  /**
   * Where the test link for a Lexi PR on this app comes from. Absent on every
   * entry that has no web preview. See {@link PreviewLinkSettings}.
   */
  previewLink?: PreviewLinkSettings;
}

/**
 * Per-app fix-workflow dispatch settings (`products.<key>.directFix` in
 * `config/repos.yaml`), for a repository whose workflow differs from the
 * default: a different file name, a `target_platform` input, or work that lands
 * on a long-lived working branch rather than the default branch.
 */
export interface DirectFixSettings {
  /** Workflow file to dispatch and to poll for. */
  workflow: string;
  /**
   * The ref to dispatch at, which is also the branch the run checks out and the
   * branch its PR must target. Kept apart from `defaultBranch` on purpose:
   * `defaultBranch` is the repository's protected default, and pointing it at a
   * working branch would change what merge guards refuse.
   */
  ref?: string;
  /** Sent as the workflow's `target_platform` input. Only for workflows that declare it. */
  targetPlatform?: "web" | "mobile";
}

/**
 * Where the test link for a Lexi PR comes from
 * (`products.<key>.previewLink` in `config/repos.yaml`).
 *
 * A PR into the default branch gets its own web preview, so its own sticky
 * preview comment carries the link. A PR into a working branch
 * (`feat/web-rebuild`) gets none. There the link is the umbrella PR's (the
 * working branch into `main`), and it only contains the change once the PR has
 * merged and the umbrella's preview has rebuilt past it. The umbrella PR is
 * looked up each time, never pinned, so replacing it needs no config change.
 */
export interface PreviewLinkSettings {
  /**
   * Domains a relayed link may be on (the host itself or any subdomain).
   * Anything else in a comment is dropped, so a comment cannot put an
   * arbitrary URL into a Slack thread. The link itself is never configured:
   * it is read from the preview comment every time.
   */
  hosts: string[];
  /** Present when the app also lands work on a working branch with an umbrella PR. */
  umbrella?: {
    /** The working branch Lexi's PRs merge into, which is the umbrella PR's head. */
    branch: string;
    /** The umbrella PR's base. The open PR from `branch` into it is found at run time. */
    into: string;
  };
}

/**
 * Engineering change investigation results (Stage 3).
 * Checks GitHub for fix signals: PRs, issues, releases, code changes.
 */

export interface LinkedIssue {
  number: number;
  repo: string;
  state: "open" | "closed";
  labels: string[];
  relationship: "implementation" | "duplicate" | "related" | "parent";
  title: string;
  closedAt?: string;
}

export interface LinkedPullRequest {
  number: number;
  repo: string;
  state: "open" | "closed" | "merged";
  title: string;
  changedFiles: string[];
  mergedAt?: string;
  closedAt?: string;
  targetBranch: string;
  authorLogin?: string;
  reviewState?: "approved" | "changes_requested" | "pending" | "none";
}

export interface ProjectStatus {
  board: string;
  column: string;
  assignee?: string;
  iteration?: string;
  lastUpdated?: string;
}

export interface CodeEvidence {
  /** Whether the suspected faulty code pattern still exists in the default branch */
  suspectedPatternExists: boolean | null;
  /** Whether tests covering the reported case were added */
  relatedTestsAdded: boolean;
  /** Whether a fix commit is present on the default branch */
  fixCommitOnDefault: boolean;
  /** Whether the fix only exists on a feature branch (not yet merged) */
  fixOnFeatureBranchOnly: boolean;
}

export interface ReleaseEvidence {
  /** Whether the fix has been included in a release */
  fixReleased: boolean | null;
  /** Version that contains the fix */
  releaseVersion?: string;
  /** Release date */
  releasedAt?: string;
  /** Whether that release reached production */
  deployedToProduction: boolean | null;
  /** Deployment timestamp if known */
  deployedAt?: string;
}

export interface EngineeringInvestigation {
  linkedIssues: LinkedIssue[];
  linkedPullRequests: LinkedPullRequest[];
  projectStatus?: ProjectStatus;
  codeEvidence: CodeEvidence;
  releaseEvidence: ReleaseEvidence;
  investigatedAt: Date;
  /** Summary of what was checked and what couldn't be determined */
  limitations: string[];
}

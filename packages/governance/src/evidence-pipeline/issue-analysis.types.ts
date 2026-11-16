/**
 * Structured output from Claude issue analysis (Stage 1).
 * Claude extracts hypotheses — it does NOT decide closure.
 */
export interface IssueAnalysis {
  /** Bug categories inferred from the report (e.g., "UI glitch", "payment failure") */
  bugClass: string[];
  /** Most likely component/module */
  likelyComponent?: string;
  /** Repositories where the bug likely lives */
  likelyRepositories: string[];
  /** Quality of evidence present in the report */
  evidenceQuality: "strong" | "medium" | "weak";
  /** Whether the report likely describes expected behaviour, not a bug */
  likelyFalsePositive: boolean;
  /** Reasons why it might be a false positive */
  falsePositiveReasons: string[];
  /** Terms to search in code/PRs for related changes */
  codeSearchTerms: string[];
  /** Suspected source files or paths */
  suspectedFiles: string[];
  /** Lifecycle states the bug passes through (e.g., "login", "deposit", "withdrawal") */
  lifecycleStates: string[];
  /** How valuable reproduction would be for this issue */
  reproductionValue: "high" | "medium" | "low";
  /** Overall analysis confidence */
  confidence: number;
  /** Whether reported behaviour may actually be intended */
  expectedBehaviourLikely: boolean;
  /** Completeness of the report itself */
  reportCompleteness: "complete" | "partial" | "minimal";
  /** Extracted expected vs actual behaviour */
  expectedBehaviour?: string;
  actualBehaviour?: string;
  /** Error strings or codes mentioned */
  errorStrings: string[];
  /** Affected platform (web, mobile, API, etc.) */
  affectedPlatform?: string;
  /** Possible root cause hypothesis */
  possibleRootCause?: string;
}

export interface IssueAnalysisInput {
  issueNumber: number;
  title: string;
  body: string | null;
  labels: string[];
  authorLogin: string | null;
  state: string;
  createdAt: Date;
}

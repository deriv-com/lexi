import type {
  SlackAccountType,
  SlackBlockedBy,
  SlackInvestigationResponse,
  SlackInvestigationVerdict,
} from "./types";

const VERDICT_PATTERNS: Array<{ verdict: SlackInvestigationVerdict; patterns: RegExp[] }> = [
  { verdict: "REPRODUCED", patterns: [/reproduced/i, /result:\s*reproduced/i, /bug observed/i] },
  {
    verdict: "NOT_OBSERVED",
    patterns: [/not reproduced/i, /could not reproduce/i, /cannot reproduce/i, /not_observed/i, /result:\s*not/i],
  },
  { verdict: "BLOCKED", patterns: [/blocked by/i, /otp/i, /kyc/i, /payment blocked/i] },
  { verdict: "INCONCLUSIVE", patterns: [/inconclusive/i, /unclear/i, /not sure/i] },
];

const ACCOUNT_PATTERNS: Array<{ type: SlackAccountType; patterns: RegExp[] }> = [
  { type: "real", patterns: [/account type:\s*real/i, /\breal account\b/i] },
  { type: "demo", patterns: [/account type:\s*demo/i, /\bdemo account\b/i] },
  { type: "anonymous", patterns: [/account type:\s*anonymous/i, /\banonymous\b/i, /\bnot logged in\b/i] },
];

const BLOCKED_PATTERNS: Array<{ blocked: SlackBlockedBy; patterns: RegExp[] }> = [
  { blocked: "otp", patterns: [/blocked by:\s*otp/i, /\botp\b/i] },
  { blocked: "kyc", patterns: [/blocked by:\s*kyc/i, /\bkyc\b/i] },
  { blocked: "payment", patterns: [/blocked by:\s*payment/i, /\bpayment\b/i] },
  { blocked: "credentials", patterns: [/blocked by:\s*credentials/i, /\bcredentials\b/i] },
  { blocked: "environment", patterns: [/blocked by:\s*environment/i, /\benvironment error\b/i] },
];

const LIFECYCLE_STATE_PATTERN = /lifecycle(?: state)?:\s*([^\n]+)/i;
const STEPS_PATTERN = /steps(?: executed)?:\s*([^\n]+)/i;
const ENV_URL_PATTERN = /(?:environment|url):\s*(https?:\/\/[^\s]+)/i;
const EVIDENCE_URL_PATTERN = /(https?:\/\/[^\s]+)/g;

export interface ParseInvestigationOptions {
  issueNumber: number;
  text: string;
  responderUserId: string;
  slackThreadTs: string;
  /** Button / modal payload overrides */
  overrides?: Partial<SlackInvestigationResponse>;
}

export function parseSlackInvestigationText(options: ParseInvestigationOptions): SlackInvestigationResponse {
  const text = options.text ?? "";
  const normalized = text.toLowerCase();

  const verdict = options.overrides?.verdict ?? detectVerdict(normalized);
  const accountType = options.overrides?.accountType ?? detectAccountType(normalized);
  const blockedBy = options.overrides?.blockedBy ?? detectBlockedBy(normalized);

  const lifecycleMatch = text.match(LIFECYCLE_STATE_PATTERN);
  const stepsMatch = text.match(STEPS_PATTERN);
  const reachedFromText = [
    lifecycleMatch?.[1]?.trim(),
    stepsMatch?.[1]?.trim(),
    options.overrides?.lifecycleCoverage?.reachedStates,
  ]
    .filter(Boolean)
    .flat() as string[];

  const reachedStates = unique(
    [...(options.overrides?.lifecycleCoverage?.reachedStates ?? []), ...reachedFromText].filter(Boolean),
  );

  const requiredStates = options.overrides?.lifecycleCoverage?.requiredStates ?? defaultRequiredStates(verdict);

  const hasStructuredMarkers =
    Boolean(accountType) ||
    Boolean(blockedBy) ||
    reachedStates.length > 0 ||
    Boolean(text.match(/environment:/i)) ||
    Boolean(text.match(/steps executed:/i)) ||
    Boolean(text.match(/supporting evidence:/i));

  const coverageComplete =
    options.overrides?.lifecycleCoverage?.coverageComplete ??
    (hasStructuredMarkers && reachedStates.length > 0 && verdict !== "INCONCLUSIVE");

  const envUrl = text.match(ENV_URL_PATTERN)?.[1];
  const evidenceUrls = unique([
    ...(options.overrides?.evidenceUrls ?? []),
    ...[...text.matchAll(EVIDENCE_URL_PATTERN)].map((m) => m[1]),
  ]);

  return {
    issueNumber: options.issueNumber,
    verdict,
    accountType,
    blockedBy,
    lifecycleCoverage: {
      requiredStates,
      reachedStates,
      coverageComplete,
    },
    environment: {
      ...options.overrides?.environment,
      url: options.overrides?.environment?.url ?? envUrl,
    },
    evidenceUrls,
    notes: options.overrides?.notes ?? (text.length > 0 ? text : undefined),
    responderUserId: options.responderUserId,
    slackThreadTs: options.slackThreadTs,
  };
}

export function investigationToResultDetails(
  investigation: SlackInvestigationResponse,
): Record<string, unknown> {
  const reproduced =
    investigation.verdict === "REPRODUCED"
      ? true
      : investigation.verdict === "NOT_OBSERVED"
        ? false
        : null;

  const incompleteEvidence = !investigation.lifecycleCoverage.coverageComplete;

  return {
    evidenceSource: "manual_slack",
    reproduced,
    incompleteEvidence,
    verdict: investigation.verdict,
    accountType: investigation.accountType,
    blockedBy: investigation.blockedBy,
    lifecycleCoverage: {
      coverageComplete: investigation.lifecycleCoverage.coverageComplete,
      requiredStates: investigation.lifecycleCoverage.requiredStates,
      reachedStates: investigation.lifecycleCoverage.reachedStates,
    },
    environment: investigation.environment,
    evidenceUrls: investigation.evidenceUrls,
    slackThreadTs: investigation.slackThreadTs,
    reproUserId: investigation.responderUserId,
  };
}

export function isInvestigationComplete(investigation: SlackInvestigationResponse): boolean {
  if (investigation.verdict === "INCONCLUSIVE") return false;
  if (investigation.verdict === "BLOCKED" && !investigation.blockedBy) return false;
  if (investigation.verdict === "NOT_OBSERVED" && !investigation.lifecycleCoverage.coverageComplete) return false;
  return investigation.lifecycleCoverage.coverageComplete || investigation.verdict === "REPRODUCED";
}

function detectVerdict(normalized: string): SlackInvestigationVerdict {
  for (const entry of VERDICT_PATTERNS) {
    if (entry.patterns.some((p) => p.test(normalized))) {
      return entry.verdict;
    }
  }
  return "INCONCLUSIVE";
}

function detectAccountType(normalized: string): SlackAccountType | undefined {
  for (const entry of ACCOUNT_PATTERNS) {
    if (entry.patterns.some((p) => p.test(normalized))) {
      return entry.type;
    }
  }
  return undefined;
}

function detectBlockedBy(normalized: string): SlackBlockedBy | undefined {
  for (const entry of BLOCKED_PATTERNS) {
    if (entry.patterns.some((p) => p.test(normalized))) {
      return entry.blocked;
    }
  }
  return undefined;
}

function defaultRequiredStates(verdict: SlackInvestigationVerdict): string[] {
  if (verdict === "NOT_OBSERVED") {
    return ["login", "authenticated_hub"];
  }
  if (verdict === "REPRODUCED") {
    return ["reproduction_complete"];
  }
  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

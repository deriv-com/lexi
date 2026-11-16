export type LifecycleBlockedBy = "otp" | "kyc" | "payment" | "credentials" | "external_service";

export interface LifecycleCoverage {
  requiredStates: string[];
  reachedStates: string[];
  coverageComplete: boolean;
  missingStates: string[];
  blockedBy?: LifecycleBlockedBy;
}

const CHECKPOINT_STATE_MAP: Record<string, string[]> = {
  landing: ["signup_landing"],
  signup_entry: ["signup_form"],
  signup_form: ["signup_form"],
  post_country_select: ["signup_form"],
  otp_challenge: ["otp_challenge"],
  post_signup_dashboard: ["post_signup_authenticated", "dashboard_loaded"],
  dashboard: ["dashboard_loaded"],
  post_login_dashboard: ["post_login_authenticated"],
};

/**
 * Infer lifecycle states the reporter describes (untrusted issue text).
 */
export function inferRequiredLifecycleStates(title: string, body: string | null | undefined): string[] {
  const text = `${title} ${body ?? ""}`.toLowerCase();
  const states: string[] = [];

  if (
    /after\s+sign(?:ing)?\s+up|after\s+demo\s+signup|signed\s+up\s+to\s+demo|post[- ]signup|once\s+signed\s+up/.test(
      text,
    )
  ) {
    states.push("post_signup_authenticated");
  }

  if (/after\s+log(?:ging)?\s+in|post[- ]login|once\s+logged\s+in|signed\s+in/.test(text)) {
    states.push("post_login_authenticated");
  }

  if (/\bdashboard\b|home\s+screen/.test(text)) {
    states.push("dashboard_loaded");
  }

  if (/after\s+placing\s+a\s+trade|trade\s+submitted|after\s+trade/.test(text)) {
    states.push("trade_submitted");
  }

  return [...new Set(states)];
}

function parseLifecycleRecord(value: unknown): LifecycleCoverage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const requiredStates = Array.isArray(row.requiredStates)
    ? row.requiredStates.filter((s): s is string => typeof s === "string")
    : [];
  const reachedStates = Array.isArray(row.reachedStates)
    ? row.reachedStates.filter((s): s is string => typeof s === "string")
    : [];
  const missingStates = Array.isArray(row.missingStates)
    ? row.missingStates.filter((s): s is string => typeof s === "string")
    : requiredStates.filter((s) => !reachedStates.includes(s));
  const blockedBy = typeof row.blockedBy === "string" ? row.blockedBy : undefined;
  const coverageComplete =
    typeof row.coverageComplete === "boolean"
      ? row.coverageComplete
      : missingStates.length === 0 && requiredStates.length > 0;

  return {
    requiredStates,
    reachedStates,
    coverageComplete: requiredStates.length === 0 ? true : coverageComplete,
    missingStates,
    blockedBy: isLifecycleBlockedBy(blockedBy) ? blockedBy : undefined,
  };
}

function isLifecycleBlockedBy(value: string | undefined): value is LifecycleBlockedBy {
  return value === "otp" || value === "kyc" || value === "payment" || value === "credentials" || value === "external_service";
}

export function parseLifecycleCoverageFromDetails(
  details: Record<string, unknown> | null | undefined,
): LifecycleCoverage | null {
  if (!details) {
    return null;
  }
  return parseLifecycleRecord(details.lifecycleCoverage);
}

function inferReachedStatesFromEvidence(details: Record<string, unknown> | null): string[] {
  if (!details) {
    return [];
  }
  const reached = new Set<string>();

  const evidence = Array.isArray(details.evidence) ? details.evidence : [];
  for (const item of evidence) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const name = String((item as Record<string, unknown>).description ?? (item as Record<string, unknown>).name ?? "");
    const mapped = CHECKPOINT_STATE_MAP[name];
    if (mapped) {
      for (const state of mapped) {
        reached.add(state);
      }
    }
  }

  const attempts = Array.isArray(details.attempts) ? details.attempts : [];
  for (const attempt of attempts) {
    if (!attempt || typeof attempt !== "object") {
      continue;
    }
    const row = attempt as Record<string, unknown>;
    const lc = parseLifecycleRecord(row.lifecycleCoverage);
    if (lc) {
      for (const state of lc.reachedStates) {
        reached.add(state);
      }
    }
  }

  return [...reached];
}

export function mergeLifecycleCoverage(
  issue: { title: string; body: string | null | undefined },
  details: Record<string, unknown> | null | undefined,
): LifecycleCoverage {
  const requiredFromIssue = inferRequiredLifecycleStates(issue.title, issue.body);
  const fromBre = parseLifecycleCoverageFromDetails(details);

  const requiredStates =
    fromBre?.requiredStates.length ? fromBre.requiredStates : requiredFromIssue.length > 0 ? requiredFromIssue : [];

  const reachedStates = fromBre?.reachedStates.length
    ? fromBre.reachedStates
    : inferReachedStatesFromEvidence(details ?? null);

  const missingStates = requiredStates.filter((state) => !reachedStates.includes(state));
  const coverageComplete = requiredStates.length === 0 || missingStates.length === 0;

  return {
    requiredStates,
    reachedStates,
    coverageComplete,
    missingStates,
    blockedBy: fromBre?.blockedBy,
  };
}

export function deriveIncompleteEvidenceFromLifecycle(lifecycle: LifecycleCoverage): boolean {
  return lifecycle.requiredStates.length > 0 && !lifecycle.coverageComplete;
}

export function lifecycleAutoCloseBlockReason(lifecycle: LifecycleCoverage): string {
  if (lifecycle.missingStates.includes("post_signup_authenticated")) {
    return "Auto-close blocked: the reported post-signup state was not reached. Evidence covers only the signup form.";
  }
  if (lifecycle.missingStates.includes("post_login_authenticated")) {
    return "Auto-close blocked: the reported post-login state was not reached. Evidence covers only the pre-auth flow.";
  }
  if (lifecycle.missingStates.length > 0) {
    return `Auto-close blocked: required lifecycle state(s) not reached: ${lifecycle.missingStates.join(", ")}.`;
  }
  return "Auto-close blocked: lifecycle coverage incomplete.";
}

/**
 * Merge lifecycle coverage into reproduction resultDetails and set incompleteEvidence.
 */
export function enrichResultDetailsWithLifecycle(
  issue: { title: string; body: string | null | undefined },
  details: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const lifecycle = mergeLifecycleCoverage(issue, details);
  const enriched: Record<string, unknown> = details ? { ...details } : {};

  if (lifecycle.requiredStates.length > 0 || parseLifecycleCoverageFromDetails(details)) {
    enriched.lifecycleCoverage = lifecycle;
  }

  if (deriveIncompleteEvidenceFromLifecycle(lifecycle)) {
    enriched.incompleteEvidence = true;
  } else if (details?.incompleteEvidence === true) {
    enriched.incompleteEvidence = true;
  } else if (lifecycle.requiredStates.length > 0 && lifecycle.coverageComplete) {
    enriched.incompleteEvidence = false;
  }

  if (!details && Object.keys(enriched).length === 0) {
    return null;
  }
  return enriched;
}

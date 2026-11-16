/**
 * A security review catalogue: one row per control a change must show evidence
 * for. The catalogue is a checklist, not a scanner — attaching evidence to a row
 * records that someone looked, it does not assert the control holds.
 *
 * The rows below are a generic starting point. Replace them with your own
 * organisation's catalogue; the evaluator only depends on `id` and `category`.
 */
export interface SecurityReviewCriterion {
  id: string;
  category: string;
  description: string;
}

export const SECURITY_REVIEW_CRITERIA: readonly SecurityReviewCriterion[] = Object.freeze([
  { id: "SEC-01", category: "Authentication", description: "Caching and session handling preserve the caller's identity and never serve one user's data to another." },
  { id: "SEC-02", category: "Authentication", description: "Every new endpoint or route requires authentication unless it is intentionally public." },
  { id: "SEC-03", category: "Authorization", description: "Access checks run on the server for every read and write, not only in the UI." },
  { id: "SEC-04", category: "Authorization", description: "Objects are looked up through the caller's scope, so an identifier alone grants nothing." },
  { id: "SEC-05", category: "Secrets", description: "No secrets, tokens or keys are committed to source or written to logs." },
  { id: "SEC-06", category: "Secrets", description: "New credentials are stored in the secret manager and rotated on a schedule." },
  { id: "SEC-07", category: "Input handling", description: "Untrusted input is validated against a schema at the boundary." },
  { id: "SEC-08", category: "Input handling", description: "Output is encoded for its context, and queries are parameterised." },
  { id: "SEC-09", category: "Data protection", description: "Personal data collected by the change is necessary, minimised and documented." },
  { id: "SEC-10", category: "Data protection", description: "Sensitive data is encrypted in transit and at rest." },
  { id: "SEC-11", category: "Dependencies", description: "New dependencies are licensed compatibly and free of known critical vulnerabilities." },
  { id: "SEC-12", category: "Dependencies", description: "Lockfiles are updated and builds are reproducible." },
  { id: "SEC-13", category: "Abuse resistance", description: "Expensive or paid operations are rate-limited and have bounded retries." },
  { id: "SEC-14", category: "Abuse resistance", description: "Mutating operations are idempotent or protected against replay." },
  { id: "SEC-15", category: "Logging", description: "Security-relevant events are logged with enough context to investigate, and without sensitive payloads." },
  { id: "SEC-16", category: "Error handling", description: "Errors fail closed and do not leak stack traces or internal details to callers." },
  { id: "SEC-17", category: "Operations", description: "The change has an owner, a rollback path and monitoring for its failure modes." },
]);

export type SecurityCriteriaRefusalCode = "MISSING_EVIDENCE";

export interface SecurityCriteriaRefusal {
  code: SecurityCriteriaRefusalCode;
  criterionId: string;
  detail: string;
}

export interface SecurityCriteriaEvaluation {
  allowed: boolean;
  refusals: SecurityCriteriaRefusal[];
  coveredIds: string[];
  missing: SecurityReviewCriterion[];
}

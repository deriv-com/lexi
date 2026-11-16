/**
 * The review gate — three domains, distinct owners, no silent waivers.
 *
 * Pure evaluation over a ledger of recorded verdicts. Nothing here reads a
 * database or writes anything; callers pass the verdicts and the clock, which is
 * what makes expiry testable without freezing time globally.
 *
 * This is the ONLY place the independence rule can live. `AuthorizationService`
 * answers "may this actor record a verdict" and cannot answer "has this actor
 * already recorded one in another domain on this change" — that is a question
 * about the ledger, not about the actor's grants. See
 * `packages/contracts/src/review-verdict.ts` for why the design is one
 * permission plus a domain column rather than three roles.
 *
 * FAILS CLOSED. Every refusal path returns `allowed: false`. There is no
 * override parameter and no `force`, deliberately: `assessPreDispatch` has a
 * `force` escape that the refusal text itself coaches callers toward, and that
 * pattern is exactly what makes a gate advisory. If a change genuinely must ship
 * past a refusal, the mechanism is a recorded time-bounded exception with an
 * accountable owner — which is a verdict, visible in the ledger — not a boolean
 * that leaves no trace.
 */

import {
  REVIEW_DOMAINS,
  type ReviewDomain,
  type ReviewGateEvaluation,
  type ReviewGateInput,
  type ReviewGateRefusal,
  type ReviewVerdictRecord,
} from "./review-verdict.types";

/**
 * Latest verdict per domain, among rows already scoped to one changeRef.
 *
 * A domain can legitimately be re-reviewed — a `fail` that becomes a `pass`
 * after rework. Ordering is by `recordedAt`. This function is pure: it compares
 * the strings it is given. The write path (`PrismaReviewVerdictStore`) is what
 * stamps that field from the store clock, so a caller of `evaluateReviewGate`
 * who synthesises records in a unit test can still control order. Production
 * evaluation reads rows the store stamped; it never takes a submitter clock.
 *
 * Ties keep the later array element. Two verdicts sharing a millisecond is
 * pathological rather than meaningful, and picking one deterministically beats
 * an ordering that varies per call.
 */
function scopedToChange(
  verdicts: readonly ReviewVerdictRecord[],
  changeRef: string,
): ReviewVerdictRecord[] {
  return verdicts.filter((verdict) => verdict.changeRef === changeRef);
}

function latestByDomain(
  verdicts: readonly ReviewVerdictRecord[],
): Map<ReviewDomain, ReviewVerdictRecord> {
  const latest = new Map<ReviewDomain, ReviewVerdictRecord>();
  for (const verdict of verdicts) {
    const existing = latest.get(verdict.domain);
    if (!existing || verdict.recordedAt >= existing.recordedAt) {
      latest.set(verdict.domain, verdict);
    }
  }
  return latest;
}

function fieldText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Is this exception structurally complete?
 *
 * Checked at evaluation time rather than trusted from write time. A Prisma
 * `Json?` row can be `{}` or missing keys. Calling `.trim()` on `undefined`
 * would throw — and a throw is not `EXCEPTION_INCOMPLETE`. Missing keys are
 * incomplete.
 */
function exceptionIsComplete(verdict: ReviewVerdictRecord): boolean {
  const exception = verdict.exception;
  if (!exception || typeof exception !== "object") return false;
  return (
    fieldText(exception.expiresAt) !== "" &&
    fieldText(exception.monitoring) !== "" &&
    fieldText(exception.remediation) !== "" &&
    fieldText(exception.ownerId) !== ""
  );
}

function hasEvidenceUri(verdict: ReviewVerdictRecord): boolean {
  return (verdict.evidence ?? []).some((item) => fieldText(item?.uri) !== "");
}

function hasPerformanceEvidence(verdict: ReviewVerdictRecord): boolean {
  return (verdict.evidence ?? []).some(
    (item) => item?.kind === "performance" && fieldText(item.uri) !== "",
  );
}

function isAuthor(actorId: string, inputAuthorId: string, recordAuthorId: string | undefined): boolean {
  if (actorId === inputAuthorId) return true;
  return typeof recordAuthorId === "string" && recordAuthorId.length > 0 && actorId === recordAuthorId;
}

/**
 * Evaluate the gate for one change.
 *
 * Collects EVERY refusal rather than returning the first. A reviewer who is told
 * only "security has no owner", fixes it, and is then told "and design's
 * exception expired" learns the gate one refusal per round trip. The gate's whole
 * point is that the three domains are visible together.
 */
export function evaluateReviewGate(input: ReviewGateInput): ReviewGateEvaluation {
  const refusals: ReviewGateRefusal[] = [];
  // Independence and coverage are scoped to this change. A verdict for another
  // changeRef in the same array is someone else's review, not coverage here.
  const scoped = scopedToChange(input.verdicts, input.changeRef);
  const latest = latestByDomain(scoped);
  const coveredDomains = REVIEW_DOMAINS.filter((domain) => latest.has(domain));
  const distinctOwners = new Set([...latest.values()].map((verdict) => verdict.actorId)).size;

  // 1. Coverage. Named per missing domain, because "review incomplete" does not
  //    tell anyone who to go and find. "Distinct owners" is a count of actors
  //    on the latest rows, not of domains that merely have a row.
  for (const domain of REVIEW_DOMAINS) {
    if (!latest.has(domain)) {
      refusals.push({
        code: "DOMAIN_UNCOVERED",
        domain,
        detail:
          `No ${domain} verdict recorded for ${input.changeRef}. ` +
          `${distinctOwners} distinct owner(s) across ${coveredDomains.length} of ` +
          `${REVIEW_DOMAINS.length} domains; ${domain} has none. This blocks ` +
          `rather than accepting partial review — one green domain cannot waive another.`,
      });
    }
  }

  // 2. Self-review. Checked across all scoped verdicts, not just the latest
  //    per domain: a superseded self-verdict still happened. Compared to both
  //    the caller-supplied author and the author stamped on the row.
  for (const verdict of scoped) {
    if (isAuthor(verdict.actorId, input.authorId, verdict.authorId)) {
      refusals.push({
        code: "SELF_VERDICT_FORBIDDEN",
        domain: verdict.domain,
        actorId: verdict.actorId,
        detail:
          `${verdict.actorId} authored ${input.changeRef} and also recorded ` +
          `its ${verdict.domain} verdict. An author cannot review their own ` +
          `change.`,
      });
    }
  }

  // 3. Cross-domain actor. One human holding two domains on THIS change.
  const domainsByActor = new Map<string, Set<ReviewDomain>>();
  for (const verdict of scoped) {
    const domains = domainsByActor.get(verdict.actorId) ?? new Set<ReviewDomain>();
    domains.add(verdict.domain);
    domainsByActor.set(verdict.actorId, domains);
  }
  for (const [actorId, domains] of domainsByActor) {
    if (domains.size > 1) {
      const listed = [...domains].sort().join(", ");
      refusals.push({
        code: "CROSS_DOMAIN_ACTOR",
        actorId,
        detail:
          `${actorId} recorded verdicts in ${domains.size} domains ` +
          `(${listed}) on ${input.changeRef}. Each domain needs a distinct ` +
          `accountable owner.`,
      });
    }
  }

  // 4. Per-domain outcome.
  for (const domain of REVIEW_DOMAINS) {
    const verdict = latest.get(domain);
    if (!verdict) continue;

    if (verdict.outcome === "fail") {
      refusals.push({
        code: "BLOCKING_FAILURE",
        domain,
        detail:
          `${domain} verdict is fail for ${input.changeRef}` +
          (verdict.rationale ? `: ${verdict.rationale}` : "") +
          `. A non-pass blocks unless an accountable, time-bounded exception ` +
          `defines monitoring and remediation.`,
      });
      continue;
    }

    if (verdict.outcome === "pass" || verdict.outcome === "exception") {
      if (!hasEvidenceUri(verdict)) {
        refusals.push({
          code: "EVIDENCE_REQUIRED",
          domain,
          detail:
            `${domain} ${verdict.outcome} for ${input.changeRef} carries no evidence URI. ` +
            `Verdicts are evidence-backed; a name on a row is not a review.`,
        });
      }
    }

    if (
      domain === "engineering" &&
      input.performanceBudgetSet === true &&
      (verdict.outcome === "pass" || verdict.outcome === "exception") &&
      !hasPerformanceEvidence(verdict)
    ) {
      refusals.push({
        code: "PERFORMANCE_EVIDENCE_REQUIRED",
        domain,
        detail:
          `A performance budget was set at spec time and the engineering ` +
          `${verdict.outcome} for ${input.changeRef} has no evidence with ` +
          `kind=performance. Required only because the budget exists — ` +
          `absence of a budget does not block.`,
      });
    }

    if (verdict.outcome !== "exception") continue;

    if (!exceptionIsComplete(verdict)) {
      refusals.push({
        code: "EXCEPTION_INCOMPLETE",
        domain,
        detail:
          `${domain} exception for ${input.changeRef} is missing at least one ` +
          `of expiry, monitoring, remediation or owner. An exception without ` +
          `all four is a permanent deviation wearing a temporary label.`,
      });
      continue;
    }

    const ownerId = fieldText(verdict.exception!.ownerId);
    if (isAuthor(ownerId, input.authorId, verdict.authorId)) {
      refusals.push({
        code: "EXCEPTION_OWNER_IS_AUTHOR",
        domain,
        actorId: ownerId,
        detail:
          `${domain} exception for ${input.changeRef} names the change author ` +
          `(${ownerId}) as accountable. Residual risk cannot sit with the author.`,
      });
    }

    const expiresAt = Date.parse(verdict.exception!.expiresAt);
    const now = Date.parse(input.now);
    if (Number.isNaN(expiresAt) || Number.isNaN(now) || expiresAt <= now) {
      refusals.push({
        code: "EXCEPTION_EXPIRED",
        domain,
        detail:
          `${domain} exception for ${input.changeRef} expired at ` +
          `${verdict.exception!.expiresAt} (evaluated ${input.now}). ` +
          `Re-review or record a new exception with a fresh owner and expiry.`,
      });
    }
  }

  return { allowed: refusals.length === 0, refusals, coveredDomains };
}

/**
 * One-line operator summary of an evaluation.
 *
 * Exists so Slack and the audit trail render a refusal the same way. The gate's
 * accepted limit — that four people may not supply three distinct reviewers — is
 * only useful if the refusal states *which* domain is uncovered, so the summary
 * leads with the codes rather than a count.
 */
export function summariseReviewGate(evaluation: ReviewGateEvaluation): string {
  if (evaluation.allowed) {
    return `Review gate passed: ${evaluation.coveredDomains.join(", ")} all approved by distinct owners.`;
  }
  const codes = [...new Set(evaluation.refusals.map((r) => r.code))].join(", ");
  return `Review gate blocked (${codes}). ${evaluation.refusals.map((r) => r.detail).join(" ")}`;
}

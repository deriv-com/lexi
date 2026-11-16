import type { EscalationPolicy } from "./escalation-policy.schema";

/**
 * Acknowledgement detection: a reaction or a reply stops the ladder.
 *
 * Deterministic and pure, like rung selection: whether an emoji counts as
 * someone picking up the work is a membership test, not a judgement call.
 *
 * Two rules here exist because their absence would be a live bug rather than a
 * missing nicety:
 *
 *   - **Lexi never acknowledges itself.** Lexi posts the escalation and, in
 *     several existing flows, reacts to its own message to show progress. If
 *     that counted, every escalation would self-ack within seconds of being
 *     sent and the ladder would never climb.
 *   - **Only people responsible for the work acknowledge it.** A bystander
 *     adding :eyes: in a team channel is not a commitment to fix anything.
 *     The caller decides who qualifies — the assignee, plus whoever was
 *     notified at the current rung — so a lead answering the TEAM_LEAD rung
 *     stops the ladder just as the PIC answering theirs does.
 */

/** A Slack interaction that might constitute an acknowledgement. */
export interface AckCandidate {
  kind: "reaction" | "reply";
  /** Slack user id or GitHub login — whichever the source event carries. */
  actor: string;
  at: Date;
}

export interface AckContext {
  /**
   * Identities whose acknowledgement counts, in any mix of Slack ids and
   * GitHub logins. The self actor is filtered out even if it appears here.
   */
  acknowledgers: readonly string[];
  policy: EscalationPolicy;
  /**
   * When the escalation being acknowledged was sent. Activity before it
   * cannot be a response to it — that is pre-existing chatter, and treating it
   * as an ack would silently cancel an escalation nobody has seen.
   */
  notifiedAt?: Date | null;
}

export interface AcknowledgementRecord {
  ackedAt: Date;
  ackedBy: string;
}

function kindEnabled(kind: AckCandidate["kind"], policy: EscalationPolicy): boolean {
  return kind === "reaction" ? policy.acknowledgement.stopOnReaction : policy.acknowledgement.stopOnThreadReply;
}

/** Whether one event stops the ladder for its subject. */
export function isAcknowledgement(event: AckCandidate, ctx: AckContext): boolean {
  if (!kindEnabled(event.kind, ctx.policy)) {
    return false;
  }

  const actor = event.actor.toLowerCase();

  // No GitHub App acknowledges anything, whatever it is called.
  //
  // The `selfActor` comparison below is an identity match against a configured
  // string, so a misconfigured name matches nothing and that exclusion is
  // inert. This check does not depend on configuration: an automated comment
  // must never silence the ladder.
  //
  // GitHub reserves the `[bot]` suffix for Apps (a username cannot contain
  // `[`), so this holds without anyone maintaining a roster of automation. A
  // suffix test, not a substring one: `abbot` is a person.
  if (actor.endsWith("[bot]")) {
    return false;
  }

  if (actor === ctx.policy.staleness.selfActor.toLowerCase()) {
    return false;
  }

  if (!ctx.acknowledgers.some((identity) => identity.toLowerCase() === actor)) {
    return false;
  }

  if (ctx.notifiedAt && event.at < ctx.notifiedAt) {
    return false;
  }

  return true;
}

/**
 * The first qualifying acknowledgement, or null.
 *
 * Earliest rather than latest: `ackedAt` records when the work was picked up,
 * which is what a "how long did this sit unattended" question is actually
 * asking. Taking the most recent ack would make a subject look freshly
 * attended every time someone added another emoji.
 */
export function findAcknowledgement(
  events: readonly AckCandidate[],
  ctx: AckContext,
): AcknowledgementRecord | null {
  const qualifying = events.filter((event) => isAcknowledgement(event, ctx));
  if (qualifying.length === 0) {
    return null;
  }

  const earliest = qualifying.reduce((first, event) => (event.at < first.at ? event : first));
  return { ackedAt: earliest.at, ackedBy: earliest.actor };
}

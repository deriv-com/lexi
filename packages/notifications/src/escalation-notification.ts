import type { EscalationPolicy, EscalationRung } from "./escalation-policy.schema";
import type { RenderedNotification } from "./types";

/**
 * Rung routing and message rendering for the escalation ladder.
 *
 * The governance channel arrives as data on `policy.governance.channelId` and
 * is never written in this file — not even in a comment, which is why this one
 * does not quote the id. The audit flagged hard-coded Slack channel ids in the
 * dispatch path as debt, and `tests/config/policy-config-freeze.spec.ts`
 * asserts the id appears in no TypeScript source at all.
 *
 * ## Escalating by audience, not by destination
 *
 * Lexi holds no DM scope. It cannot message a person; it can only post in a
 * channel and @-mention them there. So `PIC`, `TEAM_LEAD` and `MANAGER` all
 * resolve to the *same* platform team channel and differ only in who is
 * tagged, and only `GOVERNANCE` changes destination. Each rung therefore lands
 * in front of everyone who watched the previous rung go unanswered, which is
 * the intended mechanism rather than a workaround.
 */

/**
 * A person the ladder can tag.
 *
 * Structurally identical to `OwnershipPerson` from `@lexi/ownership`, and
 * declared here rather than imported for the same reason `LadderStateSnapshot`
 * narrows a Prisma row locally: this package stays a leaf that renders Slack
 * messages, and the ownership package stays free to grow without dragging a
 * dependency edge behind it. An `OwnershipPerson` is assignable to this with
 * no adapter.
 */
export interface EscalationPerson {
  githubLogin: string;
  /** Absent when the directory has no Slack link for this login — never invented. */
  slackId?: string;
  displayName?: string;
}

/** Where one subject's escalations go, and who is tagged at each rung. */
export interface EscalationRecipients {
  /**
   * The module's platform team channel (`#team-web` /
   * `#team-mobile`). Every pre-governance rung posts here.
   */
  teamChannelId?: string | null;
  /** Person-in-charge for this module on this platform. */
  pic?: EscalationPerson | null;
  teamLead?: EscalationPerson | null;
  /** The lead's manager, from the `managerGithub` edge. */
  manager?: EscalationPerson | null;
}

export interface RungTarget {
  channel: string;
  kind: "channel";
  /** The rung that was *due*, which is what gets persisted — not where it landed. */
  rung: EscalationRung;
  /** The rung actually delivered at, after any fall-forward. */
  deliveredRung: EscalationRung;
  /** Who to @-mention. Null at governance, and when nobody resolved. */
  person: EscalationPerson | null;
  /** True when the due rung's person could not be resolved and the ladder advanced. */
  fellForward: boolean;
  /**
   * True when `person` resolved but carries no Slack id, so the message names
   * them without actually notifying them. Callers log this: it is a directory
   * gap, not a routing failure.
   */
  degraded: boolean;
}

/** Same person? Compared on login, the only identifier always present. */
function samePerson(a: EscalationPerson | null | undefined, b: EscalationPerson | null | undefined): boolean {
  if (!a || !b) return false;
  return a.githubLogin.trim().toLowerCase() === b.githubLogin.trim().toLowerCase();
}

/**
 * Who a rung tags, or null when that rung has nobody distinct to escalate to.
 *
 * The de-duplication is the point. A module PIC is frequently also the platform
 * lead (Bob owns the default web module *and* leads web), and a lead is
 * occasionally their own manager in a sparse directory. Tagging the same person
 * again one rung later is not an escalation — it is the same message with a
 * louder emoji — so those rungs report "nobody" and the ladder moves past them.
 */
function personForRung(rung: EscalationRung, recipients: EscalationRecipients): EscalationPerson | null {
  switch (rung) {
    case "PIC":
      return recipients.pic ?? null;
    case "TEAM_LEAD":
      return samePerson(recipients.teamLead, recipients.pic) ? null : recipients.teamLead ?? null;
    case "MANAGER":
      return samePerson(recipients.manager, recipients.pic) || samePerson(recipients.manager, recipients.teamLead)
        ? null
        : recipients.manager ?? null;
    case "GOVERNANCE":
      return null;
  }
}

/**
 * Where a rung's message goes and who it tags.
 *
 * An unresolvable person falls *forward* — to the next rung, ending at
 * governance — rather than being skipped. A dropped escalation is the worse
 * failure: the ladder would appear to advance while nobody was ever told, and
 * the subject would sit at a rung it never actually reached. Falling forward is
 * noisier and correct.
 *
 * A person who resolves but has no Slack id is deliberately *not* a
 * fall-forward. The message still names them in their own team's channel, which
 * is most of the pressure; escalating on every directory gap would send the
 * entire backlog to the manager the day the directory is incomplete — which is
 * the day this ships.
 *
 * The walk follows the *configured* ladder, so a policy that omits a rung falls
 * past it rather than resurrecting it. Governance is the terminal target and
 * always resolves, because its channel is a required config key. That is what
 * makes "never drops an escalation" a property rather than a hope.
 */
export function resolveRungTarget(
  rung: EscalationRung,
  recipients: EscalationRecipients,
  policy: EscalationPolicy,
): RungTarget {
  const order = policy.ladder.map((step) => step.rung);
  const startIndex = Math.max(0, order.indexOf(rung));

  for (let index = startIndex; index < order.length; index += 1) {
    const candidate = order[index];
    if (candidate === "GOVERNANCE") break;

    const person = personForRung(candidate, recipients);
    if (person && recipients.teamChannelId) {
      return {
        channel: recipients.teamChannelId,
        kind: "channel",
        rung,
        deliveredRung: candidate,
        person,
        fellForward: candidate !== rung,
        degraded: !person.slackId,
      };
    }
  }

  return {
    channel: policy.governance.channelId,
    kind: "channel",
    rung,
    deliveredRung: "GOVERNANCE",
    person: null,
    fellForward: rung !== "GOVERNANCE",
    degraded: false,
  };
}

/** A subject the ladder is escalating, as the renderer needs to see it. */
export interface EscalationSubjectView {
  subjectType: "work_item" | "issue" | "pull_request";
  /** Stable identity — the value persisted on `EscalationLadderState.subjectId`. */
  subjectId: string;
  title: string;
  url?: string | null;
  idleHours: number;
  /** PRs this subject is still waiting on, from `deliveryProgress`. */
  pendingPrNumbers?: number[];
}

export interface RungNotificationInput {
  /** Where this is going and who it tags, from `resolveRungTarget`. */
  target: RungTarget;
  subject: EscalationSubjectView;
  policy: EscalationPolicy;
  now: Date;
}

function header(text: string): Record<string, unknown> {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

function section(text: string): Record<string, unknown> {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(elements: string[]): Record<string, unknown> {
  return { type: "context", elements: elements.map((text) => ({ type: "mrkdwn", text })) };
}

/** Whole days, rounded down, with a plural that reads correctly at 1. */
function ageText(idleHours: number): string {
  const days = Math.floor(idleHours / 24);
  if (days < 1) {
    const hours = Math.floor(idleHours);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}

function subjectLine(subject: EscalationSubjectView): string {
  return subject.url ? `<${subject.url}|${subject.subjectId}> — *${subject.title}*` : `*${subject.title}* (${subject.subjectId})`;
}

const RUNG_HEADLINE: Record<EscalationRung, string> = {
  PIC: ":alarm_clock: This is waiting on you",
  TEAM_LEAD: ":warning: Escalated — no response from the person in charge",
  MANAGER: ":rotating_light: Escalated again — still no response",
  GOVERNANCE: ":rotating_light: Escalation exhausted",
};

/** Why a message is landing on someone who is not the PIC. */
const RUNG_PREAMBLE: Partial<Record<EscalationRung, string>> = {
  TEAM_LEAD: "The person in charge has not picked this up.",
  MANAGER: "This has now gone unanswered by both the person in charge and the team lead.",
};

/**
 * How to address a person in Slack.
 *
 * A Slack id is a real mention and the only thing that notifies anyone. Without
 * one, the honest fallback is a *plain bold name* — never `<@github-login>`,
 * which Slack renders as a broken mention that looks exactly like a working one
 * and pings nobody. Reading the name and quietly not being notified is a
 * recoverable failure; believing you were tagged when you were not is not.
 */
function mentionOf(person: EscalationPerson): string {
  if (person.slackId) return `<@${person.slackId}>`;
  return `*${person.displayName ?? person.githubLogin}*`;
}

/**
 * The message sent at one rung.
 *
 * Every rung states how to stop the ladder, because an escalation the
 * recipient cannot silence is one they learn to ignore. At GOVERNANCE the
 * message says plainly that there is nothing above it, and a reader should not
 * wait for an escalation that will never come.
 */
export function renderRungNotification(input: RungNotificationInput): RenderedNotification {
  const { target, subject, policy } = input;
  const rung = target.deliveredRung;
  const age = ageText(subject.idleHours);
  const blocks: Array<Record<string, unknown>> = [header(RUNG_HEADLINE[rung]), section(subjectLine(subject))];

  const preamble = RUNG_PREAMBLE[rung];
  const mention = target.person ? `${mentionOf(target.person)} ` : "";
  blocks.push(section(`${mention}No progress for *${age}*.${preamble ? ` ${preamble}` : ""}`));

  // A fall-forward means the rung that was due had nobody to tag. Saying so
  // explains why a lead is reading a message the PIC should have got, and
  // points at the fixable cause rather than leaving it looking arbitrary.
  if (target.fellForward && target.rung !== rung) {
    blocks.push(
      context([
        `Escalated from the ${target.rung} rung — no ${target.rung === "PIC" ? "person in charge" : "recipient"} could be resolved for it.`,
      ]),
    );
  }

  if (target.degraded && target.person) {
    blocks.push(
      context([
        `:warning: No Slack ID on file for \`${target.person.githubLogin}\`, so they were *not notified* directly — ` +
          "add one to `config/people-overrides.yaml`.",
      ]),
    );
  }

  if (subject.pendingPrNumbers && subject.pendingPrNumbers.length > 0) {
    const prs = subject.pendingPrNumbers.map((number) => `#${number}`).join(", ");
    blocks.push(section(`Still waiting on ${subject.pendingPrNumbers.length > 1 ? "PRs" : "PR"} ${prs} to merge.`));
  }

  if (rung === "GOVERNANCE") {
    blocks.push(
      section(
        `This is the final rung — there is no further escalation above ${policy.governance.channelName}. ` +
          "It stays here until someone picks it up.",
      ),
    );
  }

  blocks.push(context(["React or reply to acknowledge — that stops the reminders."]));

  return { text: `${RUNG_HEADLINE[rung]}: ${subject.title} — no progress for ${age}`, blocks };
}

/** One row of the `/lexi stuck` report. */
export interface StuckSubject extends EscalationSubjectView {
  /** Current rung, or null when the subject has never been escalated. */
  rung: EscalationRung | null;
  ackedAt?: Date | null;
  ackedBy?: string | null;
}

export interface StuckReportOptions {
  policy: EscalationPolicy;
  now: Date;
  /**
   * Rows to render before truncating. Slack rejects a message over 50 blocks,
   * and the report adds a header, a summary and a footer around the rows.
   */
  maxRows?: number;
}

const DEFAULT_MAX_ROWS = 40;

/**
 * `/lexi stuck` — everything past SLA, with its current rung and age.
 *
 * Sorted most-stuck-first so the answer to "what is worst right now" is the
 * first line, and truncated with an explicit count rather than silently, since
 * a report that hides half the backlog is worse than one that admits it.
 */
export function renderStuckReport(subjects: readonly StuckSubject[], options: StuckReportOptions): RenderedNotification {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;

  if (subjects.length === 0) {
    return {
      text: "Nothing is past SLA.",
      blocks: [header(":white_check_mark: Nothing stuck"), section("Nothing is past SLA right now.")],
    };
  }

  const ordered = [...subjects].sort((a, b) => b.idleHours - a.idleHours);
  const shown = ordered.slice(0, maxRows);

  const blocks: Array<Record<string, unknown>> = [
    header(":hourglass_flowing_sand: Past SLA"),
    section(`*${subjects.length}* item${subjects.length === 1 ? "" : "s"} past SLA, most stalled first.`),
  ];

  for (const subject of shown) {
    const rung = subject.rung ?? "not yet escalated";
    const acked = subject.ackedAt ? ` · acknowledged${subject.ackedBy ? ` by <@${subject.ackedBy}>` : ""}` : "";
    blocks.push(section(`${subjectLine(subject)}\n_${ageText(subject.idleHours)} idle · rung: ${rung}${acked}_`));
  }

  if (ordered.length > shown.length) {
    blocks.push(context([`Showing ${shown.length} of ${subjects.length}. Narrow the query to see the rest.`]));
  }

  return { text: `${subjects.length} item(s) past SLA`, blocks };
}

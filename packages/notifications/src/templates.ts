import { NotificationContext, RenderedNotification } from "./types";

function header(text: string): Record<string, unknown> {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

function section(text: string): Record<string, unknown> {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(elements: string[]): Record<string, unknown> {
  return { type: "context", elements: elements.map((text) => ({ type: "mrkdwn", text })) };
}

function issueLine(ctx: NotificationContext): string {
  return `<${ctx.issue.url}|${ctx.issue.repoOwner}/${ctx.issue.repoName}#${ctx.issue.number}> - *${ctx.issue.title}*`;
}

export function renderVerifiedTemplate(ctx: NotificationContext): RenderedNotification {
  const decision = ctx.decision;
  const text = `:white_check_mark: Bug verified: ${ctx.issue.repoOwner}/${ctx.issue.repoName}#${ctx.issue.number}`;
  return {
    text,
    blocks: [
      header(":white_check_mark: Bug Verified"),
      section(issueLine(ctx)),
      section(decision?.summary ?? "The reproduction bot confirmed this bug."),
      section(`*Next action:* ${decision?.nextAction ?? "Assign to owning team."}`),
      context([
        `*Team:* ${ctx.team ?? "unassigned"}`,
        `*Owner:* ${ctx.owner ?? "unassigned"}`,
        `*Confidence:* ${decision ? Math.round(decision.confidence * 100) : 0}%`,
      ]),
    ],
  };
}

export function renderNeedsInfoTemplate(ctx: NotificationContext): RenderedNotification {
  const decision = ctx.decision;
  const text = `:grey_question: Needs more info: ${ctx.issue.repoOwner}/${ctx.issue.repoName}#${ctx.issue.number}`;
  return {
    text,
    blocks: [
      header(":grey_question: Needs More Information"),
      section(issueLine(ctx)),
      section(decision?.summary ?? "This issue is missing information required to triage it."),
      section(`*Why:* ${decision?.reasoning ?? "Reproduction steps or environment details are unclear."}`),
      section(`*Next action:* ${decision?.nextAction ?? "Ask the reporter for more details."}`),
      context([`*Team:* ${ctx.team ?? "unassigned"}`]),
    ],
  };
}

export function renderCannotReproduceTemplate(ctx: NotificationContext): RenderedNotification {
  const decision = ctx.decision;
  const text = `:warning: Cannot reproduce: ${ctx.issue.repoOwner}/${ctx.issue.repoName}#${ctx.issue.number}`;
  return {
    text,
    blocks: [
      header(":warning: Cannot Reproduce"),
      section(issueLine(ctx)),
      section(decision?.summary ?? "The reproduction bot could not trigger the reported behavior."),
      section(`*Next action:* ${decision?.nextAction ?? "Retry reproduction or request additional detail."}`),
      context([`*Team:* ${ctx.team ?? "unassigned"}`]),
    ],
  };
}

export function renderManualInvestigationTemplate(ctx: NotificationContext): RenderedNotification {
  const decision = ctx.decision;
  const text = `:mag: Manual investigation needed: ${ctx.issue.repoOwner}/${ctx.issue.repoName}#${ctx.issue.number}`;
  return {
    text,
    blocks: [
      header(":mag: Needs Manual Investigation"),
      section(issueLine(ctx)),
      section(decision?.summary ?? "Automated triage could not confidently classify this issue."),
      section(`*Reasoning:* ${decision?.reasoning ?? "Not enough signal for an automated decision."}`),
      section(`*Next action:* ${decision?.nextAction ?? "A human should manually triage this issue."}`),
      context([`*Team:* ${ctx.team ?? "unassigned"}`, `*Owner:* ${ctx.owner ?? "unassigned"}`]),
    ],
  };
}

/**
 * Whether this render was given a real staleness age.
 *
 * Both of these templates used `ctx.daysSinceLastUpdate ?? 0`, which turned
 * "nobody told me" into the assertion "0 day(s)" — so a hand-off routed through
 * the ESCALATION template (a hand-off decision) announced an issue as
 * "stalled for 0 day(s) with no progress", a stall that had not happened, on an
 * issue that had just been worked. Only the staleness ladder supplies an age;
 * its absence means this is not a staleness message, so say nothing about time.
 */
function staleFor(ctx: NotificationContext): number | null {
  return typeof ctx.daysSinceLastUpdate === "number" ? ctx.daysSinceLastUpdate : null;
}

export function renderReminderTemplate(ctx: NotificationContext): RenderedNotification {
  const days = staleFor(ctx);
  const text = `:alarm_clock: Reminder: ${ctx.issue.repoOwner}/${ctx.issue.repoName}#${ctx.issue.number} needs attention`;
  const body =
    days === null
      ? (ctx.reason ?? "This issue needs attention.")
      : `This issue has had no progress in *${days} day(s)*. ${ctx.reason ?? ""}`;
  return {
    text,
    blocks: [
      header(":alarm_clock: Reminder"),
      section(issueLine(ctx)),
      section(body.trim()),
      context([`*Team:* ${ctx.team ?? "unassigned"}`, `*Owner:* ${ctx.owner ?? "unassigned"}`]),
    ],
  };
}

export function renderEscalationTemplate(ctx: NotificationContext): RenderedNotification {
  const days = staleFor(ctx);
  // "overdue" is only true of a staleness escalation. A hand-off is urgent
  // without being late, and calling it overdue sends the reader looking for a
  // delay that does not exist.
  const headline = days === null ? "needs attention" : "is overdue";
  const text = `:rotating_light: Escalation: ${ctx.issue.repoOwner}/${ctx.issue.repoName}#${ctx.issue.number} ${headline}`;
  const body =
    days === null
      ? (ctx.reason ?? "Please escalate to the team lead.")
      : `This issue has been stalled for *${days} day(s)* with no progress. ${
          ctx.reason ?? "Please escalate to the team lead."
        }`;
  return {
    text,
    blocks: [
      header(":rotating_light: Escalation"),
      section(issueLine(ctx)),
      section(body.trim()),
      context([`*Team:* ${ctx.team ?? "unassigned"}`, `*Owner:* ${ctx.owner ?? "unassigned"}`]),
    ],
  };
}

/**
 * The milestone-review approval surface — the
 * Block Kit payload a reviewer clicks and the parser that reads the click
 * back. Mirrors `spec-approval.ts` in `@lexi/specs`, for the same reason:
 * pure and dependency-free here, while the governed chain that acts on a
 * click (feature flag -> AuthorizationService -> milestone state machine)
 * lives in the orchestrator's milestone-review service.
 *
 * `approve_milestone` is withheld from the model payload entirely
 * (`HUMAN_ONLY_PROGRAMME_TOOLS`), so these buttons are the only route to an
 * approved milestone — and an approved milestone is what resumes a paused
 * programme. The milestone id AND the evidence head SHA travel in the button
 * value: between a reviewer reading the card and clicking, more tasks can
 * merge, and "approve" must mean "approve what I looked at", not "approve
 * whatever exists now".
 */

/** Claimed by a single Bolt action route, exactly like `spec_approval_`. */
export const MILESTONE_REVIEW_ACTION_PREFIX = "programme_milestone_";

export const MILESTONE_REVIEW_ACTIONS = {
  APPROVE: `${MILESTONE_REVIEW_ACTION_PREFIX}approve`,
  REQUEST_CHANGES: `${MILESTONE_REVIEW_ACTION_PREFIX}request_changes`,
  /**
   * The hardening conclusion click (`programme.hardening.conclude`) shares the
   * prefix so one Bolt route serves every programme human gate — the parser
   * tells them apart, the same way other action prefixes multiplex theirs.
   */
  CONCLUDE_HARDENING: `${MILESTONE_REVIEW_ACTION_PREFIX}conclude_hardening`,
} as const;

export type MilestoneReviewDecision = "approve" | "request_changes";

export interface MilestoneReviewClick {
  decision: MilestoneReviewDecision;
  milestoneId: string;
  /** Head SHA of the milestone's last merged task when the card rendered. */
  reviewedSha: string;
}

export interface MilestoneReviewBlockArgs {
  programmeKey: string;
  programmeTitle: string;
  milestoneId: string;
  milestoneOrdinal: number;
  milestoneTitle: string;
  /** Merged/total task counts, for the reviewer's one-line orientation. */
  tasksMerged: number;
  tasksTotal: number;
  /** Head SHA the evidence below describes. Travels in the button value. */
  headSha: string;
  /** AC matrix summary line, e.g. "12/12 criteria green". */
  acSummary: string;
  /** Links to the evidence the reviewer should look at, label -> url. */
  evidenceLinks: Array<{ label: string; url: string }>;
}

/** Serialised into the button `value`; kept versionless and tiny on purpose. */
function encodeClickValue(milestoneId: string, headSha: string): string {
  return JSON.stringify({ milestoneId, headSha });
}

/** The conclude-hardening click, parsed fail-closed like the review clicks. */
export interface HardeningConcludeClick {
  programmeKey: string;
}

export function parseHardeningConcludeClick(
  actionId: string,
  value: string,
): HardeningConcludeClick | null {
  if (actionId !== MILESTONE_REVIEW_ACTIONS.CONCLUDE_HARDENING) return null;
  try {
    const parsed = JSON.parse(value) as { programmeKey?: unknown };
    if (typeof parsed.programmeKey !== "string" || parsed.programmeKey.length === 0) return null;
    return { programmeKey: parsed.programmeKey };
  } catch {
    return null;
  }
}

/** The card posted when a programme enters HARDENING. */
export function hardeningConcludeBlocks(args: {
  programmeKey: string;
  programmeTitle: string;
  findingsLabel: string;
  openFindings: number;
}): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Hardening — ${args.programmeTitle}* (\`${args.programmeKey}\`)`,
          `Findings label \`${args.findingsLabel}\` · ${args.openFindings} open finding(s).`,
          "Concluding records that the hardening pass has actually been run. The programme completes only when BOTH legs pass: a recorded conclusion AND zero open findings.",
        ].join("\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          action_id: MILESTONE_REVIEW_ACTIONS.CONCLUDE_HARDENING,
          text: { type: "plain_text", text: "Conclude hardening", emoji: false },
          value: JSON.stringify({ programmeKey: args.programmeKey }),
        },
      ],
    },
  ];
}

export function parseMilestoneReviewClick(
  actionId: string,
  value: string,
): MilestoneReviewClick | null {
  let decision: MilestoneReviewDecision;
  if (actionId === MILESTONE_REVIEW_ACTIONS.APPROVE) {
    decision = "approve";
  } else if (actionId === MILESTONE_REVIEW_ACTIONS.REQUEST_CHANGES) {
    decision = "request_changes";
  } else {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as { milestoneId?: unknown; headSha?: unknown };
    if (typeof parsed.milestoneId !== "string" || typeof parsed.headSha !== "string") {
      return null;
    }
    if (parsed.milestoneId.length === 0 || parsed.headSha.length === 0) {
      return null;
    }
    return { decision, milestoneId: parsed.milestoneId, reviewedSha: parsed.headSha };
  } catch {
    return null;
  }
}

/**
 * Slack's own limits on the surfaces this card uses. A payload that exceeds
 * any of them is rejected whole, with `invalid_blocks` — so the card is not
 * merely ugly, it does not arrive at all.
 *
 * A milestone of a few dozen tasks renders an evidence list well past the
 * 3,000-character section cap. Without packing, the post fails, the
 * milestone parks itself for review anyway, and the only trace is a warn
 * line — so the card could never be posted past roughly twenty-five tasks.
 */
const SECTION_TEXT_MAX = 3000;
const HEADER_TEXT_MAX = 150;
/**
 * Slack caps a message at 50 blocks. The card's fixed blocks take three, so
 * this is a deliberate budget rather than the hard limit: a milestone with
 * hundreds of tasks should produce a readable card with an honest remainder,
 * not a wall.
 */
const EVIDENCE_SECTIONS_MAX = 8;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Packs evidence lines into as many section blocks as they need, each within
 * Slack's cap, and says plainly how many were left out rather than dropping
 * them silently — an evidence list that is quietly short is worse than
 * one that admits its own truncation.
 */
function evidenceSections(lines: string[]): Array<Record<string, unknown>> {
  const sections: string[] = [];
  let current = "";
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = clamp(lines[index] ?? "", SECTION_TEXT_MAX);
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length <= SECTION_TEXT_MAX) {
      current = candidate;
      continue;
    }
    sections.push(current);
    if (sections.length === EVIDENCE_SECTIONS_MAX) break;
    current = line;
  }
  if (sections.length < EVIDENCE_SECTIONS_MAX && current.length > 0) {
    sections.push(current);
    index = lines.length;
  }

  const omitted = lines.length - index;
  if (omitted > 0) {
    const note = `_…and ${omitted} more not shown — the full list is on the branch's merged pull requests._`;
    const last = sections[sections.length - 1] ?? "";
    const joined = `${last}\n${note}`;
    sections[sections.length - 1] =
      joined.length <= SECTION_TEXT_MAX ? joined : clamp(note, SECTION_TEXT_MAX);
  }

  return sections.map((text) => ({ type: "section", text: { type: "mrkdwn", text } }));
}

/**
 * The plain-text stand-in for a card that could not be posted. A Block Kit
 * failure is all-or-nothing, so without this a reviewer is told nothing at
 * all.
 */
export function milestoneReviewFallbackText(args: MilestoneReviewBlockArgs): string {
  return [
    `Milestone review — ${args.programmeTitle} / ${args.milestoneTitle} (\`${args.milestoneId}\`)`,
    `Programme \`${args.programmeKey}\` · ${args.tasksMerged}/${args.tasksTotal} tasks merged · head \`${args.headSha.slice(0, 12)}\``,
    args.acSummary,
    "The review card could not be rendered, so approve or request changes from the programme's tracking issue instead. The milestone is parked either way.",
  ].join("\n");
}

/**
 * The Slack blocks for one milestone-review card. Plain objects rather than
 * a Slack SDK type so the package stays dependency-free; the orchestrator
 * posts them verbatim.
 */
export function milestoneReviewBlocks(args: MilestoneReviewBlockArgs): unknown[] {
  const evidenceBlocks =
    args.evidenceLinks.length > 0
      ? evidenceSections(args.evidenceLinks.map((link) => `• <${link.url}|${link.label}>`))
      : [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "_No evidence links recorded — treat as a refusal to review, not a clean bill._",
            },
          },
        ];

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: clamp(`Milestone review — ${args.programmeTitle}`, HEADER_TEXT_MAX),
        emoji: false,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Milestone ${args.milestoneOrdinal}: ${args.milestoneTitle}* (\`${args.milestoneId}\`)`,
          `Programme \`${args.programmeKey}\` · ${args.tasksMerged}/${args.tasksTotal} tasks merged · head \`${args.headSha.slice(0, 12)}\``,
          args.acSummary,
        ].join("\n"),
      },
    },
    ...evidenceBlocks,
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          action_id: MILESTONE_REVIEW_ACTIONS.APPROVE,
          text: { type: "plain_text", text: "Approve milestone", emoji: false },
          value: encodeClickValue(args.milestoneId, args.headSha),
        },
        {
          type: "button",
          style: "danger",
          action_id: MILESTONE_REVIEW_ACTIONS.REQUEST_CHANGES,
          text: { type: "plain_text", text: "Request changes", emoji: false },
          value: encodeClickValue(args.milestoneId, args.headSha),
        },
      ],
    },
  ];
}

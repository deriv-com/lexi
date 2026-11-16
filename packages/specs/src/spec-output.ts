import type {
  RepoDescriptor,
  SpecChangedSection,
  SpecEvidenceLink,
  SpecNamedOwner,
  SpecStatus,
} from "@lexi/contracts";
import type { SpecPolicy } from "./load-spec-policy";
import type { RenderedSpecSection, SpecDocumentContent, SpecFrontmatter } from "./spec-template";
import type { ReadinessReason } from "./readiness";

/**
 * Where a spec goes, and what it looks like when it gets there.
 *
 * The load-bearing rule: a spec is filed in the **product repo it governs**
 * (`web-app` or `mobile-app`, role `specs`) and **never** in
 * `issues`. That repo's corpus sync, dedup scan, triage and
 * reproduction machinery all assume every issue is a production defect, so a
 * spec filed there would not merely be untidy — it would be swept into
 * duplicate adjudication and reproduction attempts against a document that
 * describes work nobody has done yet.
 *
 * The rule is a throwing role check rather than a comment, because the failure
 * mode is silent and only visible days later in someone else's pipeline.
 */

export class SpecRepoRoleError extends Error {
  constructor(repo: RepoDescriptor, requiredRole: string) {
    super(
      `Cannot file a spec in ${repo.slug} (key "${repo.key}"): it carries roles [${repo.roles.join(", ") || "none"}] ` +
        `and a spec requires role "${requiredRole}". Specs belong in the product repo they govern, never in the bug tracker.`,
    );
    this.name = "SpecRepoRoleError";
  }
}

/** Throws unless the repo is allowed to hold specs. */
export function assertSpecRepo(repo: RepoDescriptor, policy: SpecPolicy): void {
  if (!repo.roles.includes(policy.output.requiredRepoRole)) {
    throw new SpecRepoRoleError(repo, policy.output.requiredRepoRole);
  }
}

/**
 * The slice of the policy the label helpers actually read.
 *
 * Structural rather than the full `SpecPolicy` because two loaders parse the
 * same `config/spec-policy.yaml`: this package's (which owns the coverage and
 * questioning half) and `@lexi/governance`'s (which owns the approval half and
 * is what `evaluateSpecGate` takes). The approval path holds the governance
 * policy, and it should not have to load the file a second time just to learn
 * the name of a label both copies already agree on.
 */
export interface SpecLabelPolicy {
  output: { labels: { type: string; draft: string; approved: string } };
}

export function specIssueTitle(title: string, policy: SpecPolicy): string {
  const prefix = policy.output.titlePrefix;
  const trimmed = title.trim();
  // Idempotent: re-rendering a revision must not accumulate "[Spec] [Spec] …".
  return trimmed.startsWith(prefix) ? trimmed : `${prefix} ${trimmed}`;
}

/**
 * `spec:draft` until the spec is actually approved. IN_REVIEW deliberately
 * stays a draft — anyone filtering the repo by label is asking "what has been
 * agreed?", and a spec awaiting a decision has not been.
 */
export function specIssueLabels(status: SpecStatus, policy: SpecLabelPolicy): string[] {
  const stage = status === "APPROVED" ? policy.output.labels.approved : policy.output.labels.draft;
  return [policy.output.labels.type, stage];
}

export interface SpecIssuePayload {
  repoSlug: string;
  title: string;
  body: string;
  labels: string[];
  boardColumn: string;
}

export function buildSpecIssue(args: {
  repo: RepoDescriptor;
  frontmatter: SpecFrontmatter;
  rendered: SpecDocumentContent;
  policy: SpecPolicy;
}): SpecIssuePayload {
  assertSpecRepo(args.repo, args.policy);

  return {
    repoSlug: args.repo.slug,
    title: specIssueTitle(args.frontmatter.title, args.policy),
    body: args.rendered.body,
    labels: specIssueLabels(args.frontmatter.status, args.policy),
    boardColumn: args.policy.output.boardColumn,
  };
}

/** The writable half of `SpecDocument`. */
export interface SpecDocumentMirror {
  sessionId?: string;
  trackingRepoKey: string;
  codeRepoKey?: string;
  issueNumber?: number;
  revision: number;
  status: SpecStatus;
  frontmatter: SpecFrontmatter;
  body: string;
  contentHash: string;
  /**
   * The classified risk tier, or absent when no rule matched.
   *
   * Denormalised out of `frontmatter` into its own column because
   * `evaluateSpecGate` reads it on every approval click: a governance decision
   * should not depend on digging a value out of a JSON blob whose shape is not
   * enforced by the database. Absent stays absent — the gate substitutes
   * `defaultRiskTier` and applies the two-person rule.
   */
  riskTier?: string;
  changedSections?: SpecChangedSection[];
  evidenceLinks?: SpecEvidenceLink[];
  owners?: SpecNamedOwner[];
  /**
   * Content section map used to diff the next revision. Excludes the ledger
   * section. Stored on the document's frontmatter JSON, not in the YAML.
   */
  renderedSections?: RenderedSpecSection[];
}

/**
 * Mirrors a rendered spec into the shape `SpecDocument` persists.
 *
 * The mirror is complete without an issue number on purpose: under
 * `SPEC_SESSIONS_ENABLED` the pipeline runs DB-only with zero GitHub writes,
 * and the content hash means replay never has to consult GitHub
 * for what a revision said.
 */
export function toSpecDocumentMirror(args: {
  sessionId?: string;
  frontmatter: SpecFrontmatter;
  rendered: SpecDocumentContent;
  issueNumber?: number;
  changedSections?: SpecChangedSection[];
  evidenceLinks?: SpecEvidenceLink[];
  owners?: SpecNamedOwner[];
  renderedSections?: RenderedSpecSection[];
}): SpecDocumentMirror {
  return {
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    trackingRepoKey: args.frontmatter.trackingRepoKey,
    ...(args.frontmatter.codeRepoKey !== undefined ? { codeRepoKey: args.frontmatter.codeRepoKey } : {}),
    ...(args.issueNumber !== undefined ? { issueNumber: args.issueNumber } : {}),
    revision: args.frontmatter.revision,
    status: args.frontmatter.status,
    // Taken from the frontmatter rather than passed separately, so the column
    // and the hashed document can never disagree about the tier of one revision.
    ...(args.frontmatter.riskTier !== undefined ? { riskTier: args.frontmatter.riskTier } : {}),
    frontmatter: args.frontmatter,
    body: args.rendered.body,
    contentHash: args.rendered.contentHash,
    ...(args.changedSections !== undefined ? { changedSections: args.changedSections } : {}),
    ...(args.evidenceLinks !== undefined ? { evidenceLinks: args.evidenceLinks } : {}),
    ...(args.owners !== undefined ? { owners: args.owners } : {}),
    ...(args.renderedSections !== undefined ? { renderedSections: args.renderedSections } : {}),
  };
}

export interface SpecAnnouncement {
  channelId: string;
  text: string;
}

/**
 * The `#lexi_build` announcement.
 *
 * `channelId` is a parameter, never a constant: the audit flagged hard-coded
 * channel ids in the dispatch path as existing debt, and this build must not
 * add more. The id lives in `config/escalation-policy.yaml` and reaches here
 * through the caller.
 */
export function buildSpecAnnouncement(args: {
  channelId: string;
  frontmatter: SpecFrontmatter;
  issueUrl?: string;
  readinessReason: ReadinessReason;
  blockingOpenQuestions?: string[];
}): SpecAnnouncement {
  const lines: string[] = [];
  const blocking = args.blockingOpenQuestions ?? [];

  lines.push(`*Spec drafted:* ${args.frontmatter.title}`);
  lines.push(`● Revision ${args.frontmatter.revision} · status ${args.frontmatter.status}`);
  lines.push(`● Repo: ${args.frontmatter.trackingRepoKey}`);
  if (args.issueUrl) lines.push(`● ${args.issueUrl}`);

  if (args.readinessReason === "question_turn_cap") {
    lines.push(`● Drafted at the question limit — ${blocking.length} open question(s) remain and are marked blocking.`);
  } else if (args.readinessReason === "user_override") {
    lines.push(`● Drafted on request before coverage was complete — ${blocking.length} open question(s) marked blocking.`);
  }

  for (const question of blocking) {
    lines.push(`   ○ ${question}`);
  }

  return { channelId: args.channelId, text: lines.join("\n") };
}

/**
 * Information-preserving consolidation service.
 *
 * INVARIANT: A duplicate may NEVER be closed until unique information from
 * the source issue has been preserved on the canonical issue.
 *
 * This service:
 * 1. Extracts unique information from the source issue not already on canonical
 * 2. Posts a consolidation comment on the canonical issue
 * 3. Records the consolidation for audit
 * 4. Only then allows the source to be closed as duplicate
 */

export interface ConsolidationInput {
  sourceIssueNumber: number;
  sourceRepository: string;
  sourceTitle: string;
  sourceBody: string;
  sourceLabels: string[];
  canonicalIssueNumber: number;
  canonicalRepository: string;
  canonicalTitle: string;
  canonicalBody: string;
  canonicalLabels: string[];
  adjudicationReasoning: string;
}

export interface ConsolidationResult {
  /** Whether consolidation was performed. */
  consolidated: boolean;
  /** The content that was preserved (posted as comment). */
  preservedContent: string;
  /** GitHub comment ID if posted. */
  githubCommentId?: number;
  /** Reason if consolidation was skipped. */
  skipReason?: string;
}

export interface ConsolidationGitHubAdapter {
  postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<{ id: number }>;
}

export interface ConsolidationPersistence {
  recordConsolidation(record: {
    sourceIssueNumber: number;
    sourceRepository: string;
    canonicalIssueNumber: number;
    canonicalRepository: string;
    preservedContent: string;
    consolidationType: string;
    githubCommentId?: number;
    adjudicationId?: string;
  }): Promise<string>;
}

/**
 * Extract unique information from source that is not already present in canonical.
 */
export function extractUniqueInformation(source: ConsolidationInput): string {
  const sections: string[] = [];

  // Extract steps/reproduction info unique to source
  const sourceSteps = extractSteps(source.sourceBody);
  const canonicalSteps = extractSteps(source.canonicalBody);

  if (sourceSteps && !isSubstantiallyContainedIn(sourceSteps, source.canonicalBody)) {
    sections.push(`**Steps to reproduce (from #${source.sourceIssueNumber}):**\n${sourceSteps}`);
  }

  // Extract environment/context info
  const sourceEnv = extractEnvironment(source.sourceBody);
  if (sourceEnv && !isSubstantiallyContainedIn(sourceEnv, source.canonicalBody)) {
    sections.push(`**Environment context (from #${source.sourceIssueNumber}):**\n${sourceEnv}`);
  }

  // Extract error messages/stack traces unique to source
  const sourceErrors = extractErrors(source.sourceBody);
  const canonicalErrors = extractErrors(source.canonicalBody);
  const uniqueErrors = sourceErrors.filter(
    (e) => !canonicalErrors.some((ce) => similarity(e, ce) > 0.8),
  );
  if (uniqueErrors.length > 0) {
    sections.push(
      `**Additional error details (from #${source.sourceIssueNumber}):**\n${uniqueErrors.join("\n")}`,
    );
  }

  // Extract URLs/links not in canonical
  const sourceUrls = extractUrls(source.sourceBody);
  const canonicalUrls = new Set(extractUrls(source.canonicalBody));
  const uniqueUrls = sourceUrls.filter((u) => !canonicalUrls.has(u));
  if (uniqueUrls.length > 0) {
    sections.push(`**Related links (from #${source.sourceIssueNumber}):**\n${uniqueUrls.map((u) => `- ${u}`).join("\n")}`);
  }

  // If nothing specific was extracted, preserve a summary of the whole source
  if (sections.length === 0) {
    const summary = buildSourceSummary(source);
    if (summary.length > 0) {
      sections.push(summary);
    }
  }

  return sections.join("\n\n");
}

/**
 * Build the consolidation comment body.
 */
export function buildConsolidationComment(
  input: ConsolidationInput,
  uniqueInfo: string,
): string {
  const header = `## Consolidated from #${input.sourceIssueNumber}`;
  const context = `> Issue #${input.sourceIssueNumber} ("${input.sourceTitle}") was identified as a duplicate. The following unique information has been preserved here before closure.`;
  const footer = `\n---\n_Consolidated by Lexi duplicate intelligence. Adjudication: ${input.adjudicationReasoning.slice(0, 200)}_`;

  return `${header}\n\n${context}\n\n${uniqueInfo}${footer}`;
}

export class ConsolidationService {
  constructor(
    private readonly github: ConsolidationGitHubAdapter,
    private readonly persistence: ConsolidationPersistence,
    private readonly options: { writesEnabled: boolean; dryRun: boolean },
  ) {}

  /**
   * Consolidate unique information from source onto canonical.
   * Returns the result — caller must not close the source until this succeeds.
   */
  async consolidate(
    input: ConsolidationInput,
    adjudicationId?: string,
  ): Promise<ConsolidationResult> {
    const uniqueInfo = extractUniqueInformation(input);

    if (uniqueInfo.trim().length === 0) {
      // Source has no unique information beyond what canonical already contains.
      // Still record the consolidation for audit trail.
      await this.persistence.recordConsolidation({
        sourceIssueNumber: input.sourceIssueNumber,
        sourceRepository: input.sourceRepository,
        canonicalIssueNumber: input.canonicalIssueNumber,
        canonicalRepository: input.canonicalRepository,
        preservedContent: "(no unique information to preserve)",
        consolidationType: "no_op",
        adjudicationId,
      });

      return {
        consolidated: true,
        preservedContent: "(no unique information to preserve)",
        skipReason: "Source contains no information not already on canonical",
      };
    }

    const comment = buildConsolidationComment(input, uniqueInfo);

    if (!this.options.writesEnabled || this.options.dryRun) {
      await this.persistence.recordConsolidation({
        sourceIssueNumber: input.sourceIssueNumber,
        sourceRepository: input.sourceRepository,
        canonicalIssueNumber: input.canonicalIssueNumber,
        canonicalRepository: input.canonicalRepository,
        preservedContent: comment,
        consolidationType: "dry_run",
        adjudicationId,
      });

      return {
        consolidated: true,
        preservedContent: comment,
        skipReason: "Writes disabled or dry-run mode",
      };
    }

    // Post consolidation comment on canonical issue
    const [owner, repo] = parseRepoString(input.canonicalRepository);
    const { id: commentId } = await this.github.postComment(
      owner,
      repo,
      input.canonicalIssueNumber,
      comment,
    );

    await this.persistence.recordConsolidation({
      sourceIssueNumber: input.sourceIssueNumber,
      sourceRepository: input.sourceRepository,
      canonicalIssueNumber: input.canonicalIssueNumber,
      canonicalRepository: input.canonicalRepository,
      preservedContent: comment,
      consolidationType: "comment",
      githubCommentId: commentId,
      adjudicationId,
    });

    return {
      consolidated: true,
      preservedContent: comment,
      githubCommentId: commentId,
    };
  }
}

// --- Helper functions ---

function extractSteps(body: string): string {
  const stepsMatch = body.match(
    /(?:steps?\s*(?:to\s*)?reproduce|reproduction?\s*steps?|how\s*to\s*reproduce)[:\s]*\n([\s\S]*?)(?:\n(?:expected|actual|environment|##)|$)/i,
  );
  return stepsMatch?.[1]?.trim() ?? "";
}

function extractEnvironment(body: string): string {
  const envMatch = body.match(
    /(?:environment|platform|browser|os|version|device)[:\s]*\n?([\s\S]*?)(?:\n(?:steps|expected|actual|##)|$)/i,
  );
  return envMatch?.[1]?.trim() ?? "";
}

function extractErrors(body: string): string[] {
  const errors: string[] = [];
  // Match error patterns
  const errorLines = body.match(/(?:error|exception|traceback|stack\s*trace)[:\s].*(?:\n\s+.*)*/gi);
  if (errorLines) errors.push(...errorLines);
  // Match code blocks that likely contain errors
  const codeBlocks = body.match(/```[\s\S]*?```/g);
  if (codeBlocks) {
    for (const block of codeBlocks) {
      if (/error|exception|failed|traceback/i.test(block)) {
        errors.push(block);
      }
    }
  }
  return errors;
}

function extractUrls(body: string): string[] {
  const urls = body.match(/https?:\/\/[^\s)>"]+/g);
  return [...new Set(urls ?? [])];
}

function isSubstantiallyContainedIn(text: string, container: string): boolean {
  const tokens = text.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
  if (tokens.length === 0) return true;
  const containerLower = container.toLowerCase();
  const matchCount = tokens.filter((t) => containerLower.includes(t)).length;
  return matchCount / tokens.length > 0.7;
}

function similarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/));
  const tokensB = new Set(b.toLowerCase().split(/\s+/));
  let overlap = 0;
  for (const t of tokensA) if (tokensB.has(t)) overlap++;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? overlap / union : 0;
}

function buildSourceSummary(input: ConsolidationInput): string {
  const bodyPreview = input.sourceBody.slice(0, 500).trim();
  if (bodyPreview.length === 0) return "";
  return `**Reporter's description (from #${input.sourceIssueNumber} "${input.sourceTitle}"):**\n\n${bodyPreview}${input.sourceBody.length > 500 ? "..." : ""}`;
}

function parseRepoString(repo: string): [string, string] {
  const parts = repo.split("/");
  if (parts.length >= 2) return [parts[0], parts[1]];
  return ["", repo];
}

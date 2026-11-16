import { readFileSync, existsSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import type { PrismaService } from "@lexi/database";
import type { GitHubProvider } from "@lexi/github";
import type { PinoLoggerService } from "@lexi/logger";
import type { IntakeService } from "../intake/intake-service";
import type { BugSubmission } from "../intake/bug-submission.schema";
import { governanceConfigDir } from "../config/config-dir";

export interface ReposConfig {
  intake?: { owner: string; repo: string };
  canonical?: { owner: string; repo: string };
  enforcement?: string;
}

const PROCESSED_LABEL = "lexi:intake-processed";
const BOT_FRAGMENTS = ["[bot]", "lexi-bot", "intake-bot", "github-actions"];

/**
 * Polls the configured QA intake repository for new issues and routes them through IntakeService.
 */
export class GitHubIntakeWatcher {
  private readonly seen = new Set<number>();

  constructor(
    private readonly github: GitHubProvider,
    private readonly intake: IntakeService,
    private readonly prisma: PrismaService,
    private readonly reposConfig: ReposConfig,
    private readonly logger: PinoLoggerService,
    private readonly writesEnabled: boolean,
  ) {}

  static loadReposConfig(configDir = governanceConfigDir()): ReposConfig {
    const path = `${configDir}/repos.yaml`;
    if (!existsSync(path)) return {};
    const raw = loadYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      intake: raw.intake as ReposConfig["intake"],
      canonical: raw.canonical as ReposConfig["canonical"],
      enforcement: raw.enforcement as string | undefined,
    };
  }

  async pollNewIssues(): Promise<{ processed: number; skipped: number }> {
    const intake = this.reposConfig.intake;
    if (!intake?.owner || !intake?.repo) {
      return { processed: 0, skipped: 0 };
    }

    const issues = await this.github.listIssues({
      owner: intake.owner,
      repo: intake.repo,
      state: "open",
      perPage: 50,
    });

    let processed = 0;
    let skipped = 0;

    for (const issue of issues) {
      if (this.seen.has(issue.githubNumber)) {
        skipped += 1;
        continue;
      }

      if (this.shouldSkipAutomatedIssue(issue)) {
        this.seen.add(issue.githubNumber);
        skipped += 1;
        continue;
      }

      const alreadyProcessed = await this.prisma.intakeSubmission.findFirst({
        where: {
          sourceType: "github_intake",
          payload: {
            path: ["source", "sourceIssueUrl"],
            equals: issue.url,
          },
        },
      });
      if (alreadyProcessed) {
        this.seen.add(issue.githubNumber);
        skipped += 1;
        continue;
      }

      this.seen.add(issue.githubNumber);

      const submission = this.mapIssueToSubmission(issue);
      const result = await this.intake.submit(submission);

      const comment = [
        `## Lexi intake result`,
        `Verdict: **${result.verdict}**`,
        result.explanation,
        result.canonicalIssue ? `Canonical: ${result.canonicalIssue.url}` : "",
        !this.writesEnabled ? "_Dry-run — no GitHub mutations applied._" : "",
      ]
        .filter(Boolean)
        .join("\n");

      await this.github.addComment(intake.owner, intake.repo, issue.githubNumber, comment);

      if (
        this.writesEnabled &&
        (result.verdict === "ACCEPTED" || result.verdict === "DUPLICATE" || result.verdict === "INVALID")
      ) {
        await this.github.closeIssue(intake.owner, intake.repo, issue.githubNumber, "completed");
        await this.github.addLabels(intake.owner, intake.repo, issue.githubNumber, [PROCESSED_LABEL]);
      }

      processed += 1;
      this.logger.log(`Intake watcher processed #${issue.githubNumber}: ${result.verdict}`, "GitHubIntakeWatcher");
    }

    return { processed, skipped };
  }

  private shouldSkipAutomatedIssue(issue: {
    authorLogin: string | null;
    labels: string[];
  }): boolean {
    const login = issue.authorLogin?.toLowerCase() ?? "";
    if (BOT_FRAGMENTS.some((frag) => login.includes(frag))) {
      return true;
    }
    const normalized = issue.labels.map((l) => l.toLowerCase());
    return normalized.includes(PROCESSED_LABEL.toLowerCase());
  }

  private mapIssueToSubmission(issue: {
    title: string;
    body: string | null;
    url: string;
    labels: string[];
    authorLogin: string | null;
  }): BugSubmission {
    const body = issue.body ?? "";
    const steps = body.includes("Steps")
      ? body
          .split("\n")
          .filter((line) => /^\d+\.|^- /.test(line.trim()))
          .map((l) => l.replace(/^\d+\.\s*|^- /, "").trim())
      : [body.slice(0, 200) || "See intake issue body"];

    return {
      source: {
        type: "github_intake",
        reporter: issue.authorLogin ?? undefined,
        sourceIssueUrl: issue.url,
      },
      title: issue.title,
      stepsToReproduce: steps.length > 0 ? steps : ["See intake issue"],
      expectedBehaviour: "See intake issue body",
      actualBehaviour: body.slice(0, 500) || issue.title,
      environment: { url: issue.url },
      labels: issue.labels,
    };
  }
}

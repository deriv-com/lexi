import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";

const projectSchema = z.object({
  organization: z.string(),
  projectNumber: z.number(),
  shippedStatus: z.string().optional(),
}).optional();

const productSchema = z.object({
  organization: z.string(),
  repository: z.string(),
  /**
   * Any platform string from repos.yaml. Product-app routing still uses
   * `web` / `mobile`; library repos (shared packages, a design system) are also registered
   * so PR listing and code search can reach them.
   */
  platform: z.string().min(1),
  team: z.string(),
  placeholder: z.boolean().optional().default(false),
  /**
   * Branch `workflow_dispatch` of `direct-fix.yml` targets. GitHub 404s
   * "No ref found for: main" when this is wrong — p2p_mobile is `master`.
   */
  defaultBranch: z.string().min(1).default("main"),
  project: projectSchema,
});

const reposConfigSchema = z.object({
  version: z.number(),
  source: z.object({
    issues: z.object({
      organization: z.string(),
      repository: z.string(),
    }),
  }),
  products: z.record(z.string(), productSchema),
});

export type ReposConfig = z.infer<typeof reposConfigSchema>;
export type ProductEntry = z.infer<typeof productSchema>;

export interface RepositoryResolution {
  productKey: string;
  organization: string;
  repository: string;
  fullName: string;
  platform: string;
  team: string;
  placeholder: boolean;
  /** Branch `workflow_dispatch` of `direct-fix.yml` targets. */
  defaultBranch: string;
  project?: { organization: string; projectNumber: number; shippedStatus?: string };
}

function toResolution(productKey: string, entry: ProductEntry): RepositoryResolution {
  return {
    productKey,
    organization: entry.organization,
    repository: entry.repository,
    fullName: `${entry.organization}/${entry.repository}`,
    platform: entry.platform,
    team: entry.team,
    placeholder: entry.placeholder,
    defaultBranch: entry.defaultBranch,
    project: entry.project,
  };
}

/**
 * Resolves which implementation repository a production issue should be
 * linked to, based on the issue's team/component classification and platform.
 *
 * This is a read-only registry — it does not create links or issues. The
 * governed action tools use it to determine WHERE to act, then the
 * authorization layer decides WHETHER to act.
 */
export class RepositoryRegistry {
  private readonly config: ReposConfig;

  constructor(configDir: string) {
    const path = resolve(configDir, "repos.yaml");
    const raw = loadYaml(readFileSync(path, "utf8"));
    this.config = reposConfigSchema.parse(raw);
  }

  /** The source issues repository. */
  getSourceRepository(): { organization: string; repository: string; fullName: string } {
    const s = this.config.source.issues;
    return { ...s, fullName: `${s.organization}/${s.repository}` };
  }

  /** All registered product repositories (including placeholders). */
  listProducts(): RepositoryResolution[] {
    return Object.entries(this.config.products).map(([key, entry]) => toResolution(key, entry));
  }

  /** Resolve implementation repository for a given team and platform. */
  resolveForTeam(team: string, platform?: string): RepositoryResolution | null {
    for (const [key, entry] of Object.entries(this.config.products)) {
      if (entry.team === team && (!platform || entry.platform === platform)) {
        return toResolution(key, entry);
      }
    }
    return null;
  }

  /** Resolve all repositories for a given team (both platforms). */
  resolveAllForTeam(team: string): RepositoryResolution[] {
    return Object.entries(this.config.products)
      .filter(([, entry]) => entry.team === team)
      .map(([key, entry]) => toResolution(key, entry));
  }

  /** Resolve by product key directly. */
  getProduct(productKey: string): RepositoryResolution | null {
    const entry = this.config.products[productKey];
    if (!entry) return null;
    return toResolution(productKey, entry);
  }

  /** Check if a full repo name is registered. */
  isRegistered(fullName: string): boolean {
    return this.listProducts().some((p) => p.fullName === fullName);
  }

  /** Only operational (non-placeholder) repositories. */
  listOperational(): RepositoryResolution[] {
    return this.listProducts().filter((p) => !p.placeholder);
  }
}

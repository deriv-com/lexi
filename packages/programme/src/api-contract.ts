import type { ApiContractOperation } from "@lexi/contracts";

/**
 * Pure OpenAPI filtering.
 *
 * The Acme Core OpenAPI document carries operations a build agent must
 * NEVER target: `Archived` (52 of its 311 operations), `Admin (Do Not
 * Publish)`, and `(INTERNAL)` families. Filtering REMOVES them from the
 * served document rather than marking them — an endpoint an agent must not
 * call is one it must not see, the same withhold-don't-refuse posture as the
 * tool payload.
 *
 * Deterministic and structural: substring match on tags (case-insensitive),
 * no model involvement. An operation with NO tags is kept — untagged is not
 * evidence of internal — but ANY matching tag excludes: the real document
 * co-tags admin/archived operations with public-looking tags (e.g.
 * `Admin (Do Not Publish)/KYC` beside `KYC`), and deny must win over an
 * incidental second label.
 */

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export interface FilteredOpenApi {
  /** The document with excluded operations (and emptied paths) removed. */
  spec: Record<string, unknown>;
  /** What survived — the allowlist the brief summarises. */
  operations: ApiContractOperation[];
  excludedOperationCount: number;
  info: { title: string; version: string };
}

function tagMatchesAny(tag: string, patterns: string[]): boolean {
  const lower = tag.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

export class InvalidOpenApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOpenApiError";
  }
}

export function filterOpenApiSpec(raw: unknown, excludeTagPatterns: string[]): FilteredOpenApi {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidOpenApiError("OpenAPI document is not a JSON object");
  }
  const source = raw as Record<string, unknown>;
  const paths = source.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    throw new InvalidOpenApiError("OpenAPI document has no paths object");
  }
  const info = (source.info ?? {}) as { title?: unknown; version?: unknown };

  const operations: ApiContractOperation[] = [];
  let excluded = 0;
  const filteredPaths: Record<string, unknown> = {};

  for (const [path, item] of Object.entries(paths as Record<string, unknown>)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const pathItem = item as Record<string, unknown>;
    const keptItem: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(pathItem)) {
      if (!(HTTP_METHODS as readonly string[]).includes(key)) {
        // parameters / summary / vendor extensions ride along untouched.
        keptItem[key] = value;
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const operation = value as {
        tags?: unknown;
        summary?: unknown;
        operationId?: unknown;
      };
      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      const anyExcluded = tags.some((tag) => tagMatchesAny(tag, excludeTagPatterns));
      if (anyExcluded) {
        excluded += 1;
        continue;
      }
      keptItem[key] = value;
      operations.push({
        method: key.toUpperCase(),
        path,
        tags,
        ...(typeof operation.summary === "string" ? { summary: operation.summary } : {}),
        ...(typeof operation.operationId === "string" ? { operationId: operation.operationId } : {}),
      });
    }

    // A path whose every operation was excluded disappears entirely.
    const hasOperation = Object.keys(keptItem).some((key) =>
      (HTTP_METHODS as readonly string[]).includes(key),
    );
    if (hasOperation) filteredPaths[path] = keptItem;
  }

  if (operations.length === 0) {
    // Every operation excluded (or the document was empty of them) — a brief
    // pointing at an empty contract would tell the agent "there is no API",
    // which is worse than no contract at all.
    throw new InvalidOpenApiError(
      `Filtering left zero operations (excluded ${excluded}) — check the exclude patterns against the document`,
    );
  }

  return {
    spec: { ...source, paths: filteredPaths },
    operations,
    excludedOperationCount: excluded,
    info: {
      title: typeof info.title === "string" ? info.title : "unknown",
      version: typeof info.version === "string" ? info.version : "unknown",
    },
  };
}

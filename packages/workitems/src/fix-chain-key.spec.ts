import { describe, it, expect } from "vitest";
import {
  FixChainKeyResolver,
  isLegacyFixChainKey,
  legacyBugKeyFor,
  type FixChainSubject,
} from "./fix-chain-key";

/**
 * ImplementationLink/ReleaseRecord/DeploymentRecord are keyed by workItemId
 * rather than productionIssueNumber, with a back-compat view for old rows.
 *
 * The constraint that shapes this: those three tables are keyed on
 * `(productionIssueNumber, productionRepository)`, so a *feature* — which has
 * no production issue — cannot attach a release or deployment at all. The
 * resolver introduces `workItemId` as the primary key while keeping every
 * existing bug row reachable, because the rows already in the database were
 * written before `workItemId` existed and must not become orphans.
 */

const BUG: FixChainSubject = {
  workItemId: "wi-bug-1",
  kind: "bug",
  trackingRepoKey: "issues",
  trackingRepoSlug: "acme-internal/issues",
  issueNumber: 4821,
};

const FEATURE: FixChainSubject = {
  workItemId: "wi-feature-1",
  kind: "feature",
  trackingRepoKey: "home_web",
  trackingRepoSlug: "acme/web-app",
  issueNumber: 77,
};

describe("FixChainKeyResolver — write path", () => {
  const resolver = new FixChainKeyResolver();

  it("writes workItemId as the primary key for every subject", () => {
    expect(resolver.writeKey(BUG).workItemId).toBe("wi-bug-1");
    expect(resolver.writeKey(FEATURE).workItemId).toBe("wi-feature-1");
  });

  it("still stamps the legacy columns for a bug so old readers keep working", () => {
    expect(resolver.writeKey(BUG)).toMatchObject({
      workItemId: "wi-bug-1",
      productionIssueNumber: 4821,
      productionRepository: "acme-internal/issues",
    });
  });

  it("leaves the legacy columns unset for a feature — it has no production issue", () => {
    const key = resolver.writeKey(FEATURE);
    expect(key.workItemId).toBe("wi-feature-1");
    expect(key.productionIssueNumber).toBeUndefined();
    expect(key.productionRepository).toBeUndefined();
  });

  it("leaves the legacy columns unset for a chore and a spec too", () => {
    for (const kind of ["chore", "spec"] as const) {
      const key = resolver.writeKey({ ...FEATURE, kind });
      expect(key.productionIssueNumber, `${kind} must not claim a production issue`).toBeUndefined();
    }
  });

  it("does not fabricate legacy columns for a bug tracked outside issues", () => {
    // A bug whose tracking repo is a product repo is not in the production
    // corpus, so writing its issue number into productionIssueNumber would
    // collide with a genuinely unrelated production issue of the same number.
    const key = resolver.writeKey({
      ...BUG,
      trackingRepoKey: "home_web",
      trackingRepoSlug: "acme/web-app",
    });
    expect(key.workItemId).toBe("wi-bug-1");
    expect(key.productionIssueNumber).toBeUndefined();
  });

  it("omits legacy columns when a bug has no issue number yet", () => {
    const key = resolver.writeKey({ ...BUG, issueNumber: undefined });
    expect(key.workItemId).toBe("wi-bug-1");
    expect(key.productionIssueNumber).toBeUndefined();
  });

  it("refuses to write a row with no workItemId", () => {
    expect(() => resolver.writeKey({ ...BUG, workItemId: "" })).toThrow(/workItemId/);
  });
});

describe("FixChainKeyResolver — read path (back-compat)", () => {
  const resolver = new FixChainKeyResolver();

  it("reads a feature by workItemId only", () => {
    expect(resolver.readWhere(FEATURE)).toEqual({ workItemId: "wi-feature-1" });
  });

  it("reads a bug by workItemId OR its legacy production key", () => {
    // Rows written before the re-key have workItemId = null. Querying only on
    // workItemId would silently return an empty fix chain for every issue
    // Lexi has ever tracked, which reads as 'no PRs, no releases' rather than
    // as a migration gap.
    expect(resolver.readWhere(BUG)).toEqual({
      OR: [
        { workItemId: "wi-bug-1" },
        {
          workItemId: null,
          productionIssueNumber: 4821,
          productionRepository: "acme-internal/issues",
        },
      ],
    });
  });

  it("scopes the legacy branch to the repository, not the bare number", () => {
    const where = resolver.readWhere(BUG) as { OR: Array<Record<string, unknown>> };
    const legacy = where.OR[1];
    expect(legacy.productionRepository).toBe("acme-internal/issues");
  });

  it("drops the legacy branch when a bug has no production issue to match", () => {
    expect(resolver.readWhere({ ...BUG, issueNumber: undefined })).toEqual({
      workItemId: "wi-bug-1",
    });
  });

  it("supports a legacy-only lookup for callers that still hold an issue number", () => {
    expect(resolver.legacyReadWhere(4821, "acme-internal/issues")).toEqual({
      productionIssueNumber: 4821,
      productionRepository: "acme-internal/issues",
    });
  });
});

describe("legacy key helpers", () => {
  it("builds a stable legacy key string for a bug", () => {
    expect(legacyBugKeyFor(BUG)).toBe("acme-internal/issues#4821");
  });

  it("returns null for a subject with no legacy identity", () => {
    expect(legacyBugKeyFor(FEATURE)).toBeNull();
  });

  it("recognises a row that predates the re-key", () => {
    expect(isLegacyFixChainKey({ workItemId: null, productionIssueNumber: 4821 })).toBe(true);
    expect(isLegacyFixChainKey({ workItemId: "wi-1", productionIssueNumber: 4821 })).toBe(false);
    expect(isLegacyFixChainKey({ workItemId: null, productionIssueNumber: null })).toBe(false);
  });
});

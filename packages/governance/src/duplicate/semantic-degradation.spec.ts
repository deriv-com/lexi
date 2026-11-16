/**
 * The semantic duplicate tier was silently returning [] because nothing ever
 * populated the in-memory index. An empty result is indistinguishable from
 * "searched and found nothing", so duplicate detection looked two-tier while it
 * was lexical-only. These tests pin the explicit-degradation contract: callers
 * must never present lexical-only results as two-tier.
 */
import { describe, expect, it } from "vitest";
import { DisabledVectorIndexProvider, InMemoryVectorIndexProvider } from "./semantic-index";
import { DuplicateEngine } from "./duplicate-engine";
import type { DuplicateEngineConfig } from "./duplicate-engine";

const config: DuplicateEngineConfig = {
  lexicalMinSimilarity: 0.3,
  semanticTopK: 5,
  highConfidenceThreshold: 0.85,
  mediumConfidenceThreshold: 0.6,
  reviewDedupLabel: "lexi:review-dedup",
};

describe("semantic index degradation is explicit", () => {
  it("reports disabled with a non-empty detail when semantic search is off", async () => {
    const health = await new DisabledVectorIndexProvider().health();

    expect(health.status).toBe("disabled");
    expect(health.documentCount).toBe(0);
    expect(health.detail.length).toBeGreaterThan(0);
  });

  it("reports empty, not operational, for an unpopulated in-memory index", async () => {
    const health = await new InMemoryVectorIndexProvider().health();

    expect(health.status).toBe("empty");
    expect(health.status).not.toBe("operational");
    expect(health.documentCount).toBe(0);
    expect(health.detail.length).toBeGreaterThan(0);
  });

  it("reports operational once documents are indexed", async () => {
    const index = new InMemoryVectorIndexProvider();
    await index.upsert({
      id: "acme/web#42",
      issueNumber: 42,
      repository: "acme/web",
      text: "Checkout page throws a 500 when the coupon field is empty",
      updatedAt: new Date().toISOString(),
    });

    const health = await index.health();

    expect(health.status).toBe("operational");
    expect(health.documentCount).toBeGreaterThan(0);
  });

  it("surfaces semanticHealth and flags the missing contribution in the explanation", async () => {
    const engine = new DuplicateEngine(new DisabledVectorIndexProvider(), undefined, config);

    const outcome = await engine.evaluate(
      "Checkout throws 500 on empty coupon",
      ["Open checkout", "Leave coupon blank", "Submit"],
      "Server returns 500",
      [
        {
          number: 42,
          title: "Checkout throws 500 on empty coupon",
          body: "Server returns 500",
          labels: [],
          state: "open",
          url: "https://github.com/acme/web/issues/42",
        },
      ],
    );

    expect(outcome.semanticHealth).toBeDefined();
    expect(outcome.semanticHealth?.status).toBe("disabled");
    expect(outcome.explanation).toContain("Semantic search did not contribute");
    expect(outcome.explanation).toContain(outcome.semanticHealth!.detail);
  });
});

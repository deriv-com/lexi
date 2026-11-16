import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { loadQuickFixOwnersConfig, parseQuickFixOwnersConfig } from "./load-quick-fix-owners-config";
import { QuickFixOwnerResolver } from "./quick-fix-owner-resolver";
import { QuickFixOwnersConfig } from "./quick-fix-owners-config.schema";

const SAMPLE_YAML = `
mergeReviewers:
  web: U_WEB_LEAD
  mobile: U_MOBILE_LEAD
categories:
  portfolio:
    description: "Portfolio"
    web: U_WEB_PORTFOLIO
    mobile: U_MOBILE_PORTFOLIO
  kyc:
    description: "KYC"
    web: U_WEB_KYC
    mobile: U_MOBILE_KYC
`;

describe("QuickFixOwnerResolver", () => {
  let config: QuickFixOwnersConfig;
  let resolver: QuickFixOwnerResolver;

  beforeAll(() => {
    config = parseQuickFixOwnersConfig(SAMPLE_YAML);
    resolver = new QuickFixOwnerResolver(config);
  });

  it("resolves the web owner for a known category", () => {
    expect(resolver.resolve("portfolio", "web")).toBe("U_WEB_PORTFOLIO");
  });

  it("resolves the mobile owner for a known category", () => {
    expect(resolver.resolve("kyc", "mobile")).toBe("U_MOBILE_KYC");
  });

  it("resolves the platform team lead as merge reviewer, not the category PIC", () => {
    expect(resolver.resolveMergeReviewer("web")).toBe("U_WEB_LEAD");
    expect(resolver.resolveMergeReviewer("mobile")).toBe("U_MOBILE_LEAD");
    expect(resolver.resolve("kyc", "web")).toBe("U_WEB_KYC");
  });

  it("returns null for 'other'", () => {
    expect(resolver.resolve("other", "web")).toBeNull();
  });

  it("returns null for an unrecognised category rather than throwing", () => {
    expect(resolver.resolve("some_future_category_not_yet_configured", "mobile")).toBeNull();
  });

  it("returns null for a null/undefined category", () => {
    expect(resolver.resolve(null, "web")).toBeNull();
    expect(resolver.resolve(undefined, "mobile")).toBeNull();
  });

  it("lists configured categories", () => {
    expect(resolver.listCategories().sort()).toEqual(["kyc", "portfolio"]);
  });
});

describe("the example quick-fix-owners.yaml", () => {
  const realConfig = loadQuickFixOwnersConfig(
    path.resolve(__dirname, "../../../examples/config/quick-fix-owners.yaml"),
  );
  const realResolver = new QuickFixOwnerResolver(realConfig);

  it("parses and lists every category", () => {
    expect(realResolver.listCategories().sort()).toEqual(["auth", "notifications", "payments"]);
  });

  it("has both a web and mobile owner for every category", () => {
    for (const category of realResolver.listCategories()) {
      expect(realResolver.resolve(category, "web")).toMatch(/^U[A-Z0-9]+$/);
      expect(realResolver.resolve(category, "mobile")).toMatch(/^U[A-Z0-9]+$/);
    }
  });

  it("asks the platform lead to merge, not the category owner", () => {
    expect(realResolver.resolveMergeReviewer("web")).toBe("U0TEST01");
    expect(realResolver.resolveMergeReviewer("mobile")).toBe("U0TEST02");
    expect(realResolver.resolveMergeReviewer("web")).not.toBe(realResolver.resolve("payments", "web"));
  });

  it("lets a platform override the default merge reviewer", () => {
    expect(realResolver.resolveMergeReviewer("p2p_web")).toBe("U0TEST03");
    expect(realResolver.resolveMergeReviewer("p2p_mobile")).toBe("U0TEST03");
  });

  it("announces ships per platform, tagging a user or a user group", () => {
    expect(realResolver.resolveAnnouncement("p2p_web")).toEqual({
      channel: "C0TEST04",
      teamMention: "<@U0TEST03>",
    });
    expect(realResolver.resolveAnnouncement("web")?.teamMention).toMatch(/^<!subteam\^/);
  });

  it("tags the configured person under an analysis reply, per channel", () => {
    expect(realResolver.resolveAnalysisMention("C0TEST01")).toBe("<@U0TEST03>");
    expect(realResolver.resolveAnalysisMention("C0TEST02")).toBe("<@U0TEST04>");
    expect(realResolver.resolveAnalysisMention("C_UNKNOWN")).toBeNull();
  });
});

describe("QuickFixOwnerResolver analysisReply", () => {
  it("returns null when analysisReply is omitted", () => {
    const resolver = new QuickFixOwnerResolver(parseQuickFixOwnersConfig(SAMPLE_YAML));
    expect(resolver.resolveAnalysisMention("C0TEST02")).toBeNull();
    expect(resolver.resolveAnalysisVisionUserId()).toBeNull();
  });
});

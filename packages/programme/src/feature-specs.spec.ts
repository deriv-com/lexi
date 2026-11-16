import { describe, expect, it } from "vitest";
import { featureSpecsForScreens, isFeatureSpecIndex, matchFeatureSpecs } from "./feature-specs";

const DIR = "docs/feature-spec";
const FILES = [
  "docs/feature-spec/README.md",
  "docs/feature-spec/01-login-page.md",
  "docs/feature-spec/signup.md",
  "docs/feature-spec/email-verification.md",
  "docs/feature-spec/auth.md",
  "docs/feature-spec/home/dashboard.md",
  "docs/feature-spec/home.md",
  "docs/feature-spec/wallets.md",
  "docs/feature-spec/invite.md",
];

describe("matchFeatureSpecs", () => {
  it("matches the route's last segment, ignoring numbering and filler words", () => {
    expect(matchFeatureSpecs("(auth)/login", FILES, DIR)).toEqual([
      "docs/feature-spec/01-login-page.md",
      "docs/feature-spec/auth.md",
    ]);
  });

  it("is prefix-tolerant for word forms and follows parent-segment documents", () => {
    expect(matchFeatureSpecs("(auth)/signup/verify", FILES, DIR)).toEqual([
      "docs/feature-spec/auth.md",
      "docs/feature-spec/email-verification.md",
      "docs/feature-spec/signup.md",
    ]);
  });

  it("matches a document in a sub-directory named for the screen", () => {
    expect(matchFeatureSpecs("home", FILES, DIR)).toEqual([
      "docs/feature-spec/home.md",
      "docs/feature-spec/home/dashboard.md",
    ]);
  });

  it("keeps sibling verbs apart", () => {
    expect(matchFeatureSpecs("(auth)/signin", ["docs/feature-spec/signup.md"], DIR)).toEqual([]);
    expect(matchFeatureSpecs("logout", ["docs/feature-spec/login.md"], DIR)).toEqual([]);
  });

  it("never matches the index, an unrelated feature, or a short word by prefix", () => {
    const matched = featureSpecsForScreens(["(auth)/login", "in"], FILES, DIR);
    expect(matched).not.toContain("docs/feature-spec/README.md");
    expect(matched).not.toContain("docs/feature-spec/wallets.md");
    expect(matched).not.toContain("docs/feature-spec/invite.md");
  });

  it("recognises index files", () => {
    expect(isFeatureSpecIndex("docs/feature-spec/README.md")).toBe(true);
    expect(isFeatureSpecIndex("docs/feature-spec/login.md")).toBe(false);
  });
});

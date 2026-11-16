import { describe, expect, it } from "vitest";
import { composePullRequestBody, hasClosingReference } from "./pull-request-body";

const TEMPLATE = [
  "<!-- Describe the change -->",
  "## Description",
  "",
  "<!-- What and why -->",
  "",
  "## Checklist",
  "- [ ] Tests added",
  "",
].join("\n");

describe("composePullRequestBody", () => {
  it("returns the body untouched when there is no template", () => {
    expect(composePullRequestBody("  Fixes the button.  ", null)).toBe("Fixes the button.");
  });

  it("returns the body untouched when the template has no headings", () => {
    expect(composePullRequestBody("Body", "Just prose.")).toBe("Body");
  });

  it("drops the body into the first section and keeps the rest", () => {
    const out = composePullRequestBody("Fixes the checkout button.", TEMPLATE);
    expect(out).toBe(
      "<!-- Describe the change -->\n## Description\n\nFixes the checkout button.\n\n## Checklist\n- [ ] Tests added",
    );
  });

  it("leaves a body that already carries the first heading alone", () => {
    const body = "## Description\n\nAlready shaped.";
    expect(composePullRequestBody(body, TEMPLATE)).toBe(body);
  });

  it("uses the template itself for an empty body", () => {
    expect(composePullRequestBody("", TEMPLATE)).toBe(TEMPLATE.trim());
  });
});

describe("hasClosingReference", () => {
  it.each(["Fixes #12", "closes #12", "Resolved #12", "fix #12."])("recognises %s", (body) => {
    expect(hasClosingReference(body, 12)).toBe(true);
  });

  it("does not match another number or a bare mention", () => {
    expect(hasClosingReference("Fixes #123", 12)).toBe(false);
    expect(hasClosingReference("See #12", 12)).toBe(false);
  });
});

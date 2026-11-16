import { describe, expect, it } from "vitest";
import {
  BUILT_IN_RULES,
  COMMIT_LOG_FORMAT,
  globToRegExp,
  normaliseMetadata,
  parseAllowlist,
  parseCommitLog,
  parsePrivateRules,
  pullRequestEntries,
  redact,
  scanText,
} from "./leak-scan.mjs";

describe("leak-scan", () => {
  it("flags a chat workspace ID and a token with the built-in rules", () => {
    // Built from parts so this file does not trip the scan it tests.
    const text = 'owner: "' + "U0" + "ABCDEF12" + '"\nconst t = "ghp_' + "a".repeat(36) + '";\nclean line';
    const findings = scanText("x.ts", text, BUILT_IN_RULES);
    expect(findings.map((f) => [f.line, f.rule])).toEqual([
      [1, "slack-id"],
      [2, "github-token"],
    ]);
  });

  it("flags Slack IDs that do not start with 0, and user-group IDs", () => {
    // Built from parts so this file does not trip the scan it tests.
    const older = "U" + "DJK7Q2" + "1XY";
    const group = "S" + "09ABCD" + "12EF";
    expect(scanText("x.ts", `owner: "${older}"`, BUILT_IN_RULES).map((f) => f.rule)).toEqual(["slack-id"]);
    expect(scanText("x.ts", `team: "${group}"`, BUILT_IN_RULES).map((f) => f.rule)).toEqual(["slack-id"]);
  });

  it("does not flag the repository's fictional IDs", () => {
    expect(scanText("x.ts", 'u: "U0TEST01", c: "C0TEST03", x: "U0TESTABC"', BUILT_IN_RULES)).toEqual([]);
  });

  it("does not flag ordinary words or placeholder IDs", () => {
    const text = "UPPERCASE CONSTANT\nchannel: C000\nderived value";
    expect(scanText("x.ts", text, BUILT_IN_RULES)).toEqual([]);
  });

  it("matches private rules case-insensitively and ignores comments", () => {
    const rules = parsePrivateRules("# internal org\nacme-internal\n\n");
    expect(rules).toHaveLength(1);
    expect(scanText("x.ts", "see ACME-Internal/repo", rules)).toHaveLength(1);
  });

  it("allows a finding only when both the path and the line text match", () => {
    const rules = parsePrivateRules("example\\.org");
    const allow = parseAllowlist("NOTICE | https://example.org/  # copyright notice");
    expect(scanText("NOTICE", "see https://example.org/", rules, allow)).toEqual([]);
    expect(scanText("README.md", "see https://example.org/", rules, allow)).toHaveLength(1);
    expect(scanText("NOTICE", "mail: a@example.org", rules, allow)).toHaveLength(1);
  });

  it("rejects a malformed allowlist line", () => {
    expect(() => parseAllowlist("NOTICE example.org")).toThrow(/expected/);
  });

  it("converts globs: * stays within a segment, ** crosses them", () => {
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/a.md")).toBe(false);
    expect(globToRegExp("**/*.md").test("docs/a.md")).toBe(true);
    expect(globToRegExp("**").test("anything/at/all")).toBe(true);
  });

  it("redacts long matches so credentials never reach CI logs", () => {
    expect(redact("ghp_abcdefghijklmnop")).toBe("ghp_…(20 chars)");
    expect(redact("abc")).toBe("abc");
  });

  describe("--metadata", () => {
    const rules = [...BUILT_IN_RULES, ...parsePrivateRules("acme-internal\\.example\nprivatename")];

    it("reads sha, both emails and the message from git log output", () => {
      expect(COMMIT_LOG_FORMAT).toContain("%ae");
      const out = "abc123def4567890\x1fa@acme-internal.example\x1fb@x.test\x1ffix: thing\n\nbody\n\x1e\n";
      const [entry] = parseCommitLog(out);
      expect(entry.file).toBe("commit abc123def456");
      expect(scanText(entry.file, entry.text, rules).map((f) => f.line)).toEqual([1]);
    });

    it("does not scan a GitHub noreply address, which only carries the public login", () => {
      expect(normaliseMetadata("author: 12345+privatename@users.noreply.github.com")).toBe("author: <noreply>");
    });

    it("drops the organisation from a merge commit but still scans the branch name", () => {
      const line = normaliseMetadata("Merge pull request #7 from acme/privatename/fix-x");
      expect(line).toBe("Merge pull request #7 from privatename/fix-x");
      expect(scanText("commit x", line, rules)).toHaveLength(1);
    });

    it("scans the pull request branch, title and body when CI provides them", () => {
      const entries = pullRequestEntries({ PR_HEAD_REF: "privatename/x", PR_TITLE: "clean", PR_BODY: "" });
      expect(entries.map((e) => e.file)).toEqual(["pull request branch", "pull request title"]);
      expect(entries.flatMap((e) => scanText(e.file, e.text, rules)).map((f) => f.file)).toEqual(["pull request branch"]);
    });
  });
});

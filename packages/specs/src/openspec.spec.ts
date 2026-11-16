import { describe, it, expect } from "vitest";
import {
  parseOpenSpec,
  openSpecAcceptanceCriteria,
  acceptanceCriteriaFromOpenSpec,
} from "./openspec";
import { acceptanceCriterionId } from "./task-candidates";

const WELL_FORMED = [
  "# auth Specification",
  "",
  "## Purpose",
  "Governs how a person proves who they are.",
  "",
  "## Requirements",
  "",
  "### Requirement: Email and password login",
  "The system SHALL authenticate a returning user through an identifier-first flow.",
  "",
  "#### Scenario: Successful login",
  "- **WHEN** a registered user submits a valid email followed by the correct password",
  "- **THEN** the user is authenticated and lands on the dashboard",
  "",
  "#### Scenario: Wrong password",
  "- **WHEN** a user submits an incorrect password for a registered email",
  '- **THEN** an inline error reading "The email or password you entered is incorrect." is shown',
  "",
  "### Requirement: Identifier validation",
  "The system SHALL validate the identifier before authenticating.",
  "",
  "#### Scenario: Malformed email",
  "- **WHEN** a user submits a string that is not a valid email address",
  "- **THEN** no authentication request is made",
  "",
].join("\n");

describe("parseOpenSpec", () => {
  it("reads the domain, purpose, requirements and scenarios", () => {
    const document = parseOpenSpec(WELL_FORMED);
    expect(document.problems).toEqual([]);
    expect(document.domain).toBe("auth");
    expect(document.purpose).toBe("Governs how a person proves who they are.");
    expect(document.requirements.map((r) => r.name)).toEqual([
      "Email and password login",
      "Identifier validation",
    ]);
    expect(document.requirements[0]?.statement).toBe(
      "The system SHALL authenticate a returning user through an identifier-first flow.",
    );
    expect(document.requirements[0]?.scenarios.map((s) => s.name)).toEqual([
      "Successful login",
      "Wrong password",
    ]);
    expect(document.requirements[0]?.scenarios[0]).toEqual({
      name: "Successful login",
      when: "a registered user submits a valid email followed by the correct password",
      then: "the user is authenticated and lands on the dashboard",
    });
  });

  it("preserves product copy verbatim, quotes and full stop included", () => {
    const document = parseOpenSpec(WELL_FORMED);
    expect(document.requirements[0]?.scenarios[1]?.then).toBe(
      'an inline error reading "The email or password you entered is incorrect." is shown',
    );
  });

  it("is idempotent — parsing twice yields the same criteria ids", () => {
    const first = acceptanceCriteriaFromOpenSpec(WELL_FORMED).criteria;
    const second = acceptanceCriteriaFromOpenSpec(WELL_FORMED).criteria;
    expect(second).toEqual(first);
  });

  it("survives CRLF line endings", () => {
    const document = parseOpenSpec(WELL_FORMED.replace(/\n/g, "\r\n"));
    expect(document.problems).toEqual([]);
    expect(document.requirements).toHaveLength(2);
  });
});

describe("parseOpenSpec — strictness", () => {
  it("reports a scenario missing its THEN instead of keeping half of it", () => {
    const document = parseOpenSpec(
      [
        "# auth Specification",
        "## Requirements",
        "### Requirement: R",
        "#### Scenario: Half",
        "- **WHEN** something happens",
        "#### Scenario: Whole",
        "- **WHEN** a thing",
        "- **THEN** another thing",
      ].join("\n"),
    );
    expect(document.problems.join(" ")).toMatch(/scenario "Half" is missing a THEN/);
    // The malformed one is dropped; the well-formed one still lands.
    expect(document.requirements[0]?.scenarios.map((s) => s.name)).toEqual(["Whole"]);
  });

  it("reports a scenario missing its WHEN, and one missing both", () => {
    const document = parseOpenSpec(
      [
        "# auth Specification",
        "## Requirements",
        "### Requirement: R",
        "#### Scenario: NoWhen",
        "- **THEN** an outcome",
        "#### Scenario: Neither",
      ].join("\n"),
    );
    expect(document.problems.join(" ")).toMatch(/"NoWhen" is missing a WHEN/);
    expect(document.problems.join(" ")).toMatch(/"Neither" is missing both WHEN and THEN/);
    expect(document.requirements[0]?.scenarios).toEqual([]);
  });

  it("reports a misspelled requirement heading rather than silently dropping its scenarios", () => {
    // The failure this exists to catch: a lenient parser treats the typo as
    // prose, the scenarios below attach to nothing, and the spec looks
    // smaller than it is.
    const document = parseOpenSpec(
      [
        "# auth Specification",
        "## Requirements",
        "### Requirment: Typo",
        "#### Scenario: Orphan",
        "- **WHEN** a thing",
        "- **THEN** another",
      ].join("\n"),
    );
    expect(document.problems.join(" ")).toMatch(/unrecognised heading/);
    expect(document.problems.join(" ")).toMatch(/outside any requirement/);
    expect(document.requirements).toEqual([]);
  });

  it("reports a requirement with no scenarios — nothing about it is testable", () => {
    const document = parseOpenSpec(
      ["# auth Specification", "## Requirements", "### Requirement: Bare", "The system SHALL do a thing."].join("\n"),
    );
    expect(document.problems.join(" ")).toMatch(/"Bare" has no scenarios/);
  });

  it("reports an unexpected body line inside a scenario", () => {
    const document = parseOpenSpec(
      [
        "# auth Specification",
        "## Requirements",
        "### Requirement: R",
        "#### Scenario: S",
        "- **WHEN** a thing",
        "- **GIVEN** an unsupported clause",
        "- **THEN** another",
      ].join("\n"),
    );
    expect(document.problems.join(" ")).toMatch(/neither WHEN nor THEN/);
    // The scenario itself is still complete, so it is kept.
    expect(document.requirements[0]?.scenarios).toHaveLength(1);
  });

  it("reports a duplicated WHEN rather than overwriting the first", () => {
    const document = parseOpenSpec(
      [
        "# auth Specification",
        "## Requirements",
        "### Requirement: R",
        "#### Scenario: S",
        "- **WHEN** the first condition",
        "- **WHEN** the second condition",
        "- **THEN** an outcome",
      ].join("\n"),
    );
    expect(document.problems.join(" ")).toMatch(/has a second WHEN/);
    expect(document.requirements[0]?.scenarios[0]?.when).toBe("the first condition");
  });

  it("reports a missing title heading and an unrecognised section", () => {
    const document = parseOpenSpec(["## Nonsense", "## Requirements"].join("\n"));
    expect(document.problems.join(" ")).toMatch(/no `# <domain> Specification` title heading/);
    expect(document.problems.join(" ")).toMatch(/unrecognised section "Nonsense"/);
    expect(document.domain).toBe("");
  });

  it("returns problems rather than throwing on empty input", () => {
    expect(() => parseOpenSpec("")).not.toThrow();
    expect(parseOpenSpec("").requirements).toEqual([]);
  });
});

describe("openSpecAcceptanceCriteria", () => {
  it("mints one criterion per scenario, in document order", () => {
    const document = parseOpenSpec(WELL_FORMED);
    const criteria = openSpecAcceptanceCriteria(document);
    expect(criteria).toHaveLength(3);
    expect(criteria.map((c) => c.ordinal)).toEqual([1, 2, 3]);
    expect(criteria[0]?.text).toBe(
      "auth/Email and password login: when a registered user submits a valid email followed by the correct password, then the user is authenticated and lands on the dashboard",
    );
    expect(criteria[0]?.id).toBe(acceptanceCriterionId(criteria[0]!.text));
    expect(criteria[0]?.id).toMatch(/^AC-[0-9a-f]{8}$/);
  });

  it("gives every criterion a distinct id", () => {
    const criteria = openSpecAcceptanceCriteria(parseOpenSpec(WELL_FORMED));
    expect(new Set(criteria.map((c) => c.id)).size).toBe(criteria.length);
  });

  it("includes the requirement name in the identity, so moving a scenario changes its id", () => {
    const under = (requirement: string) =>
      openSpecAcceptanceCriteria(
        parseOpenSpec(
          [
            "# auth Specification",
            "## Requirements",
            `### Requirement: ${requirement}`,
            "#### Scenario: S",
            "- **WHEN** a thing",
            "- **THEN** another",
          ].join("\n"),
        ),
      )[0];
    expect(under("Login")?.id).not.toBe(under("Signup")?.id);
  });

  it("gives the SAME scenario in two domains two different ids", () => {
    // Real case: home/spec.md and portfolio/spec.md both carry, word for
    // word, "Balance visibility: when the user toggles balance visibility on,
    // then every balance shows its value again". Those are two milestones. A
    // shared id would let evidence from the home milestone satisfy
    // portfolio's AC matrix row without portfolio ever testing it.
    const inDomain = (domain: string) =>
      openSpecAcceptanceCriteria(
        parseOpenSpec(
          [
            `# ${domain} Specification`,
            "## Requirements",
            "### Requirement: Balance visibility",
            "#### Scenario: Toggle on",
            "- **WHEN** the user toggles balance visibility on",
            "- **THEN** every balance shows its value again",
          ].join("\n"),
        ),
      )[0];
    const home = inDomain("home");
    const portfolio = inDomain("portfolio");
    expect(home?.id).not.toBe(portfolio?.id);
    expect(home?.text).toMatch(/^home\//);
    expect(portfolio?.text).toMatch(/^portfolio\//);
  });

  it("collapses two scenarios whose text is identical", () => {
    const criteria = openSpecAcceptanceCriteria(
      parseOpenSpec(
        [
          "# auth Specification",
          "## Requirements",
          "### Requirement: R",
          "#### Scenario: First name",
          "- **WHEN** a thing",
          "- **THEN** another",
          "#### Scenario: Different name, same body",
          "- **WHEN** a thing",
          "- **THEN** another",
        ].join("\n"),
      ),
    );
    // Same requirement + same WHEN/THEN is the same criterion, whatever the
    // scenario headings are called.
    expect(criteria).toHaveLength(1);
  });

  it("yields nothing, and does not throw, for a document with no requirements", () => {
    expect(openSpecAcceptanceCriteria(parseOpenSpec("# auth Specification"))).toEqual([]);
  });
});

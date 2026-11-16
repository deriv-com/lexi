import { describe, it, expect } from "vitest";
import { seedSessionFromOpenSpec, openSpecSeedAnswersForTool } from "./openspec-seed";
import { acceptanceCriteriaFromOpenSpec } from "./openspec";
import { parseAcceptanceCriteria } from "./task-candidates";

const SPEC = [
  "# home Specification",
  "",
  "## Purpose",
  "Governs the signed-in dashboard.",
  "",
  "## Requirements",
  "",
  "### Requirement: Balance visibility",
  "The system SHALL let a user hide every balance at once.",
  "",
  "#### Scenario: Toggle on",
  "- **WHEN** the user toggles balance visibility on",
  "- **THEN** every balance shows its value again",
  "",
  "#### Scenario: Toggle off",
  "- **WHEN** the user toggles balance visibility off",
  "- **THEN** every balance is masked",
  "",
  "### Requirement: Account list",
  "The system SHALL list the user's accounts.",
  "",
  "#### Scenario: Accounts render",
  "- **WHEN** the dashboard loads for a user with two accounts",
  "- **THEN** both accounts are listed with their balances",
  "",
].join("\n");

describe("seedSessionFromOpenSpec", () => {
  it("seeds acceptance_criteria with one line per scenario", () => {
    const { answers, criteria } = seedSessionFromOpenSpec(SPEC);
    expect(criteria).toHaveLength(3);
    const lines = answers.acceptance_criteria?.answer?.split("\n") ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      "- home/Balance visibility: when the user toggles balance visibility on, then every balance shows its value again",
    );
  });

  it("round-trips: the session re-mints exactly the ids the extractor computed", () => {
    // The property the whole design rests on. parseAcceptanceCriteria is what
    // the real session runs over the seeded notes; if it minted different ids,
    // evidence citing AC-x would match no matrix row.
    const { answers, criteria } = seedSessionFromOpenSpec(SPEC);
    const reparsed = parseAcceptanceCriteria(answers.acceptance_criteria?.answer);
    expect(reparsed.map((c) => c.id)).toEqual(criteria.map((c) => c.id));
    expect(reparsed.map((c) => c.text)).toEqual(criteria.map((c) => c.text));
  });

  it("does NOT truncate the criteria, however many there are", () => {
    // The generic document seeder caps a mined section at 2000 characters.
    // Applying that here would silently drop criteria and leave a session
    // looking complete while covering a fraction of the behaviour.
    const many = [
      "# big Specification",
      "## Requirements",
      "### Requirement: R",
      ...Array.from({ length: 60 }, (_, i) => [
        `#### Scenario: S${i}`,
        `- **WHEN** condition number ${i} holds with a good deal of explanatory padding text`,
        `- **THEN** outcome number ${i} follows with a good deal more explanatory padding text`,
      ]).flat(),
    ].join("\n");
    const { answers, criteria } = seedSessionFromOpenSpec(many);
    expect(criteria).toHaveLength(60);
    const answer = answers.acceptance_criteria?.answer ?? "";
    expect(answer.length).toBeGreaterThan(2000);
    expect(answer.split("\n")).toHaveLength(60);
    expect(parseAcceptanceCriteria(answer)).toHaveLength(60);
  });

  it("seeds problem from Purpose and scope from the requirement statements", () => {
    const { answers } = seedSessionFromOpenSpec(SPEC);
    expect(answers.problem?.answer).toBe("Governs the signed-in dashboard.");
    expect(answers.scope?.answer).toContain("2 requirements");
    expect(answers.scope?.answer).toContain("Balance visibility: The system SHALL let a user hide every balance");
    expect(answers.scope?.answer).toContain("Account list:");
  });

  it("seeds platforms and journey_states only from what it is given", () => {
    const bare = seedSessionFromOpenSpec(SPEC);
    expect(bare.answers.platforms).toBeUndefined();
    // OpenSpec requirements are behaviour groups, NOT screens. Seeding
    // journey_states from them would paper over a genuine gap.
    expect(bare.answers.journey_states).toBeUndefined();

    const withContext = seedSessionFromOpenSpec(SPEC, {
      platform: "web_ai",
      figmaStates: ["Dashboard", "Empty state"],
    });
    expect(withContext.answers.platforms?.answer).toContain("web_ai");
    expect(withContext.answers.journey_states?.answer).toContain("Dashboard");
  });

  it("reports the mandatory dimensions it could not answer", () => {
    const { unseeded } = seedSessionFromOpenSpec(SPEC, { platform: "web_ai" });
    // Honest accounting: OpenSpec says nothing about these.
    expect(unseeded).toEqual(["users", "non_goals", "dependencies", "risks", "rollout", "journey_states", "api_contract"]);
    expect(unseeded).not.toContain("acceptance_criteria");
    expect(unseeded).not.toContain("problem");
    expect(unseeded).not.toContain("scope");
    expect(unseeded).not.toContain("platforms");
  });

  it("drops journey_states from unseeded once prototype screens are supplied", () => {
    const { unseeded } = seedSessionFromOpenSpec(SPEC, { figmaStates: ["Dashboard"] });
    expect(unseeded).not.toContain("journey_states");
  });

  it("surfaces parse problems rather than seeding from a half-read spec", () => {
    const { document, criteria } = seedSessionFromOpenSpec(
      ["# home Specification", "## Requirements", "### Requirment: Typo", "#### Scenario: Orphan", "- **WHEN** a", "- **THEN** b"].join("\n"),
    );
    expect(document.problems.length).toBeGreaterThan(0);
    expect(criteria).toEqual([]);
  });

  it("seeds nothing and does not throw on an empty document", () => {
    const { answers, unseeded } = seedSessionFromOpenSpec("");
    expect(answers.acceptance_criteria).toBeUndefined();
    expect(unseeded).toHaveLength(11);
  });
});

describe("openSpecSeedAnswersForTool", () => {
  it("returns rows in the shape start_spec_session accepts", () => {
    const { seedAnswers } = openSpecSeedAnswersForTool(SPEC, { platform: "web_ai" });
    for (const row of seedAnswers) {
      expect(typeof row.dimension).toBe("string");
      expect(typeof row.answer).toBe("string");
      expect(row.confidence).toBeGreaterThan(0.7);
      expect(row.confidence).toBeLessThanOrEqual(1);
    }
    expect(seedAnswers.map((r) => r.dimension).sort()).toEqual([
      "acceptance_criteria",
      "platforms",
      "problem",
      "scope",
    ]);
  });

  it("carries the criteria and the unseeded list alongside the rows", () => {
    const result = openSpecSeedAnswersForTool(SPEC);
    expect(result.criteria).toHaveLength(3);
    expect(result.document.domain).toBe("home");
    expect(result.unseeded).toContain("users");
  });
});

describe("seedSessionFromOpenSpec — against a realistic spec shape", () => {
  it("keeps every criterion addressable end to end", () => {
    // Build a spec with cross-requirement duplicate scenario NAMES, which the
    // real specs contain, to prove naming does not collapse distinct criteria.
    const spec = [
      "# cashier Specification",
      "## Requirements",
      "### Requirement: Deposit",
      "#### Scenario: Success",
      "- **WHEN** a deposit succeeds",
      "- **THEN** the balance rises",
      "### Requirement: Withdraw",
      "#### Scenario: Success",
      "- **WHEN** a withdrawal succeeds",
      "- **THEN** the balance falls",
    ].join("\n");
    const { criteria, answers } = seedSessionFromOpenSpec(spec);
    expect(criteria).toHaveLength(2);
    expect(new Set(criteria.map((c) => c.id)).size).toBe(2);
    expect(parseAcceptanceCriteria(answers.acceptance_criteria?.answer).map((c) => c.id)).toEqual(
      acceptanceCriteriaFromOpenSpec(spec).criteria.map((c) => c.id),
    );
  });
});

import { describe, it, expect } from "vitest";
import { seedAnswersForTool, seedSessionFromDocument, splitSections } from "./seed-from-document";

const DOCUMENT = [
  "# Acme Home rebuild — product spec",
  "",
  "Intro prose before any section is ignored.",
  "",
  "## Background",
  "Acme Home is the landing surface for signed-in users.",
  "",
  "## Who is this for",
  "Customers on web and mobile.",
  "",
  "### Acceptance criteria",
  "- Home renders the account switcher",
  "- Deposits open the cashier",
  "",
  "## Out of scope",
  "P2P flows.",
  "",
  "## Risks",
  "",
  "## API contracts",
  "Uses the orders API v3.",
].join("\n");

describe("splitSections", () => {
  it("splits on h2/h3 and ignores pre-heading prose", () => {
    const sections = splitSections(DOCUMENT);
    expect(sections.map((section) => section.heading)).toEqual([
      "Background",
      "Who is this for",
      "Acceptance criteria",
      "Out of scope",
      "Risks",
      "API contracts",
    ]);
  });
});

describe("seedSessionFromDocument", () => {
  it("maps headings to dimensions by synonym, skipping empty sections", () => {
    const answers = seedSessionFromDocument(DOCUMENT);
    expect(answers.problem?.answer).toContain("landing surface");
    expect(answers.users?.answer).toContain("Customers on web");
    expect(answers.acceptance_criteria?.answer).toContain("account switcher");
    expect(answers.non_goals?.answer).toContain("P2P");
    expect(answers.api_contract?.answer).toContain("v3");
    // "Risks" exists but is EMPTY — an empty heading covers nothing.
    expect(answers.risks).toBeUndefined();
    // Nothing invented for dimensions the document never mentions.
    expect(answers.rollout).toBeUndefined();
  });

  it("mined confidence clears the readiness threshold but stays below a direct answer", () => {
    const answers = seedSessionFromDocument(DOCUMENT);
    expect(answers.problem?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(answers.problem?.confidence).toBeLessThan(0.9);
  });

  it("prototype states seed journey_states over the document's prose", () => {
    const answers = seedSessionFromDocument(DOCUMENT, {
      figmaStates: ["Home", "Trade"],
      platform: "web_ai",
    });
    expect(answers.journey_states?.answer).toContain("Home, Trade");
    expect(answers.journey_states?.confidence).toBe(0.9);
    expect(answers.platforms?.answer).toContain("web_ai");
  });

  it("truncates a sprawling section instead of blowing the coverage record", () => {
    const sprawling = `## Background\n${"x".repeat(5000)}\n`;
    const answers = seedSessionFromDocument(sprawling);
    expect(answers.problem?.answer?.length).toBeLessThan(2200);
    expect(answers.problem?.answer).toContain("truncated");
  });

  it("is deterministic", () => {
    expect(seedSessionFromDocument(DOCUMENT)).toEqual(seedSessionFromDocument(DOCUMENT));
  });
});

describe("seedAnswersForTool", () => {
  it("emits the wire array shape start_spec_session.seedAnswers accepts", () => {
    const seeds = seedAnswersForTool(DOCUMENT, { figmaStates: ["Home"] });
    for (const seed of seeds) {
      expect(typeof seed.dimension).toBe("string");
      expect(seed.answer.length).toBeGreaterThan(0);
      expect(seed.confidence).toBeGreaterThan(0);
    }
    expect(seeds.some((seed) => seed.dimension === "journey_states")).toBe(true);
  });
});

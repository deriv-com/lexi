import { describe, it, expect } from "vitest";
import {
  parseSlackInvestigationText,
  isInvestigationComplete,
} from "./investigation-parser";
import { formatAcknowledgement, formatOutcomeSummary } from "./templates";

describe("Slack certification — structured parsing", () => {
  it("parses blocked-by OTP into structured fields", () => {
    const investigation = parseSlackInvestigationText({
      issueNumber: 909,
      text: "blocked by: otp\naccount type: real\nsteps executed: login\nlifecycle state: pre_otp",
      responderUserId: "U1",
      slackThreadTs: "1.1",
    });
    expect(investigation.blockedBy).toBe("otp");
    expect(investigation.accountType).toBe("real");
  });

  it("marks shallow cannot-reproduce as incomplete", () => {
    const investigation = parseSlackInvestigationText({
      issueNumber: 909,
      text: "Could not reproduce after following steps.",
      responderUserId: "U1",
      slackThreadTs: "1.1",
    });
    expect(investigation.verdict).toBe("NOT_OBSERVED");
    expect(isInvestigationComplete(investigation)).toBe(false);
  });

  it("accepts structured hub reach with evidence", () => {
    const investigation = parseSlackInvestigationText({
      issueNumber: 909,
      text: [
        "account type: real",
        "environment: https://app.example.com",
        "steps executed: login, hub",
        "lifecycle state: authenticated_hub",
        "supporting evidence: https://files.example.com/e.png",
        "Reached the home screen, no issue seen",
        "Result: NOT_REPRODUCED",
      ].join("\n"),
      responderUserId: "U1",
      slackThreadTs: "1.1",
    });
    expect(investigation.lifecycleCoverage.coverageComplete).toBe(true);
    expect(isInvestigationComplete(investigation)).toBe(true);
  });
});

describe("Slack certification — write gate messaging", () => {
  it("formatOutcomeSummary distinguishes policy vs execution when writes disabled", () => {
    const text = formatOutcomeSummary({
      githubNumber: 909,
      classification: "CANNOT_REPRODUCE",
      confidence: 0.86,
      actionsTaken: ["Issue kept open"],
      closeRecommended: true,
      writesEnabled: false,
    });
    expect(text).toContain("GOVERNED_WRITES_ENABLED=false");
    expect(text).toContain("Policy recommends closing");
  });
});

describe("Slack certification — acknowledgement", () => {
  it("acknowledgement mentions issue number immediately", () => {
    const text = formatAcknowledgement(909);
    expect(text).toContain("909");
    expect(text.length).toBeLessThan(500);
  });
});

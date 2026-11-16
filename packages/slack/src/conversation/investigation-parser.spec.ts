import { describe, it, expect } from "vitest";
import { parseSlackInvestigationText, isInvestigationComplete } from "./investigation-parser";

describe("parseSlackInvestigationText", () => {
  it("marks shallow cannot-reproduce as incomplete", () => {
    const result = parseSlackInvestigationText({
      issueNumber: 909,
      text: "Could not reproduce the reported issue after following the provided steps.",
      responderUserId: "U1",
      slackThreadTs: "123.456",
    });
    expect(result.verdict).toBe("NOT_OBSERVED");
    expect(result.lifecycleCoverage.coverageComplete).toBe(false);
    expect(isInvestigationComplete(result)).toBe(false);
  });

  it("parses structured lifecycle and account markers", () => {
    const result = parseSlackInvestigationText({
      issueNumber: 909,
      text: [
        "account type: real",
        "environment: https://app.example.com",
        "steps executed: login, open calculator",
        "lifecycle state: authenticated_hub",
        "supporting evidence: https://files.example.com/shot.png",
        "Result: REPRODUCED",
      ].join("\n"),
      responderUserId: "U1",
      slackThreadTs: "123.456",
    });
    expect(result.accountType).toBe("real");
    expect(result.lifecycleCoverage.coverageComplete).toBe(true);
    expect(result.evidenceUrls.length).toBeGreaterThan(0);
    expect(isInvestigationComplete(result)).toBe(true);
  });
});

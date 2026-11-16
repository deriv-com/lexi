import { describe, it, expect } from "vitest";
import { renderNotification } from "./render-notification";
import { NOTIFICATION_TEMPLATES, NotificationContext } from "./types";

const baseContext: NotificationContext = {
  issue: {
    number: 123,
    title: "Deposit button broken",
    url: "https://github.com/acme-internal/issues/issues/123",
    repoOwner: "acme-internal",
    repoName: "issues",
  },
  decision: {
    classification: "VERIFIED",
    summary: "Confirmed broken.",
    reasoning: "Reproduced via mock bot.",
    nextAction: "Assign to Payments team.",
    confidence: 0.87,
  },
  team: "Payments",
  owner: "jane",
  daysSinceLastUpdate: 5,
  reason: "No PR opened yet.",
};

describe("renderNotification", () => {
  it("renders all six template types without throwing", () => {
    for (const template of NOTIFICATION_TEMPLATES) {
      const rendered = renderNotification(template, baseContext);
      expect(rendered.text.length).toBeGreaterThan(0);
      expect(rendered.blocks.length).toBeGreaterThan(0);
    }
  });

  it("includes the issue reference in every rendered template", () => {
    for (const template of NOTIFICATION_TEMPLATES) {
      const rendered = renderNotification(template, baseContext);
      const serialized = JSON.stringify(rendered.blocks);
      expect(serialized).toContain("acme-internal/issues#123");
    }
  });

  it("includes confidence and team info in the VERIFIED template", () => {
    const rendered = renderNotification("VERIFIED", baseContext);
    const serialized = JSON.stringify(rendered.blocks);
    expect(serialized).toContain("87%");
    expect(serialized).toContain("Payments");
  });

  it("includes days-since-update in REMINDER and ESCALATION templates", () => {
    const reminder = renderNotification("REMINDER", baseContext);
    const escalation = renderNotification("ESCALATION", baseContext);
    expect(JSON.stringify(reminder.blocks)).toContain("5 day(s)");
    expect(JSON.stringify(escalation.blocks)).toContain("5 day(s)");
  });

  // A hand-off renders through ESCALATION and supplies no age.
  // This used to print "stalled for *0 day(s)* with no progress" — a stall that
  // never happened, on an issue whose cycle had just produced a verdict.
  describe("when no staleness age is supplied", () => {
    const handoff: NotificationContext = {
      ...baseContext,
      daysSinceLastUpdate: undefined,
      reason: "Needs manual review — reproduction requires a human on a real device.",
    };

    it("claims no stall in ESCALATION, and says why instead", () => {
      const serialized = JSON.stringify(renderNotification("ESCALATION", handoff).blocks);
      expect(serialized).not.toContain("day(s)");
      expect(serialized).not.toContain("stalled");
      expect(serialized).toContain("Needs manual review");
    });

    it("does not call the issue overdue in the ESCALATION fallback text", () => {
      const rendered = renderNotification("ESCALATION", handoff);
      expect(rendered.text).not.toContain("overdue");
      expect(rendered.text).toContain("needs attention");
    });

    it("claims no elapsed time in REMINDER either", () => {
      const serialized = JSON.stringify(renderNotification("REMINDER", handoff).blocks);
      expect(serialized).not.toContain("day(s)");
      expect(serialized).toContain("Needs manual review");
    });

    it("still renders every template without a reason to fall back on", () => {
      const bare: NotificationContext = { ...handoff, reason: undefined };
      for (const template of NOTIFICATION_TEMPLATES) {
        const rendered = renderNotification(template, bare);
        expect(rendered.blocks.length).toBeGreaterThan(0);
        expect(JSON.stringify(rendered.blocks)).not.toContain("0 day(s)");
      }
    });
  });
});

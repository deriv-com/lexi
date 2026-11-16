import { describe, expect, it } from "vitest";
import { DEFAULT_USER_TURN_LIMIT, DEFAULT_USER_TURN_WINDOW_MS, readSlackSafetySettings } from "./slack-safety-settings";

describe("readSlackSafetySettings", () => {
  it("defaults to a per-person limit and github.com only", () => {
    expect(readSlackSafetySettings({})).toEqual({
      userRateLimit: { maxTurns: DEFAULT_USER_TURN_LIMIT, windowMs: DEFAULT_USER_TURN_WINDOW_MS },
      linkHosts: [],
    });
  });

  it("reads the limit, allows switching it off, and ignores malformed values", () => {
    expect(readSlackSafetySettings({ SLACK_USER_TURN_LIMIT: "5", SLACK_USER_TURN_WINDOW_MS: "60000" }).userRateLimit).toEqual({
      maxTurns: 5,
      windowMs: 60_000,
    });
    expect(readSlackSafetySettings({ SLACK_USER_TURN_LIMIT: "0" }).userRateLimit.maxTurns).toBe(0);
    expect(readSlackSafetySettings({ SLACK_USER_TURN_LIMIT: "lots", SLACK_USER_TURN_WINDOW_MS: "0" }).userRateLimit).toEqual({
      maxTurns: DEFAULT_USER_TURN_LIMIT,
      windowMs: DEFAULT_USER_TURN_WINDOW_MS,
    });
  });

  it("parses link hosts and drops anything that is not a host name", () => {
    expect(readSlackSafetySettings({ SLACK_LINK_HOSTS: " Docs.Acme.test, https://x.test/, acme.test ,localhost" }).linkHosts).toEqual([
      "docs.acme.test",
      "acme.test",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { parseAppBuildBindings } from "./bindings";

describe("parseAppBuildBindings", () => {
  const fallback = { channel: "C0TEST01", repoKey: "markets_web" };

  it("falls back to the default channel and repository key when unset", () => {
    expect(parseAppBuildBindings("", fallback)).toEqual([{ channel: "C0TEST01", repoKey: "markets_web" }]);
    expect(parseAppBuildBindings(undefined, fallback)).toEqual([{ channel: "C0TEST01", repoKey: "markets_web" }]);
  });

  it("still names the primary repo, with an empty channel, when no channel is configured", () => {
    expect(parseAppBuildBindings("", { channel: "", repoKey: "markets_web" })).toEqual([{ channel: "", repoKey: "markets_web" }]);
  });

  it("parses several bindings in order, trimming whitespace", () => {
    expect(parseAppBuildBindings(" C0TEST01:markets_web , C0TEST02:markets_mobile ,", fallback)).toEqual([
      { channel: "C0TEST01", repoKey: "markets_web" },
      { channel: "C0TEST02", repoKey: "markets_mobile" },
    ]);
  });

  it("refuses a malformed entry, a bad channel id, a bad key, and a duplicate channel", () => {
    expect(() => parseAppBuildBindings("markets_web", fallback)).toThrow(/not "<channel id>:<repository key>"/);
    expect(() => parseAppBuildBindings("C0TEST01:", fallback)).toThrow(/not "<channel id>/);
    expect(() => parseAppBuildBindings("team_markets:markets_mobile", fallback)).toThrow(/not a Slack channel id/);
    expect(() => parseAppBuildBindings("C0TEST02:Markets Mobile", fallback)).toThrow(/not a repository key/);
    expect(() => parseAppBuildBindings("C0TEST02:markets_mobile,C0TEST02:markets_web", fallback)).toThrow(/bound twice/);
    expect(() => parseAppBuildBindings(" , ", fallback)).toThrow(/holds no binding/);
  });
});

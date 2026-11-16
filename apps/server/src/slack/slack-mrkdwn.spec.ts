import { describe, it, expect } from "vitest";
import { toSlackMrkdwn } from "./slack-mrkdwn";

describe("toSlackMrkdwn", () => {
  it("converts Markdown bold to mrkdwn bold", () => {
    expect(toSlackMrkdwn("this is **bold** and __also bold__")).toBe("this is *bold* and *also bold*");
  });

  it("turns bullets at any indent into Slack bullets", () => {
    expect(toSlackMrkdwn("- one\n  * two\n+ three")).toBe("• one\n  • two\n• three");
  });

  it("renders headings as a bold line and drops horizontal rules", () => {
    expect(toSlackMrkdwn("## Summary\n---\nbody")).toBe("*Summary*\nbody");
    expect(toSlackMrkdwn("# **Already bold**")).toBe("*Already bold*");
  });

  it("renders a table as one labelled bullet per row", () => {
    const table = ["| Issue | State |", "| --- | --- |", "| #1 | open |", "| #2 | closed |"].join("\n");
    expect(toSlackMrkdwn(table)).toBe("• *Issue*: #1 — *State*: open\n• *Issue*: #2 — *State*: closed");
  });

  it("labels GitHub issue and pull request links with their number", () => {
    expect(toSlackMrkdwn("see https://github.com/acme/web/issues/42")).toBe(
      "see <https://github.com/acme/web/issues/42|#42>",
    );
    expect(toSlackMrkdwn("[the fix](https://github.com/acme/web/pull/7)")).toBe(
      "<https://github.com/acme/web/pull/7|#7>",
    );
  });

  it("leaves code, Slack entities and existing mrkdwn untouched", () => {
    const input = [
      "```",
      "- not a bullet **not bold**",
      "```",
      "`**inline code**` <@U0ALICE1> <https://github.com/acme/web|a **link**> <https://example.com> :tada: *bold* _italic_",
    ].join("\n");
    expect(toSlackMrkdwn(input)).toBe(input);
  });

  it("turns broadcast and user-group mentions into text that pings nobody, code included", () => {
    expect(toSlackMrkdwn("hey <!channel> and <!here|here> and <!everyone>")).toBe("hey @channel and @here and @everyone");
    expect(toSlackMrkdwn("cc <!subteam^S0TEST01|@release-team> <!subteam^S0TEST02>")).toBe("cc @release-team @group");
    expect(toSlackMrkdwn("```\n<!here>\n```")).toBe("```\n@here\n```");
  });

  it("keeps masked links only for allowlisted hosts and shows the rest as plain URLs", () => {
    expect(toSlackMrkdwn("<https://github.com/acme/web/pull/7|the fix>")).toBe("<https://github.com/acme/web/pull/7|the fix>");
    expect(toSlackMrkdwn("<https://gist.github.com/a/1|gist>")).toBe("<https://gist.github.com/a/1|gist>");
    expect(toSlackMrkdwn("<https://evil.example/login|https://github.com/acme/web>")).toBe(
      "https://github.com/acme/web (https://evil.example/login)",
    );
    expect(toSlackMrkdwn("<https://github.com.evil.example/x|GitHub>")).toBe("GitHub (https://github.com.evil.example/x)");
    expect(toSlackMrkdwn("<javascript:alert(1)|click>")).toBe("click (javascript:alert(1))");
    expect(toSlackMrkdwn("<https://docs.acme.test/a|docs>", { linkHosts: ["acme.test"] })).toBe("<https://docs.acme.test/a|docs>");
  });

  it("stays idempotent after neutralising", () => {
    const input = "<!here> <https://evil.example/x|label> <!subteam^S0TEST01|@ops>";
    const once = toSlackMrkdwn(input);
    expect(toSlackMrkdwn(once)).toBe(once);
  });

  it("is idempotent", () => {
    const input = "## Title\n- **a** https://github.com/acme/web/issues/3\n| h1 | h2 |\n|---|---|\n| x | y |";
    const once = toSlackMrkdwn(input);
    expect(toSlackMrkdwn(once)).toBe(once);
  });

  it("passes empty input through", () => {
    expect(toSlackMrkdwn("")).toBe("");
  });
});

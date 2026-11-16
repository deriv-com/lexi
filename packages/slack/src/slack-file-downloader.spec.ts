import { describe, it, expect, vi, afterEach } from "vitest";
import { downloadSlackFile, isLikelyMissingScopeError, isSlackFileUrl, SlackFileDownloadError } from "./slack-file-downloader";

describe("downloadSlackFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the bot token as a Bearer auth header and returns the bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadSlackFile("https://files.slack.com/f1", "xoxb-token", "F123");

    expect(fetchMock).toHaveBeenCalledWith("https://files.slack.com/f1", {
      headers: { Authorization: "Bearer xoxb-token" },
      redirect: "manual",
    });
    expect(Buffer.compare(result, Buffer.from(bytes))).toBe(0);
  });

  it("throws SlackFileDownloadError with the HTTP status on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "missing_scope",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadSlackFile("https://files.slack.com/f1", "xoxb-token", "F123")).rejects.toMatchObject({
      status: 403,
      fileId: "F123",
    });
  });

  it("wraps a network-level failure as a SlackFileDownloadError with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("socket hang up")),
    );

    await expect(downloadSlackFile("https://files.slack.com/f1", "xoxb-token")).rejects.toMatchObject({
      status: 0,
    });
  });
});

describe("downloadSlackFile URL check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "https://attacker.example/f1",
    "http://files.slack.com/f1",
    "https://files.slack.com.attacker.example/f1",
    "https://user:pw@files.slack.com/f1",
    "https://files.slack.com:8443/f1",
    "not a url",
  ])("refuses %s without sending the token", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadSlackFile(url, "xoxb-token", "F123")).rejects.toBeInstanceOf(SlackFileDownloadError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts Slack's file hosts", () => {
    expect(isSlackFileUrl("https://files.slack.com/files-pri/T0/F1/a.png")).toBe(true);
    expect(isSlackFileUrl("https://files-pri.slack.com/x")).toBe(true);
    expect(isSlackFileUrl("https://files-edu.slack.com/x")).toBe(true);
  });

  it("follows a redirect that stays on Slack's file hosts, and refuses one that leaves", async () => {
    const bytes = new Uint8Array([9]);
    const redirect = (location: string) => ({ ok: false, status: 302, headers: new Headers({ location }) });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect("/files-pri/T0/F1/a.png"))
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer });
    vi.stubGlobal("fetch", fetchMock);
    await downloadSlackFile("https://files.slack.com/f1", "xoxb-token");
    expect(fetchMock.mock.calls[1][0]).toBe("https://files.slack.com/files-pri/T0/F1/a.png");

    const offHost = vi.fn().mockResolvedValueOnce(redirect("https://attacker.example/steal"));
    vi.stubGlobal("fetch", offHost);
    await expect(downloadSlackFile("https://files.slack.com/f1", "xoxb-token")).rejects.toMatchObject({ status: 302 });
    expect(offHost).toHaveBeenCalledOnce();
  });
});

describe("isLikelyMissingScopeError", () => {
  it("flags 401 and 403 as likely missing-scope", () => {
    expect(isLikelyMissingScopeError(new SlackFileDownloadError(401, "F1", "nope"))).toBe(true);
    expect(isLikelyMissingScopeError(new SlackFileDownloadError(403, "F1", "nope"))).toBe(true);
  });

  it("does not flag other statuses or non-download errors", () => {
    expect(isLikelyMissingScopeError(new SlackFileDownloadError(404, "F1", "not found"))).toBe(false);
    expect(isLikelyMissingScopeError(new Error("some other error"))).toBe(false);
  });
});

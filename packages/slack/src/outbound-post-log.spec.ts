import { describe, it, expect, vi } from "vitest";
import { formatOutboundSlackPost, logOutboundSlackPost } from "./outbound-post-log";

describe("formatOutboundSlackPost", () => {
  it("records where the message went and how big it was, never what it said", () => {
    const line = formatOutboundSlackPost({
      channel: "C123",
      threadTs: "1700000000.000100",
      text: "Issue #909 is still open because verification failed for Jane Doe",
      ok: true,
      ts: "1700000000.000200",
      origin: "agent_reply",
    });

    expect(line).toContain('"channel":"C123"');
    expect(line).toContain('"threadTs":"1700000000.000100"');
    expect(line).toContain('"ts":"1700000000.000200"');
    expect(line).toContain('"origin":"agent_reply"');
    expect(line).toContain('"ok":true');
    expect(line).toContain('"chars":65');

    expect(line).not.toContain("Jane");
    expect(line).not.toContain("verification");
    expect(line).not.toContain("#909");
  });

  it("carries a fingerprint so a burst of identical posts is recognisable as one", () => {
    // Picture a burst of ~7 messages in a minute. "Seven copies of the
    // same text" and "seven different messages" are very different faults, and
    // the fingerprint separates them without revealing either.
    const post = { channel: "C1", text: "same", ok: true, origin: "agent_reply" };
    const a = formatOutboundSlackPost(post);
    const b = formatOutboundSlackPost(post);
    const c = formatOutboundSlackPost({ ...post, text: "different" });

    const hashOf = (line: string) => /"textHash":"([0-9a-f]+)"/.exec(line)?.[1];
    expect(hashOf(a)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashOf(a)).toBe(hashOf(b));
    expect(hashOf(a)).not.toBe(hashOf(c));
  });

  it("counts blocks when the post is Block Kit rather than text", () => {
    const line = formatOutboundSlackPost({
      channel: "C1",
      text: "",
      blocks: [{ type: "section" }, { type: "actions" }],
      ok: true,
      origin: "notification",
    });
    expect(line).toContain('"blocks":2');
  });

  it("reports a failure with its error code", () => {
    const line = formatOutboundSlackPost({
      channel: "C1",
      text: "hello",
      ok: false,
      error: "channel_not_found",
      origin: "agent_reply",
    });
    expect(line).toContain('"ok":false');
    expect(line).toContain("channel_not_found");
  });

  it("omits a thread rather than inventing one for a top-level post", () => {
    const line = formatOutboundSlackPost({ channel: "C1", text: "hi", ok: true, origin: "notification" });
    expect(line).not.toContain("threadTs");
  });
});

describe("logOutboundSlackPost", () => {
  it("logs a successful post at info — the level production actually ships", () => {
    const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    logOutboundSlackPost(logger as never, { channel: "C1", text: "hi", ok: true, origin: "agent_reply" });

    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(String(logger.log.mock.calls[0][0])).toContain("Slack post:");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs a failed post at error, in the same shape", () => {
    const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    logOutboundSlackPost(logger as never, {
      channel: "C1",
      text: "hi",
      ok: false,
      error: "not_in_channel",
      origin: "agent_reply",
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain("Slack post:");
    expect(logger.log).not.toHaveBeenCalled();
  });
});

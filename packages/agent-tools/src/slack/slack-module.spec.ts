import { describe, expect, it, vi } from "vitest";
import type { SlackProvider } from "@lexi/slack";
import { createSlackToolModule, parseChannelPostAllowlist, POST_TO_CHANNEL_PERMISSION, type SlackThreadReader } from "./slack-module";
import { ctx, text, toolOf } from "../testing/fixtures";

function reader(response: Awaited<ReturnType<SlackThreadReader["conversations"]["replies"]>>): SlackThreadReader {
  return { conversations: { replies: vi.fn(async () => response) } };
}

function poster(result = { ok: true, ts: "1700000001.000200" }): SlackProvider {
  return { sendMessage: vi.fn(async () => result), updateMessage: vi.fn() };
}

describe("get_thread_context", () => {
  it("reads the current thread and lists attachments without reading them", async () => {
    const replies = reader({
      ok: true,
      messages: [
        { user: "U0TEST01", text: "Checkout is broken", files: [{ id: "F0TEST01", name: "screen.png", mimetype: "image/png", size: 20480 }] },
        { bot_id: "B0TEST01", text: "", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Filed acme/web#12" }, accessory: { value: "opaque" } }] },
      ],
    });
    const module = createSlackToolModule({ reader: replies });
    const out = text(await toolOf(module, "get_thread_context").invoke({}, ctx));
    expect(replies.conversations.replies).toHaveBeenCalledWith({ channel: "C0TEST01", ts: "1700000000.000100", limit: 200 });
    expect(out).toContain("[U0TEST01] Checkout is broken");
    expect(out).toContain("[bot:B0TEST01] Filed acme/web#12");
    expect(out).not.toContain("opaque");
    expect(out).toContain("screen.png (image/png, 20 KB, id F0TEST01");
    expect(out).toContain("contents were not read");
  });

  it("reads only the caller's own thread", async () => {
    const tool = toolOf(createSlackToolModule({ reader: reader({ ok: true, messages: [] }) }), "get_thread_context");
    expect(await tool.resource?.({}, ctx)).toEqual({ callerOnly: true });
  });

  it("degrades to a note when the thread cannot be read", async () => {
    const module = createSlackToolModule({ reader: reader({ ok: false, error: "missing_scope" }) });
    const result = await toolOf(module, "get_thread_context").invoke({}, ctx);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("missing_scope");
  });

  it("says when the thread may be longer than what was fetched", async () => {
    const module = createSlackToolModule({ reader: reader({ ok: true, messages: [{ user: "U0TEST02", text: "a" }] }), maxMessages: 1 });
    expect(text(await toolOf(module, "get_thread_context").invoke({}, ctx))).toContain("may be longer");
  });
});

describe("post_to_channel", () => {
  const build = (p = poster()) => createSlackToolModule({ poster: p, channelAllowlist: ["C0TEST09"] });

  it("is mutating and requires the channel-post permission", () => {
    const tool = toolOf(build(), "post_to_channel");
    expect(tool.mutating).toBe(true);
    expect(tool.requiredPermission).toBe(POST_TO_CHANNEL_PERMISSION);
  });

  it("is confined to the caller only when it posts to the caller's own channel", async () => {
    const tool = toolOf(build(), "post_to_channel");
    expect(await tool.resource?.({ text: "x" }, ctx)).toEqual({ callerOnly: true });
    expect(await tool.resource?.({ text: "x", channel: "C0TEST01" }, ctx)).toEqual({ callerOnly: true });
    // Another channel names no team, so a scoped grant cannot cover it.
    expect(await tool.resource?.({ text: "x", channel: "C0TEST09" }, ctx)).toBeUndefined();
  });

  it("posts to an allowlisted channel", async () => {
    const p = poster();
    const result = await toolOf(build(p), "post_to_channel").invoke({ channel: "C0TEST09", text: "Release is out." }, ctx);
    expect(result.outcome).toMatchObject({ executed: true });
    expect(p.sendMessage).toHaveBeenCalledWith({ channel: "C0TEST09", text: "Release is out." });
  });

  it("defaults to the conversation's own channel", async () => {
    const p = poster();
    await toolOf(build(p), "post_to_channel").invoke({ text: "hi" }, ctx);
    expect(p.sendMessage).toHaveBeenCalledWith({ channel: "C0TEST01", text: "hi" });
  });

  it.each([
    [{ channel: "C0TEST08", text: "x" }, "allowlist"],
    [{ channel: "C0TEST09", text: "Heads up @here" }, "pages a whole channel"],
    [{ channel: "C0TEST09", text: "<!channel> hi" }, "pages a whole channel"],
    [{ channel: "C0TEST09", text: "cc <!subteam^S0TEST01|@ops>" }, "user group"],
    [{ channel: "C0TEST09", text: "" }, "non-empty"],
  ])("refuses %o", async (args, expected) => {
    const p = poster();
    const result = await toolOf(build(p), "post_to_channel").invoke(args, ctx);
    expect(result.outcome).toMatchObject({ executed: false, blocked: true });
    expect(text(result)).toContain(expected);
    expect(p.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses a direct-message id even if allowlisted", async () => {
    const p = poster();
    const module = createSlackToolModule({ poster: p, channelAllowlist: ["D0TEST01"] });
    const result = await toolOf(module, "post_to_channel").invoke({ channel: "D0TEST01", text: "x" }, ctx);
    expect(result.outcome?.executed).toBe(false);
  });

  it("reports the write gate's refusal as not performed", async () => {
    const result = await toolOf(build(poster({ ok: false, error: "GOVERNED_DRY_RUN=true" } as never)), "post_to_channel").invoke({ text: "x" }, ctx);
    expect(result.outcome).toMatchObject({ executed: false, blocked: true });
    expect(text(result)).toContain("Writes are disabled");
  });

  it("reports a Slack rejection", async () => {
    const result = await toolOf(build(poster({ ok: false, error: "channel_not_found" } as never)), "post_to_channel").invoke({ text: "x" }, ctx);
    expect(result.outcome?.executed).toBe(false);
    expect(text(result)).toContain("channel_not_found");
  });
});

describe("module shape", () => {
  it("offers only the tools whose dependency is present", () => {
    expect(createSlackToolModule({}).tools).toEqual([]);
    expect(createSlackToolModule({ poster: poster() }).tools.map((t) => t.definition.name)).toEqual(["post_to_channel"]);
  });

  it("parses the allowlist setting", () => {
    expect(parseChannelPostAllowlist(" C0TEST01, ,G0TEST02 ")).toEqual(["C0TEST01", "G0TEST02"]);
    expect(parseChannelPostAllowlist(undefined)).toEqual([]);
  });
});

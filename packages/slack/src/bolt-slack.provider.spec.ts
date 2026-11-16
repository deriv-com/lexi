import { describe, it, expect, vi, beforeEach } from "vitest";
import { PinoLoggerService } from "@lexi/logger";
import { BoltSlackProvider } from "./bolt-slack.provider";
import type { App } from "@slack/bolt";

describe("BoltSlackProvider", () => {
  let app: { client: { chat: { postMessage: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } } };
  let provider: BoltSlackProvider;

  beforeEach(() => {
    app = {
      client: {
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ok: true, channel: "C123", ts: "123.456" }),
          update: vi.fn().mockResolvedValue({ ok: true, channel: "C123", ts: "123.456" }),
        },
      },
    };
    provider = new BoltSlackProvider(app as unknown as App, new PinoLoggerService({ level: "silent" }));
  });

  it("sends a message and returns the channel/ts", async () => {
    const result = await provider.sendMessage({ channel: "payments-alerts", text: "hello" });
    expect(result.ok).toBe(true);
    expect(result.ts).toBe("123.456");
    expect(app.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "payments-alerts", text: "hello" }),
    );
  });

  it("posts with link and media unfurls off", async () => {
    await provider.sendMessage({ channel: "C123", text: "see https://example.com" });
    expect(app.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ unfurl_links: false, unfurl_media: false }),
    );
  });

  it("returns ok:false when the Slack API call throws", async () => {
    app.client.chat.postMessage.mockRejectedValue(new Error("channel_not_found"));
    const result = await provider.sendMessage({ channel: "missing", text: "hello" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("channel_not_found");
  });

  it("updates an existing message", async () => {
    const result = await provider.updateMessage("C123", "123.456", "updated text");
    expect(result.ok).toBe(true);
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", ts: "123.456", text: "updated text" }),
    );
  });
});

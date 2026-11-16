import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PinoLoggerService } from "@lexi/logger";
import {
  ASSISTANT_THINKING_STATUS,
  loadingMessagesFor,
  setAssistantThreadStatus,
  type SlackAssistantStatusClient,
} from "./slack-assistant-status";

type ApiCall = NonNullable<SlackAssistantStatusClient["apiCall"]>;

function slackError(code: string): Error {
  const error = new Error(`An API error occurred: ${code}`);
  (error as unknown as { data: { error: string } }).data = { error: code };
  return error;
}

describe("setAssistantThreadStatus", () => {
  const logger = new PinoLoggerService({ level: "silent" });
  const args = { channel: "C123", threadTs: "1700.0001", kind: "general" as const };
  let apiCall: Mock<ApiCall>;

  beforeEach(() => {
    apiCall = vi.fn<ApiCall>().mockResolvedValue({ ok: true });
  });

  it("sets is thinking... with rotating Analyzing... loaders", async () => {
    const status = await setAssistantThreadStatus(
      { apiCall },
      { writesEnabled: true, dryRun: false },
      logger,
      args,
    );
    expect(status).toBe("applied");
    expect(apiCall).toHaveBeenCalledWith("assistant.threads.setStatus", {
      channel_id: "C123",
      thread_ts: "1700.0001",
      status: ASSISTANT_THINKING_STATUS,
      loading_messages: ["Analyzing...", "Thinking it through..."],
    });
  });

  it("varies the loader copy by request kind", () => {
    expect(loadingMessagesFor("lookup")).toContain("Analyzing...");
    expect(loadingMessagesFor("action")[0]).toMatch(/Working/);
    expect(loadingMessagesFor("diagnostics")[0]).toMatch(/Checking|diagnostics/i);
  });

  it("does not call Slack when the write gate is closed", async () => {
    const status = await setAssistantThreadStatus(
      { apiCall },
      { writesEnabled: false, dryRun: false },
      logger,
      args,
    );
    expect(status).toBe("suppressed");
    expect(apiCall).not.toHaveBeenCalled();
  });

  it("swallows feature_disabled so a missing Agents toggle cannot fail the turn", async () => {
    apiCall.mockRejectedValue(slackError("feature_disabled"));
    const status = await setAssistantThreadStatus(
      { apiCall },
      { writesEnabled: true, dryRun: false },
      logger,
      args,
    );
    expect(status).toBe("failed");
  });

  it("is a no-op when the client has no apiCall (test doubles)", async () => {
    const status = await setAssistantThreadStatus(
      {},
      { writesEnabled: true, dryRun: false },
      logger,
      args,
    );
    expect(status).toBe("failed");
  });
});

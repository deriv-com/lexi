import { describe, it, expect, vi, beforeEach } from "vitest";
import { PinoLoggerService } from "@lexi/logger";
import { SlackReactionGateway, extractSlackErrorCode, type SlackReactionClient } from "./slack-reaction.gateway";

/** Slack SDK-shaped error: machine code lives on `data.error`. */
function slackError(code: string): Error {
  const error = new Error(`An API error occurred: ${code}`);
  (error as unknown as { data: { error: string } }).data = { error: code };
  return error;
}

describe("SlackReactionGateway", () => {
  const logger = new PinoLoggerService({ level: "silent" });
  const target = { channel: "C123", messageTs: "1700.0001" };
  let client: { reactions: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    client = {
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
  });

  const enabled = () => new SlackReactionGateway({ writesEnabled: true, dryRun: false }, logger);
  const asClient = () => client as unknown as SlackReactionClient;

  it("adds a reaction with Slack's channel/timestamp/name shape", async () => {
    const outcome = await enabled().add(asClient(), target, "eyes");
    expect(outcome).toEqual({ status: "applied", emoji: "eyes" });
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1700.0001",
      name: "eyes",
    });
  });

  it("replaces the acknowledgement with the outcome emoji", async () => {
    const outcome = await enabled().replace(asClient(), target, "eyes", "white_check_mark");
    expect(outcome.status).toBe("applied");
    expect(client.reactions.remove).toHaveBeenCalledWith(expect.objectContaining({ name: "eyes" }));
    expect(client.reactions.add).toHaveBeenCalledWith(expect.objectContaining({ name: "white_check_mark" }));
  });

  it("does not remove-then-add when the emoji is unchanged", async () => {
    await enabled().replace(asClient(), target, "x", "x");
    expect(client.reactions.remove).not.toHaveBeenCalled();
    expect(client.reactions.add).toHaveBeenCalledTimes(1);
  });

  it("swallows a missing_scope failure instead of throwing", async () => {
    client.reactions.add.mockRejectedValue(slackError("missing_scope"));
    const outcome = await enabled().add(asClient(), target, "eyes");
    expect(outcome).toEqual({ status: "failed", emoji: "eyes", reason: "missing_scope" });
  });

  it("swallows arbitrary transport failures", async () => {
    client.reactions.add.mockRejectedValue(new Error("socket hang up"));
    await expect(enabled().add(asClient(), target, "eyes")).resolves.toMatchObject({ status: "failed" });
  });

  it("treats already_reacted as benign", async () => {
    client.reactions.add.mockRejectedValue(slackError("already_reacted"));
    const outcome = await enabled().add(asClient(), target, "eyes");
    expect(outcome).toEqual({ status: "benign", emoji: "eyes", reason: "already_reacted" });
  });

  it("treats no_reaction on remove as benign", async () => {
    client.reactions.remove.mockRejectedValue(slackError("no_reaction"));
    const outcome = await enabled().remove(asClient(), target, "eyes");
    expect(outcome).toEqual({ status: "benign", emoji: "eyes", reason: "no_reaction" });
  });

  it("treats a non-throwing error payload the same way", async () => {
    client.reactions.add.mockResolvedValue({ ok: false, error: "already_reacted" });
    const outcome = await enabled().add(asClient(), target, "eyes");
    expect(outcome.status).toBe("benign");
  });

  it("still attempts the outcome emoji when the ack removal fails", async () => {
    client.reactions.remove.mockRejectedValue(slackError("missing_scope"));
    const outcome = await enabled().replace(asClient(), target, "eyes", "x");
    expect(outcome.status).toBe("applied");
    expect(client.reactions.add).toHaveBeenCalledWith(expect.objectContaining({ name: "x" }));
  });

  it("suppresses and audits reactions when writes are disabled", async () => {
    const gateway = new SlackReactionGateway({ writesEnabled: false, dryRun: false }, logger);
    const outcome = await gateway.add(asClient(), target, "eyes");
    expect(outcome).toEqual({
      status: "suppressed",
      emoji: "eyes",
      reason: "GOVERNED_WRITES_ENABLED=false",
    });
    expect(client.reactions.add).not.toHaveBeenCalled();
    expect(gateway.dryRunAudit).toHaveLength(1);
    expect(gateway.dryRunAudit[0]).toMatchObject({ action: "reactions.add", emoji: "eyes", wouldExecute: true });
  });

  it("suppresses reactions in dry-run mode", async () => {
    const gateway = new SlackReactionGateway({ writesEnabled: true, dryRun: true }, logger);
    const outcome = await gateway.replace(asClient(), target, "eyes", "white_check_mark");
    expect(outcome.status).toBe("suppressed");
    expect(outcome.reason).toBe("GOVERNED_DRY_RUN=true");
    expect(client.reactions.add).not.toHaveBeenCalled();
    expect(client.reactions.remove).not.toHaveBeenCalled();
    expect(gateway.dryRunAudit).toHaveLength(2);
  });
});

describe("extractSlackErrorCode", () => {
  it("prefers data.error", () => {
    expect(extractSlackErrorCode(slackError("missing_scope"))).toBe("missing_scope");
  });

  it("falls back to the trailing token of the message", () => {
    expect(extractSlackErrorCode(new Error("An API error occurred: ratelimited"))).toBe("ratelimited");
  });

  it("handles non-errors", () => {
    expect(extractSlackErrorCode(undefined)).toBe("unknown");
  });
});

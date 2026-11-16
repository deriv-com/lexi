import { describe, it, expect } from "vitest";
import { chunkMessage } from "./slack-message-chunks";

describe("chunkMessage", () => {
  it("keeps a short message whole and drops an empty one", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
    expect(chunkMessage("   ")).toEqual([]);
  });

  it("splits on paragraph boundaries within the limit", () => {
    expect(chunkMessage("aaaa\n\nbbbb", 6)).toEqual(["aaaa", "bbbb"]);
  });

  it("closes and reopens a code fence cut across pieces", () => {
    const text = "```ts\n" + Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n") + "\n```";
    const pieces = chunkMessage(text, 30);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect((piece.match(/```/g) ?? []).length % 2).toBe(0);
      expect(piece.length).toBeLessThanOrEqual(30);
    }
  });
});

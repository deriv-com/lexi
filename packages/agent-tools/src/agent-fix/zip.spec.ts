import { describe, expect, it } from "vitest";
import { unzipMatching } from "./zip";
import { buildZip } from "../testing/zip-builder";

describe("unzipMatching", () => {
  it("reads deflated and stored entries that match", () => {
    const zip = buildZip([
      { name: "announcement.txt", content: "Shipped PR #4" },
      { name: "notes/handback.txt", content: "Needs a human", store: true },
      { name: "image.png", content: Buffer.from([1, 2, 3]) },
    ]);
    const entries = unzipMatching(zip, (name) => name.endsWith(".txt"));
    expect(entries.map((e) => [e.name, e.data.toString()])).toEqual([
      ["announcement.txt", "Shipped PR #4"],
      ["notes/handback.txt", "Needs a human"],
    ]);
  });

  it("skips traversal, absolute, encrypted and oversize entries", () => {
    const zip = buildZip([
      { name: "../escape.txt", content: "x" },
      { name: "/abs.txt", content: "x" },
      { name: "secret.txt", content: "x", flags: 1 },
      { name: "big.txt", content: "y".repeat(5000) },
      { name: "ok.txt", content: "fine" },
    ]);
    expect(unzipMatching(zip, () => true, { maxEntryBytes: 1000 }).map((e) => e.name)).toEqual(["ok.txt"]);
  });

  it("rejects something that is not a zip, and a zip64 marker", () => {
    expect(() => unzipMatching(Buffer.from("not a zip at all, just text"), () => true)).toThrow(/not a zip/);
    const zip = buildZip([{ name: "a.txt", content: "a" }]);
    zip.writeUInt32LE(0xffffffff, zip.length - 22 + 16);
    expect(() => unzipMatching(zip, () => true)).toThrow(/zip64/);
  });
});

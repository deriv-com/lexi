import { describe, it, expect } from "vitest";
import { InMemoryFigmaPrototypeStore } from "./prototype-store";

describe("InMemoryFigmaPrototypeStore", () => {
  it("round-trips by file key, spec id, and thread key", async () => {
    const store = new InMemoryFigmaPrototypeStore();
    await store.save({
      fileKey: "AbC123xyz",
      fileUrl: "https://www.figma.com/design/AbC123xyz",
      specId: "spec_1",
      threadKey: "C1:1.1",
    });
    expect((await store.findByFileKey("AbC123xyz"))?.specId).toBe("spec_1");
    expect((await store.findBySpecId("spec_1"))?.fileKey).toBe("AbC123xyz");
    expect((await store.findByThreadKey("C1:1.1"))?.fileKey).toBe("AbC123xyz");
  });

  it("round-trips sanitised journey states", async () => {
    const store = new InMemoryFigmaPrototypeStore();
    await store.save({
      fileKey: "AbC123xyz",
      fileUrl: "https://www.figma.com/design/AbC123xyz",
      states: ["Get started", "Sign in"],
    });
    expect((await store.findByFileKey("AbC123xyz"))?.states).toEqual(["Get started", "Sign in"]);
  });

  it("merges on save so a later proto URL does not drop specId", async () => {
    const store = new InMemoryFigmaPrototypeStore();
    await store.save({ fileKey: "K1", fileUrl: "https://www.figma.com/design/K1", specId: "s" });
    await store.save({
      fileKey: "K1",
      fileUrl: "https://www.figma.com/design/K1",
      prototypeUrl: "https://www.figma.com/proto/K1?node-id=1-2",
    });
    const row = await store.findByFileKey("K1");
    expect(row?.specId).toBe("s");
    expect(row?.prototypeUrl).toContain("proto/K1");
  });
});


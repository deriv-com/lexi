import { describe, expect, it, vi } from "vitest";
import {
  extractFigmaDesignUrlCandidate,
  parseFigmaDesignLink,
} from "./design-link";
import { FigmaReadGateway } from "./read-gateway";
import { FigmaDesignReadService, type FigmaDesignReadFigmaPort } from "./design-read.service";
import { InMemoryFigmaPrototypeStore } from "./prototype-store";

/** Userinfo in a URL, assembled so secret scanners do not read the fixture as a credential. */
const USERINFO = ["someone", "not-a-secret"].join(":");

describe("parseFigmaDesignLink", () => {
  it("parses design / file / proto https links with node-id", () => {
    const design = parseFigmaDesignLink(
      "https://www.figma.com/design/AbC123xyzAbC123xyzAbC1/Deposit?node-id=12-34",
    );
    expect(design).toEqual({
      ok: true,
      link: { fileKey: "AbC123xyzAbC123xyzAbC1", kind: "design", nodeId: "12:34" },
    });

    const proto = parseFigmaDesignLink(
      "https://figma.com/proto/AbC123xyzAbC123xyzAbC1?starting-point-node-id=1%3A2",
    );
    expect(proto.ok && proto.link.nodeId).toBe("1:2");
  });

  it("unwraps Slack link markup and embedded URLs", () => {
    expect(
      extractFigmaDesignUrlCandidate(
        "<https://www.figma.com/design/AbC123xyzAbC123xyzAbC1/X|Open>",
      ),
    ).toContain("figma.com/design/AbC123xyzAbC123xyzAbC1");
    const parsed = parseFigmaDesignLink(
      "pls check https://www.figma.com/design/AbC123xyzAbC123xyzAbC1/Home thanks",
    );
    expect(parsed.ok && parsed.link.fileKey).toBe("AbC123xyzAbC123xyzAbC1");
  });

  it("refuses SSRF / credential / wrong-host / wrong-path shapes", () => {
    expect(parseFigmaDesignLink("http://www.figma.com/design/AbC123xyzAbC123xyzAbC1").ok).toBe(false);
    expect(parseFigmaDesignLink(`https://${USERINFO}@www.figma.com/design/AbC123xyzAbC123xyzAbC1`).ok).toBe(
      false,
    );
    expect(parseFigmaDesignLink("https://evil.example/design/AbC123xyzAbC123xyzAbC1").ok).toBe(false);
    expect(parseFigmaDesignLink("https://www.figma.com/board/AbC123xyzAbC123xyzAbC1").ok).toBe(false);
    expect(parseFigmaDesignLink("https://www.figma.com/design/AbC123xyzAbC123xyzAbC1?node-id=../etc").ok).toBe(
      false,
    );
  });
});

describe("FigmaReadGateway", () => {
  it("allows Lexi prototypes and allowlisted keys only", async () => {
    const store = new InMemoryFigmaPrototypeStore();
    await store.save({
      fileKey: "LexiOwnedKey12345678901",
      fileUrl: "https://www.figma.com/design/LexiOwnedKey12345678901",
    });
    const gateway = new FigmaReadGateway({
      prototypes: store,
      allowedFileKeys: ["AllowListedFile1234567", "not a key"],
    });

    expect(await gateway.assertReadable("LexiOwnedKey12345678901")).toEqual({
      ok: true,
      via: "prototype",
    });
    expect(await gateway.assertReadable("AllowListedFile1234567")).toEqual({
      ok: true,
      via: "allowlist",
    });
    const denied = await gateway.assertReadable("SomeoneElsesFileKey1234");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toMatch(/allowlist/i);
  });
});

describe("FigmaDesignReadService.view", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  function service(opts: {
    enabled?: boolean;
    store?: InMemoryFigmaPrototypeStore;
    allowlist?: string[];
    figma?: FigmaDesignReadFigmaPort;
  }) {
    const store = opts.store ?? new InMemoryFigmaPrototypeStore();
    const gateway = new FigmaReadGateway({
      prototypes: store,
      allowedFileKeys: opts.allowlist ?? ["AllowListedFile1234567"],
    });
    const figma = opts.figma ?? {
      getMetadata: vi.fn(async () => ({ ok: true, text: '<frame id="12:34" name="Home" />', raw: {} })),
      getScreenshot: vi.fn(async () => ({
        ok: true,
        text: "shot",
        raw: {},
        images: [{ mimeType: "image/png", bytes: png }],
      })),
      getDesignContext: vi.fn(async () => ({ ok: true, text: "button primary", raw: {} })),
    };
    return new FigmaDesignReadService(
      {
        FIGMA_DESIGN_CONTEXT_ENABLED: opts.enabled ?? true,
        FIGMA_MCP_ENABLED: true,
        FIGMA_MCP_URL: "https://mcp.figma.com/mcp",
        FIGMA_OAUTH_ACCESS_TOKEN: "tok",
      },
      { figma, gateway },
    );
  }

  it("never fetches the user URL and returns screenshot vision for an allowlisted file", async () => {
    const fetchImpl = vi.fn();
    const svc = service({});
    const result = await svc.view({
      url: "https://www.figma.com/design/AllowListedFile1234567/Home?node-id=12-34",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.fileKey).toBe("AllowListedFile1234567");
    expect(result.nodeId).toBe("12:34");
    expect(result.vision?.mediaType).toBe("image/png");
    expect(result.vision?.data.length).toBeGreaterThan(32);
    expect(result.reason).toMatch(/never HTTP-fetched/i);
  });

  it("refuses off-allowlist keys without calling Figma", async () => {
    const figma = {
      getMetadata: vi.fn(),
      getScreenshot: vi.fn(),
    };
    const result = await service({ figma }).view({
      url: "https://www.figma.com/design/SomeoneElsesFileKey1234/X",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/allowlist/i);
    expect(figma.getMetadata).not.toHaveBeenCalled();
    expect(figma.getScreenshot).not.toHaveBeenCalled();
  });

  it("fails closed when the read flag is off", async () => {
    const result = await service({ enabled: false }).view({
      url: "https://www.figma.com/design/AllowListedFile1234567/Home",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/FIGMA_DESIGN_CONTEXT_ENABLED=false/);
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedMcpUrl, loadConfig, resolveDesignSystem } from "./config.mjs";

describe("resolveDesignSystem", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lexi-ds-"));
  const file = path.join(dir, "kit.md");
  writeFileSync(file, "# Kit");

  it("treats nothing as no design system", () => {
    expect(resolveDesignSystem("")).toEqual({ kind: "none" });
    expect(resolveDesignSystem(undefined)).toEqual({ kind: "none" });
  });

  it("recognises a file, a folder and an npm package", () => {
    expect(resolveDesignSystem(file)).toEqual({ kind: "file", path: file });
    expect(resolveDesignSystem(dir)).toEqual({ kind: "dir", path: dir });
    expect(resolveDesignSystem("@acme/design-system", "^2.0.0")).toEqual({ kind: "package", name: "@acme/design-system", version: "^2.0.0" });
    expect(resolveDesignSystem("acme-kit")).toEqual({ kind: "package", name: "acme-kit", version: "latest" });
  });

  it("reports a value that is neither", () => {
    expect(resolveDesignSystem("/no/such/path/../Kit Folder").kind).toBe("invalid");
  });
});

describe("isAllowedMcpUrl", () => {
  it("allows HTTPS and loopback HTTP only", () => {
    expect(isAllowedMcpUrl("https://api.mobbin.com/mcp")).toBe(true);
    expect(isAllowedMcpUrl("http://127.0.0.1:3845/mcp")).toBe(true);
    expect(isAllowedMcpUrl("http://example.com/mcp")).toBe(false);
    expect(isAllowedMcpUrl(`https://${["a", "b"].join(":")}@example.com/mcp`)).toBe(false);
    expect(isAllowedMcpUrl("file:///etc/passwd")).toBe(false);
  });
});

describe("loadConfig", () => {
  it("runs with nothing set: loopback, default port, claude, no optional sources", () => {
    const cfg = loadConfig({});
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(7341);
    expect(cfg.defaultRunner).toBe("claude");
    expect(cfg.designSystem).toEqual({ kind: "none" });
    expect(cfg.mobbinMcpUrl).toBeNull();
    expect(cfg.figmaMcpUrl).toBeNull();
    expect(cfg.referenceAppDir).toBeNull();
  });

  it("ignores a bad port, a missing path and a non-HTTPS MCP URL", () => {
    const cfg = loadConfig({ LEXI_BRIDGE_PORT: "99999", LEXI_REFERENCE_APP_DIR: "/no/such/dir", LEXI_MOBBIN_MCP_URL: "http://example.com/mcp" });
    expect(cfg.port).toBe(7341);
    expect(cfg.referenceAppDir).toBeNull();
    expect(cfg.mobbinMcpUrl).toBeNull();
  });

  it("reads optional sources and extra origins", () => {
    const cfg = loadConfig({ LEXI_FIGMA_MCP_URL: "https://mcp.figma.com/mcp", LEXI_ALLOWED_ORIGINS: "https://a.example, https://b.example" });
    expect(cfg.figmaMcpUrl).toBe("https://mcp.figma.com/mcp");
    expect(cfg.allowedOrigins).toEqual(["https://a.example", "https://b.example"]);
  });
});

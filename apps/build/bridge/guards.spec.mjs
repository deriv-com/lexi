import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedHost, isAllowedOrigin, isInside, resolvePreviewFile, resolveUiFile } from "./guards.mjs";

describe("isAllowedOrigin", () => {
  it("allows clients without an Origin and loopback browser origins", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:7341")).toBe(true);
    expect(isAllowedOrigin("http://localhost:4173")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:7341")).toBe(true);
  });

  it("refuses every other site unless it is listed", () => {
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1.evil.example")).toBe(false);
    expect(isAllowedOrigin("null")).toBe(false);
    expect(isAllowedOrigin("https://table.example", ["https://table.example"])).toBe(true);
  });
});

describe("isAllowedHost", () => {
  it("allows loopback names on the bound port", () => {
    expect(isAllowedHost("127.0.0.1:7341", 7341)).toBe(true);
    expect(isAllowedHost("localhost:7341", 7341)).toBe(true);
    expect(isAllowedHost("[::1]:7341", 7341)).toBe(true);
  });

  it("refuses a rebound name, another port, and malformed headers", () => {
    expect(isAllowedHost("evil.example:7341", 7341)).toBe(false);
    expect(isAllowedHost("127.0.0.1.evil.example:7341", 7341)).toBe(false);
    expect(isAllowedHost("127.0.0.1:8080", 7341)).toBe(false);
    expect(isAllowedHost("127.0.0.1", 7341)).toBe(false);
    expect(isAllowedHost("127.0.0.1:7341@evil.example", 7341)).toBe(false);
    expect(isAllowedHost("", 7341)).toBe(false);
    expect(isAllowedHost(undefined, 7341)).toBe(false);
  });
});

describe("isInside", () => {
  it("rejects escapes and sibling prefixes", () => {
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });
});

describe("resolvePreviewFile", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lexi-preview-"));
  mkdirSync(path.join(root, "shop", "dist", "assets"), { recursive: true });
  writeFileSync(path.join(root, "shop", "dist", "index.html"), "<h1>built</h1>");
  writeFileSync(path.join(root, "shop", "dist", "assets", "app.js"), "1");
  writeFileSync(path.join(root, "shop", "secret.txt"), "outside dist");
  mkdirSync(path.join(root, "plain"), { recursive: true });
  writeFileSync(path.join(root, "plain", "index.html"), "<h1>plain</h1>");
  writeFileSync(path.join(path.dirname(root), "lexi-preview-neighbour.txt"), "neighbour");

  it("serves the build output, preferring dist/", () => {
    expect(resolvePreviewFile(root, "shop/")).toBe(path.join(root, "shop", "dist", "index.html"));
    expect(resolvePreviewFile(root, "shop/assets/app.js")).toBe(path.join(root, "shop", "dist", "assets", "app.js"));
    expect(resolvePreviewFile(root, "plain/")).toBe(path.join(root, "plain", "index.html"));
  });

  it("refuses traversal, encoded traversal and anything outside the app root", () => {
    expect(resolvePreviewFile(root, "shop/../secret.txt")).toBeNull();
    expect(resolvePreviewFile(root, "shop/%2e%2e/secret.txt")).toBeNull();
    expect(resolvePreviewFile(root, "..%2Flexi-preview-neighbour.txt")).toBeNull();
    expect(resolvePreviewFile(root, "%2e%2e/x")).toBeNull();
    expect(resolvePreviewFile(root, "shop/missing.js")).toBeNull();
    expect(resolvePreviewFile(root, "shop/%E0%A4%A")).toBeNull();
  });
});

describe("resolveUiFile", () => {
  const ui = mkdtempSync(path.join(os.tmpdir(), "lexi-ui-"));
  writeFileSync(path.join(ui, "index.html"), "landing");
  writeFileSync(path.join(ui, "build.html"), "table");

  it("maps / to the landing page and refuses escapes", () => {
    expect(resolveUiFile(ui, "/")).toBe(path.join(ui, "index.html"));
    expect(resolveUiFile(ui, "/build.html")).toBe(path.join(ui, "build.html"));
    expect(resolveUiFile(ui, "/../etc/passwd")).toBeNull();
    expect(resolveUiFile(ui, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });
});

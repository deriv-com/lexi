import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAuthorization } from "./load-authorization";

const EXAMPLE_CONFIG_DIR = resolve(__dirname, "../../../../examples/config");

describe("loadAuthorization", () => {
  it("loads the example policy and evaluates against it", () => {
    const loaded = loadAuthorization(EXAMPLE_CONFIG_DIR);
    expect(loaded.loaded).toBe(true);
    expect(loaded.service.isReady()).toBe(true);
  });

  it("fails closed when the file is missing: every governed action is refused", () => {
    const loaded = loadAuthorization(mkdtempSync(join(tmpdir(), "authz-missing-")));
    expect(loaded.loaded).toBe(false);
    expect(loaded.error).toBeTruthy();
    expect(loaded.service.isReady()).toBe(false);
    expect(loaded.service.evaluate({ actorId: "U0ALICE1", action: "issue.read" }).allowed).toBe(false);
  });

  it("fails closed when the file is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "authz-invalid-"));
    writeFileSync(join(dir, "authorization.yaml"), "version: one\nroles: []\n");
    const loaded = loadAuthorization(dir);
    expect(loaded.loaded).toBe(false);
    expect(loaded.service.evaluate({ actorId: "U0ALICE1", action: "issue.read" }).allowed).toBe(false);
  });

  it("fails closed on unparseable YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "authz-yaml-"));
    writeFileSync(join(dir, "authorization.yaml"), "version: 1\nroles: [unclosed\n");
    expect(loadAuthorization(dir).loaded).toBe(false);
  });
});

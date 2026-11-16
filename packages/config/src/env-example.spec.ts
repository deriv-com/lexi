import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { envSchema } from "./env.schema";

/**
 * Guards two classes of configuration defect that are invisible at runtime
 * until a deploy breaks:
 *
 *  1. Leading whitespace on a key. `docker --env-file` and some source/export
 *     flows silently drop or misparse indented lines, so a flag that reads as
 *     "false" locally can be absent in a container.
 *  2. Drift between .env.example and the Zod schema — an example key the
 *     schema does not know about, which quietly does nothing.
 */
const EXAMPLE_PATH = resolve(__dirname, "../../../.env.example");

function readExampleLines(): string[] {
  return readFileSync(EXAMPLE_PATH, "utf8").split("\n");
}

function declaredKeys(): Array<{ key: string; line: number; raw: string }> {
  const entries: Array<{ key: string; line: number; raw: string }> = [];
  readExampleLines().forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return;
    entries.push({ key: trimmed.slice(0, eq), line: index + 1, raw });
  });
  return entries;
}

describe(".env.example parsing", () => {
  it("declares no key with leading whitespace", () => {
    const offenders = declaredKeys()
      .filter((entry) => /^\s/.test(entry.raw))
      .map((entry) => `${entry.line}: ${JSON.stringify(entry.raw)}`);

    expect(offenders, `indented keys will be dropped by some .env parsers:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("declares no duplicate keys", () => {
    const seen = new Map<string, number>();
    const duplicates: string[] = [];
    for (const entry of declaredKeys()) {
      const prior = seen.get(entry.key);
      if (prior !== undefined) duplicates.push(`${entry.key} (lines ${prior} and ${entry.line})`);
      else seen.set(entry.key, entry.line);
    }
    expect(duplicates).toEqual([]);
  });

  it("declares only keys the env schema knows about", () => {
    const schemaKeys = new Set(Object.keys(envSchema.shape));
    const unknown = declaredKeys()
      .map((entry) => entry.key)
      .filter((key) => !schemaKeys.has(key));

    expect(unknown, `keys in .env.example absent from env.schema.ts (they do nothing):\n${unknown.join("\n")}`).toEqual([]);
  });

  it("keeps write, scheduler, and agent expansion flags off by default in the example", () => {
    const text = readFileSync(EXAMPLE_PATH, "utf8");
    for (const flag of [
      "GOVERNED_WRITES_ENABLED",
      "SCHEDULER_ENABLED",
      "INTAKE_WATCHER_ENABLED",
      "SLACK_AGENT_ENABLED",
      "INTAKE_ALLOW_UNAUTHENTICATED",
      "DUPLICATE_SEMANTIC_ENABLED",
      "CLOSED_ISSUE_SEMANTICS_ENABLED",
    ]) {
      expect(text, `${flag} must be false in .env.example`).toMatch(
        new RegExp(`^${flag}=false$`, "m"),
      );
    }
  });
});

import { readFileSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";
import { peopleOverridesConfigSchema, PeopleOverridesConfig } from "./people-overrides.schema";

/**
 * Loads and validates `config/people-overrides.yaml`. Mirrors
 * `load-ownership-config.ts`: a malformed file throws with the offending
 * paths so misconfiguration is caught at boot rather than producing a
 * silently empty directory.
 *
 * A *missing* file is not an error — overrides are optional, and the manager
 * edges they mostly exist to carry are deferred.
 */
export function loadPeopleOverrides(configDir: string): PeopleOverridesConfig {
  let raw: string;
  try {
    raw = readFileSync(join(configDir, "people-overrides.yaml"), "utf-8");
  } catch {
    return { people: [] };
  }
  return parsePeopleOverrides(raw);
}

export function parsePeopleOverrides(raw: string): PeopleOverridesConfig {
  const parsed = load(raw);
  // An empty file parses to undefined/null, which is a valid "no overrides".
  const result = peopleOverridesConfigSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid people-overrides configuration:\n${issues}`);
  }
  return result.data;
}

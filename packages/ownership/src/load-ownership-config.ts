import { readFileSync } from "fs";
import { load } from "js-yaml";
import { ownershipConfigSchema, OwnershipConfig } from "./ownership-config.schema";

/**
 * Loads and validates the ownership.yaml configuration file. Throws a
 * descriptive error if the file is missing or malformed so misconfiguration
 * is caught at boot rather than silently falling back to "unassigned".
 */
export function loadOwnershipConfig(path: string): OwnershipConfig {
  const raw = readFileSync(path, "utf-8");
  return parseOwnershipConfig(raw);
}

export function parseOwnershipConfig(raw: string): OwnershipConfig {
  const parsed = load(raw);
  const result = ownershipConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid ownership configuration:\n${issues}`);
  }
  return result.data;
}

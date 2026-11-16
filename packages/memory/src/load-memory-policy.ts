import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { memoryPolicySchema, type MemoryPolicy } from "./memory-policy.schema";

/**
 * Default location: `memory-policy.yaml` inside `GOVERNANCE_CONFIG_DIR`, the
 * directory every policy loader reads from (`./config` when unset).
 */
export const DEFAULT_MEMORY_POLICY_PATH = resolve(process.env.GOVERNANCE_CONFIG_DIR ?? "config", "memory-policy.yaml");

/**
 * Loads and validates `memory-policy.yaml`. Throws with the offending
 * paths so a bad budget is caught at boot rather than discovered as an
 * oversized prompt in production.
 */
export function loadMemoryPolicy(path: string = DEFAULT_MEMORY_POLICY_PATH): MemoryPolicy {
  const raw = readFileSync(path, "utf-8");
  return parseMemoryPolicy(raw);
}

export function parseMemoryPolicy(raw: string): MemoryPolicy {
  const parsed = load(raw);
  const result = memoryPolicySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
    throw new Error(`Invalid memory policy:\n${issues}`);
  }
  return result.data;
}

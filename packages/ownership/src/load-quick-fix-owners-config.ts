import { readFileSync } from "fs";
import { load } from "js-yaml";
import { quickFixOwnersConfigSchema, QuickFixOwnersConfig } from "./quick-fix-owners-config.schema";

/**
 * Loads and validates config/quick-fix-owners.yaml. Throws a descriptive
 * error if the file is missing or malformed so misconfiguration is caught at
 * boot rather than silently tagging no one at ship time.
 */
export function loadQuickFixOwnersConfig(path: string): QuickFixOwnersConfig {
  const raw = readFileSync(path, "utf-8");
  return parseQuickFixOwnersConfig(raw);
}

export function parseQuickFixOwnersConfig(raw: string): QuickFixOwnersConfig {
  const parsed = load(raw);
  const result = quickFixOwnersConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid quick-fix owners configuration:\n${issues}`);
  }
  return result.data;
}

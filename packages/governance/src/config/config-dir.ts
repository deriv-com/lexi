import { resolve } from "node:path";

/**
 * The directory every policy file is read from: `GOVERNANCE_CONFIG_DIR`, or
 * `config` relative to the working directory when it is unset.
 *
 * Read at call time rather than captured at import, so a process (or a test)
 * that sets the variable before calling a loader always gets the directory it
 * asked for. Never resolved relative to this source file: the policy files
 * belong to the deployment, not to the package.
 */
export function governanceConfigDir(): string {
  return process.env.GOVERNANCE_CONFIG_DIR || "config";
}

/** Absolute path of a policy file inside {@link governanceConfigDir}. */
export function governanceConfigPath(fileName: string): string {
  return resolve(governanceConfigDir(), fileName);
}

import * as dotenv from "dotenv";
import { envSchema, EnvConfig, assertConfigInvariants } from "./env.schema";

export interface LoadConfigOptions {
  /** Environment source to validate. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Whether to call dotenv.config() before validating. Defaults to true. */
  loadDotenv?: boolean;
  /** Path to a specific .env file. */
  dotenvPath?: string;
}

/**
 * Loads and validates environment configuration using Zod. Throws a
 * descriptive error listing every missing/invalid variable so misconfigured
 * deployments fail fast at boot instead of at first use.
 */
export function loadConfig(options: LoadConfigOptions = {}): EnvConfig {
  const { env = process.env, loadDotenv = true, dotenvPath } = options;

  if (loadDotenv) {
    dotenv.config(dotenvPath ? { path: dotenvPath } : undefined);
  }

  const result = envSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  assertConfigInvariants(result.data);

  return result.data;
}

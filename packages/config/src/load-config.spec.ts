import { describe, it, expect } from "vitest";
import { loadConfig } from "./load-config";

const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  GITHUB_TOKEN: "ghp_test",
  GITHUB_OWNER: "acme-internal",
  GITHUB_REPO: "issues",
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_SIGNING_SECRET: "signing-secret",
  OPENAI_API_KEY: "sk-test",
};

describe("loadConfig", () => {
  it("parses a valid environment and applies defaults", () => {
    const config = loadConfig({ env: baseEnv, loadDotenv: false });
    expect(config.PORT).toBe(3000);
    expect(config.BUGHUNT_LABEL).toBe("bug");
    expect(config.SCHEDULER_ENABLED).toBe(true);
    expect(config.OWNERSHIP_CONFIG_PATH).toBe("config/ownership.yaml");
    expect(config.QUICK_FIX_OWNERS_CONFIG_PATH).toBe("config/quick-fix-owners.yaml");
  });

  it("throws a descriptive error when required variables are missing", () => {
    expect(() => loadConfig({ env: {}, loadDotenv: false })).toThrowError(/DATABASE_URL/);
  });

  /**
   * GITHUB_TOKEN is a fallback, not a requirement: an App-authed deployment
   * (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY) carries no PAT at all. Credential
   * absence is enforced by createOctokitClient, not by the schema.
   */
  it("treats GITHUB_TOKEN as optional so a PAT-free App deployment can boot", () => {
    const { GITHUB_TOKEN: _omitted, ...noToken } = baseEnv;
    const config = loadConfig({ env: noToken, loadDotenv: false });
    expect(config.GITHUB_TOKEN).toBe("");

    const empty = loadConfig({ env: { ...baseEnv, GITHUB_TOKEN: "" }, loadDotenv: false });
    expect(empty.GITHUB_TOKEN).toBe("");
  });

  it("masks personal data sent to models unless MODEL_PII_MASKING is exactly false", () => {
    const defaults = loadConfig({ env: baseEnv, loadDotenv: false });
    expect(defaults.MODEL_PII_MASKING).toBe(true);
    expect(defaults.MODEL_PII_EXTRA_PATTERNS).toBe("");
    expect(loadConfig({ env: { ...baseEnv, MODEL_PII_MASKING: "False" }, loadDotenv: false }).MODEL_PII_MASKING).toBe(false);
    expect(loadConfig({ env: { ...baseEnv, MODEL_PII_MASKING: "flase" }, loadDotenv: false }).MODEL_PII_MASKING).toBe(true);
  });

  it("coerces numeric and boolean-like string values", () => {
    const config = loadConfig({
      env: { ...baseEnv, PORT: "4000", SCHEDULER_ENABLED: "false" },
      loadDotenv: false,
    });
    expect(config.PORT).toBe(4000);
    expect(config.SCHEDULER_ENABLED).toBe(false);
  });
});

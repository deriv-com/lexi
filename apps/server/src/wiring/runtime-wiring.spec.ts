import { describe, expect, it, vi } from "vitest";
import type { EnvConfig } from "@lexi/config";
import { PinoLoggerService } from "@lexi/logger";
import { MetricsRegistry } from "@lexi/metrics";
import { loadAuthorization } from "../authorization/load-authorization";
import { NotWiredError, UnknownRepositoryError } from "./errors";
import { createSlackApp } from "./infrastructure";
import {
  createAgentTurnRunner,
  createIssueWorkflowPort,
  modelPiiMasking,
  resolveRepository,
  type RuntimeWiringDeps,
} from "./runtime-wiring";

// vitest.config.ts points this at the fictional example org.
const CONFIG_DIR = process.env.GOVERNANCE_CONFIG_DIR as string;

function config(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    AGENT_NAME: "Lexi",
    GOVERNANCE_CONFIG_DIR: CONFIG_DIR,
    GITHUB_OWNER: "acme",
    GITHUB_REPO: "issues",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "test-secret",
    SLACK_APP_TOKEN: "",
    SLACK_CHANNEL_POST_ENABLED: false,
    SLACK_CHANNEL_POST_ALLOWLIST: "",
    SLACK_TURN_TIMEOUT_MS: 900_000,
    SLACK_AGENT_MODEL: "",
    LITELLM_API_KEY: "",
    LITELLM_BASE_URL: "",
    LITELLM_CLAUDE_MODEL: "claude-sonnet-5-5",
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    OPENAI_MODEL: "claude-sonnet-5-5",
    GOVERNED_WRITES_ENABLED: false,
    GOVERNED_DRY_RUN: false,
    ...overrides,
  } as EnvConfig;
}

function deps(overrides: Partial<EnvConfig> = {}): RuntimeWiringDeps {
  const cfg = config(overrides);
  const logger = new PinoLoggerService({ level: "silent", name: "test" });
  return {
    config: cfg,
    logger,
    authorization: loadAuthorization(CONFIG_DIR).service,
    prisma: {} as never,
    metrics: new MetricsRegistry(),
    slackApp: createSlackApp(cfg),
  };
}

const turn = {
  actorId: "U0TEST01",
  conversation: { channel: "C0TEST01", threadTs: "1700000000.000100" },
  text: "hello",
};

describe("runtime wiring", () => {
  it("refuses every message honestly when no model key is configured", async () => {
    const runner = createAgentTurnRunner(deps());
    await expect(runner.runTurn(turn)).rejects.toBeInstanceOf(NotWiredError);
  });

  it("builds a runner when a model key is configured", () => {
    const runner = createAgentTurnRunner(deps({ LITELLM_API_KEY: "test-key" }));
    expect(typeof runner.runTurn).toBe("function");
  });

  it("refuses issue actions when no GitHub client exists", async () => {
    const port = createIssueWorkflowPort(deps());
    await expect(port.process({ issueNumber: 1 })).rejects.toBeInstanceOf(NotWiredError);
  });
});

describe("modelPiiMasking", () => {
  function logger() {
    const log = new PinoLoggerService({ level: "silent", name: "test" });
    return Object.assign(log, { warn: vi.fn(), log: vi.fn(), debug: vi.fn() });
  }

  it("masks by default, and logs counts but never the values", () => {
    const log = logger();
    const option = modelPiiMasking(config(), log, "agent");
    expect(option).not.toBe(false);
    if (option === false) return;
    const result = option.masker!.mask("from alice@example.com");
    expect(result.text).toBe("from [email]");
    option.onMasked!(result.counts);
    expect(log.debug).toHaveBeenCalledWith("Masked before model call (agent): email=1", "RuntimeWiring");
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain("alice");
  });

  it("is off only when MODEL_PII_MASKING is false, and says so", () => {
    const log = logger();
    expect(modelPiiMasking(config({ MODEL_PII_MASKING: false }), log, "agent")).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("unmasked"), "RuntimeWiring");
  });

  it("applies extra patterns and warns once about a bad one", () => {
    const log = logger();
    const cfg = config({ MODEL_PII_MASKING: true, MODEL_PII_EXTRA_PATTERNS: "EMP-\\d+||(unclosed" });
    const agent = modelPiiMasking(cfg, log, "agent");
    modelPiiMasking(cfg, log, "decision-engine");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(agent !== false && agent.masker!.mask("EMP-42").text).toBe("[redacted]");
  });
});

describe("resolveRepository", () => {
  const cfg = { GITHUB_OWNER: "acme", GITHUB_REPO: "issues" };
  const registry = {
    listRepos: () => [{ key: "web", organization: "acme", repository: "web", slug: "acme/web", roles: [] }],
  };

  it("uses the default repository when none is named", () => {
    expect(resolveRepository({ issueNumber: 1 }, cfg, undefined)).toEqual(["acme", "issues"]);
  });

  it("accepts a registered repository, case-insensitively", () => {
    expect(resolveRepository({ repository: "Acme/Web", issueNumber: 1 }, cfg, registry as never)).toEqual(["Acme", "Web"]);
  });

  it("refuses a repository the deployment does not manage", () => {
    expect(() => resolveRepository({ repository: "someone/else", issueNumber: 1 }, cfg, registry as never)).toThrow(
      UnknownRepositoryError,
    );
  });
});

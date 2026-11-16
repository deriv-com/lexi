import { describe, expect, it, vi } from "vitest";
import type { EnvConfig } from "@lexi/config";
import { PinoLoggerService } from "@lexi/logger";
import { ProgrammeTicker } from "./programme-ticker";
import { createProgrammeWiring, type ProgrammeWiring } from "./programme-wiring";

const logger = new PinoLoggerService({ level: "silent", name: "test" });

function config(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    GOVERNANCE_CONFIG_DIR: process.env.GOVERNANCE_CONFIG_DIR as string,
    PROGRAMME_ENABLED: false,
    PROGRAMME_BRIEF_TOKEN: "",
    PROGRAMME_TICK_MS: 1000,
    EVIDENCE_INGEST_ENABLED: false,
    EVIDENCE_WEBHOOK_TOKEN: "",
    ...overrides,
  } as EnvConfig;
}

function wiring(overrides: Partial<EnvConfig> = {}): ProgrammeWiring {
  const action = vi.fn();
  return createProgrammeWiring({
    config: config(overrides),
    logger,
    authorization: {} as never,
    prisma: {} as never,
    slackApp: { action } as never,
    slack: {} as never,
  });
}

describe("programme wiring", () => {
  it("is off by default: no tools, no ticker, routes refuse", () => {
    const result = wiring();
    expect(result.toolModule).toBeUndefined();
    expect(result.advance).toBeUndefined();
    expect(result.http).toMatchObject({ programmeEnabled: false, build: null, store: null, evidence: null });
  });

  it("stays off when enabled without GitHub credentials or repos.yaml", () => {
    const result = wiring({ PROGRAMME_ENABLED: true });
    expect(result.toolModule).toBeUndefined();
    expect(result.http.programmeEnabled).toBe(false);
  });
});

describe("ProgrammeTicker", () => {
  it("does nothing when the programme is off", async () => {
    const ticker = new ProgrammeTicker(config(), logger, { http: {} as never });
    ticker.onApplicationBootstrap();
    await expect(ticker.tick()).resolves.toBeUndefined();
    await ticker.onApplicationShutdown();
  });

  it("never overlaps ticks and survives a failed one", async () => {
    let release!: () => void;
    const advance = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
      .mockRejectedValueOnce(new Error("boom"));
    const ticker = new ProgrammeTicker(config(), logger, { http: {} as never, advance });
    const first = ticker.tick();
    void ticker.tick();
    expect(advance).toHaveBeenCalledTimes(1);
    release();
    await first;
    await expect(ticker.tick()).resolves.toBeUndefined();
    expect(advance).toHaveBeenCalledTimes(2);
  });
});

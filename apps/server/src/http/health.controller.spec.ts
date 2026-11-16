import { describe, it, expect } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "./health.controller";

const healthyDb = { $queryRaw: async () => [{ "?column?": 1 }] };
const downDb = {
  $queryRaw: async () => {
    throw new Error("connection refused");
  },
};

describe("HealthController", () => {
  it("is live regardless of dependencies", () => {
    const controller = new HealthController(downDb, { isReady: () => false }, {});
    expect(controller.liveness().status).toBe("ok");
  });

  it("is ready when the database answers and the policy loaded", async () => {
    const controller = new HealthController(healthyDb, { isReady: () => true }, { CONFIG_REVISION: "r1" });
    await expect(controller.readiness()).resolves.toEqual({
      status: "ready",
      checks: { database: "ok", authorization: "ok", config: "ok" },
      configRevision: "r1",
    });
  });

  it("is not ready when the database is down or the policy did not load", async () => {
    for (const controller of [
      new HealthController(downDb, { isReady: () => true }, {}),
      new HealthController(healthyDb, { isReady: () => false }, {}),
    ]) {
      await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });
});

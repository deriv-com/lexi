import { describe, it, expect } from "vitest";
import { createLogger, PinoLoggerService } from "./logger";

describe("createLogger", () => {
  it("creates a pino logger instance with the configured level", () => {
    const logger = createLogger({ level: "debug", name: "test-logger" });
    expect(logger.level).toBe("debug");
  });
});

describe("PinoLoggerService", () => {
  it("implements the Nest LoggerService contract without throwing", () => {
    const service = new PinoLoggerService({ level: "silent" }, "TestContext");
    expect(() => service.log("hello")).not.toThrow();
    expect(() => service.error("boom", "extra")).not.toThrow();
    expect(() => service.warn("careful")).not.toThrow();
    expect(() => service.debug("details")).not.toThrow();
    expect(() => service.verbose("chatty")).not.toThrow();
  });

  it("supports deriving a child logger with a new context", () => {
    const service = new PinoLoggerService({ level: "silent" }, "Parent");
    const child = service.withContext("Child");
    expect(child).toBeInstanceOf(PinoLoggerService);
    expect(() => child.log("hi")).not.toThrow();
  });
});

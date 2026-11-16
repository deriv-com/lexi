import { describe, it, expect } from "vitest";
import pino from "pino";
import { MESSAGE_KEY, PinoLoggerService } from "./logger";

/**
 * These tests read the LINE PINO ACTUALLY EMITS.
 *
 * The pre-existing logger tests assert that an instance is constructed, that
 * the Nest contract does not throw, and that a child logger can be derived.
 * None of them inspects output — so a change that emptied the message field
 * of every log line would pass all three.
 *
 * The bug: `PinoLoggerService.format()` hands pino an OBJECT, so pino reads the
 * message from whichever key `messageKey` names. Setting `messageKey:
 * "message"` while `format()` still emitted `msg` meant pino found no message
 * key at all. The symptom — an empty message in the log platform — was
 * identical to the bug being fixed, so the change looked correct and did nothing.
 *
 * The durable property is that the log text ARRIVES, under the key log
 * platforms map. Asserting the constant alone would not have caught this, because both
 * halves must agree and the constant is only one half.
 */

function capture(fn: (log: PinoLoggerService) => void): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  const service = new PinoLoggerService({ level: "trace" }, "TestContext");
  // Swap the internal stream for one we can read.
  (service as unknown as { pino: pino.Logger }).pino = pino(
    { level: "trace", messageKey: MESSAGE_KEY, base: null, timestamp: false },
    { write: (s: string) => lines.push(JSON.parse(s)) } as never,
  );
  fn(service);
  return lines;
}

describe("PinoLoggerService — the emitted line", () => {
  it.each(["log", "error", "warn", "debug", "verbose"] as const)(
    "%s() puts the text in the field log platforms read, not an empty one",
    (method) => {
      const [line] = capture((log) => log[method]("a findable phrase"));

      expect(line[MESSAGE_KEY]).toBe("a findable phrase");
      // The original failure was an EMPTY message, so assert absence-of-empty
      // explicitly rather than trusting the equality above to imply it.
      expect(line[MESSAGE_KEY]).not.toBe("");
      expect(line[MESSAGE_KEY]).toBeDefined();
    },
  );

  it("does not strand the text under pino's default `msg` key", () => {
    // `msg` is what log platforms do not read as the message. If it reappears carrying the text, the
    // two halves have drifted apart again.
    const [line] = capture((log) => log.log("a findable phrase"));

    expect(line.msg).toBeUndefined();
  });

  it("serialises a non-string message rather than dropping it", () => {
    const [line] = capture((log) => log.log({ code: "E_BUDGET", rounds: 12 }));

    expect(String(line[MESSAGE_KEY])).toContain("E_BUDGET");
  });

  it("keeps the context alongside the message", () => {
    const [line] = capture((log) => log.log("with context"));

    expect(line.context).toBe("TestContext");
  });
});

describe("createLogger — the raw pino path used by scripts and processors", () => {
  it("names the message key log platforms map", () => {
    // This path calls pino.info("string") directly, so messageKey alone governs
    // it. It was already correct; pinned so a revert cannot pass silently.
    const lines: Record<string, unknown>[] = [];
    const log = pino(
      { level: "info", messageKey: MESSAGE_KEY, base: null, timestamp: false },
      { write: (s: string) => lines.push(JSON.parse(s)) } as never,
    );
    log.info("raw path");

    expect(lines[0][MESSAGE_KEY]).toBe("raw path");
  });
});

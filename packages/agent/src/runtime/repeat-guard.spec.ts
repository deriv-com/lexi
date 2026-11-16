import { describe, expect, it } from "vitest";
import { hashValue, RepeatGuard } from "./repeat-guard";

const ok = (content: string) => ({ content, executed: true });

describe("RepeatGuard", () => {
  it("does not treat distinct writes with identical acknowledgements as a loop", () => {
    const guard = new RepeatGuard({ maxRepeats: 1 });
    for (const key of ["a", "b", "c", "d"]) {
      expect(guard.beforeCall("remember", { key }, true)).toEqual({ action: "run" });
      expect(guard.afterCall("remember", { key }, true, ok('{"ok":true}'))).toEqual({ action: "continue" });
    }
  });

  it("does not treat two different reads returning the same bytes as a loop", () => {
    const guard = new RepeatGuard({ maxRepeats: 1 });
    expect(guard.afterCall("get_run", { id: 1 }, false, ok("in_progress"))).toEqual({ action: "continue" });
    expect(guard.afterCall("get_run", { id: 2 }, false, ok("in_progress"))).toEqual({ action: "continue" });
  });

  it("lets an identical read be polled until the streak passes the limit", () => {
    const guard = new RepeatGuard({ maxRepeats: 3 });
    const poll = () => {
      expect(guard.beforeCall("get_run", { id: 1 }, false)).toEqual({ action: "run" });
      return guard.afterCall("get_run", { id: 1 }, false, ok("in_progress"));
    };
    expect(poll().action).toBe("continue");
    expect(poll().action).toBe("continue");
    expect(poll().action).toBe("continue");
    const fourth = poll();
    expect(fourth.action).toBe("force_final");
    expect(fourth).toMatchObject({ reason: expect.stringContaining("4 times") });
  });

  it("resets the streak when the polled result changes", () => {
    const guard = new RepeatGuard({ maxRepeats: 2 });
    guard.afterCall("get_run", { id: 1 }, false, ok("queued"));
    guard.afterCall("get_run", { id: 1 }, false, ok("queued"));
    guard.afterCall("get_run", { id: 1 }, false, ok("in_progress"));
    expect(guard.afterCall("get_run", { id: 1 }, false, ok("in_progress")).action).toBe("continue");
  });

  it("never counts an exempt tool", () => {
    const guard = new RepeatGuard({ maxRepeats: 1, exemptTools: ["get_run"] });
    for (let i = 0; i < 5; i += 1) {
      expect(guard.afterCall("get_run", { id: 1 }, false, ok("in_progress")).action).toBe("continue");
    }
  });

  it("does not run an identical write a second time, and hands back the earlier result", () => {
    const guard = new RepeatGuard({ maxRepeats: 3 });
    guard.afterCall("comment", { body: "hi" }, true, ok("comment 7 posted"));
    const again = guard.beforeCall("comment", { body: "hi" }, true);
    expect(again.action).toBe("skip");
    expect(again).toMatchObject({ content: expect.stringContaining("comment 7 posted") });
    expect(again).not.toHaveProperty("forceFinal");
  });

  it("stops tool use once identical writes keep being requested", () => {
    const guard = new RepeatGuard({ maxRepeats: 1 });
    guard.afterCall("comment", { body: "hi" }, true, ok("posted"));
    expect(guard.beforeCall("comment", { body: "hi" }, true)).not.toHaveProperty("forceFinal");
    expect(guard.beforeCall("comment", { body: "hi" }, true)).toMatchObject({ forceFinal: expect.any(String) });
  });

  it("allows a failed write to be retried", () => {
    const guard = new RepeatGuard({ maxRepeats: 3 });
    guard.afterCall("comment", { body: "hi" }, true, { content: "timeout", isError: true, executed: false });
    expect(guard.beforeCall("comment", { body: "hi" }, true)).toEqual({ action: "run" });
  });
});

describe("hashValue", () => {
  it("ignores object key order", () => {
    expect(hashValue({ a: 1, b: { c: 2, d: 3 } })).toBe(hashValue({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });
});

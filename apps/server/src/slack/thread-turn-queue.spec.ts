import { describe, it, expect, vi } from "vitest";
import { ThreadTurnQueue } from "./thread-turn-queue";

/** A turn that finishes when the test says so. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("ThreadTurnQueue", () => {
  it("runs turns in one thread one at a time, in arrival order", async () => {
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    let running = 0;
    let maxRunning = 0;
    const queue = new ThreadTurnQueue<string>({
      maxQueuedPerThread: 5,
      queuedTtlMs: 60_000,
      run: async (item) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        order.push(`start:${item}`);
        const g = gate();
        gates.set(item, g);
        await g.promise;
        order.push(`end:${item}`);
        running -= 1;
      },
    });

    expect(queue.submit("C0TEST01:1.0", "a")).toBe("started");
    expect(queue.submit("C0TEST01:1.0", "b")).toBe("queued");
    expect(queue.submit("C0TEST01:1.0", "c")).toBe("queued");
    expect(queue.queuedCount("C0TEST01:1.0")).toBe(2);

    await flush();
    gates.get("a")!.open();
    await flush();
    gates.get("b")!.open();
    await flush();
    gates.get("c")!.open();
    await queue.idle();

    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    expect(maxRunning).toBe(1);
    expect(queue.isBusy("C0TEST01:1.0")).toBe(false);
  });

  it("runs different threads concurrently", async () => {
    const started: string[] = [];
    const g = gate();
    const queue = new ThreadTurnQueue<string>({
      maxQueuedPerThread: 1,
      queuedTtlMs: 60_000,
      run: async (item) => {
        started.push(item);
        await g.promise;
      },
    });

    expect(queue.submit("C0TEST01:1.0", "a")).toBe("started");
    expect(queue.submit("C0TEST01:2.0", "b")).toBe("started");
    await flush();
    expect(started).toEqual(["a", "b"]);
    expect(queue.activeCount()).toBe(2);
    g.open();
    await queue.idle();
  });

  it("never drops a message that fits the queue, even one arriving as a turn ends", async () => {
    const ran: string[] = [];
    const queue = new ThreadTurnQueue<string>({
      maxQueuedPerThread: 2,
      queuedTtlMs: 60_000,
      run: async (item) => {
        ran.push(item);
        // Submitted while this thread's previous turn is finishing.
        if (item === "a") queue.submit("t", "late");
      },
    });

    queue.submit("t", "a");
    await queue.idle();
    expect(ran).toEqual(["a", "late"]);
  });

  it("rejects beyond the bound and keeps everything inside it", async () => {
    const g = gate();
    const ran: string[] = [];
    const queue = new ThreadTurnQueue<string>({
      maxQueuedPerThread: 2,
      queuedTtlMs: 60_000,
      run: async (item) => {
        ran.push(item);
        if (item === "a") await g.promise;
      },
    });

    expect(queue.submit("t", "a")).toBe("started");
    expect(queue.submit("t", "b")).toBe("queued");
    expect(queue.submit("t", "c")).toBe("queued");
    expect(queue.submit("t", "d")).toBe("rejected");
    g.open();
    await queue.idle();
    expect(ran).toEqual(["a", "b", "c"]);
  });

  it("hands a follow-up that waited past its TTL to onStale instead of running it", async () => {
    let now = 1_000;
    const g = gate();
    const ran: string[] = [];
    const stale: Array<[string, number]> = [];
    const queue = new ThreadTurnQueue<string>({
      maxQueuedPerThread: 5,
      queuedTtlMs: 100,
      now: () => now,
      run: async (item) => {
        ran.push(item);
        if (item === "a") await g.promise;
      },
      onStale: async (item, waited) => {
        stale.push([item, waited]);
      },
    });

    queue.submit("t", "a");
    queue.submit("t", "old");
    now += 50;
    queue.submit("t", "fresh");
    now += 80; // "old" has waited 130ms, "fresh" 80ms.
    g.open();
    await queue.idle();

    expect(ran).toEqual(["a", "fresh"]);
    expect(stale).toEqual([["old", 130]]);
  });

  it("keeps draining when a turn throws", async () => {
    const onError = vi.fn();
    const ran: string[] = [];
    const queue = new ThreadTurnQueue<string>({
      maxQueuedPerThread: 5,
      queuedTtlMs: 60_000,
      onError,
      run: async (item) => {
        ran.push(item);
        if (item === "a") throw new Error("boom");
      },
    });

    queue.submit("t", "a");
    queue.submit("t", "b");
    await queue.idle();
    expect(ran).toEqual(["a", "b"]);
    expect(onError).toHaveBeenCalledWith("a", expect.any(Error));
  });

  it("with a bound of zero, refuses anything while the thread is busy", async () => {
    const g = gate();
    const queue = new ThreadTurnQueue<string>({
      maxQueuedPerThread: 0,
      queuedTtlMs: 60_000,
      run: () => g.promise,
    });
    expect(queue.submit("t", "a")).toBe("started");
    expect(queue.submit("t", "b")).toBe("rejected");
    g.open();
    await queue.idle();
    expect(queue.submit("t", "c")).toBe("started");
    await queue.idle();
  });
});

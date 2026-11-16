/**
 * One turn at a time per conversation thread, with follow-ups queued behind it.
 *
 * Two messages in the same thread must not run as two concurrent turns: they
 * would race on the same history and could both act on one request. The naive
 * fix, refusing a message while its thread is busy, loses it — and a follow-up
 * in a live thread is often the most important message in it ("only post here,
 * nowhere else"). So a message that arrives while its thread is busy waits and
 * runs as soon as the turn ahead of it finishes.
 *
 * The queue is bounded: a burst is exactly when it fills, and an unbounded one
 * lets a loop build without limit. Beyond the bound `submit` reports
 * `"rejected"`, which is the only case the caller should say anything about.
 * A message that waited longer than `queuedTtlMs` is handed to `onStale`
 * instead of being answered late and out of context.
 *
 * In-process and deliberately not durable. A restart loses the in-flight turn
 * too, and replaying a follow-up without the turn it was queued behind would
 * answer it without its context.
 */

export type SubmitResult = "started" | "queued" | "rejected";

export interface ThreadTurnQueueOptions<T> {
  /** Runs one turn. Should not throw; a throw is routed to `onError`. */
  run: (item: T) => Promise<void>;
  /** Follow-ups that may wait behind one thread's turn. 0 means none. */
  maxQueuedPerThread: number;
  /** A follow-up older than this when its turn comes is not run. */
  queuedTtlMs: number;
  /** Called instead of `run` for a follow-up that waited too long. */
  onStale?: (item: T, waitedMs: number) => Promise<void>;
  onError?: (item: T, error: unknown) => void;
  now?: () => number;
}

interface Waiting<T> {
  item: T;
  queuedAt: number;
}

export const DEFAULT_QUEUED_TTL_MS = 600_000;

export class ThreadTurnQueue<T> {
  private readonly active = new Map<string, Promise<void>>();
  private readonly waiting = new Map<string, Array<Waiting<T>>>();
  private readonly now: () => number;

  constructor(private readonly options: ThreadTurnQueueOptions<T>) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Starts `item` now when its thread is idle, queues it when busy, or
   * rejects it when the thread's queue is full.
   */
  submit(threadKey: string, item: T): SubmitResult {
    if (!this.active.has(threadKey)) {
      this.active.set(threadKey, this.drain(threadKey, item));
      return "started";
    }
    const queue = this.waiting.get(threadKey) ?? [];
    if (queue.length >= Math.max(0, this.options.maxQueuedPerThread)) return "rejected";
    queue.push({ item, queuedAt: this.now() });
    this.waiting.set(threadKey, queue);
    return "queued";
  }

  isBusy(threadKey: string): boolean {
    return this.active.has(threadKey);
  }

  queuedCount(threadKey: string): number {
    return this.waiting.get(threadKey)?.length ?? 0;
  }

  /** Threads with a turn in flight. */
  activeCount(): number {
    return this.active.size;
  }

  /** Resolves when every thread is idle, including turns queued meanwhile. */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()]);
    }
  }

  private async drain(threadKey: string, first: T): Promise<void> {
    let next: { item: T } | undefined = { item: first };
    while (next) {
      const { item } = next;
      try {
        await this.options.run(item);
      } catch (error) {
        this.reportError(item, error);
      }
      next = await this.takeNext(threadKey);
    }
    // Synchronous with the empty check in takeNext, so a submit can never land
    // between "queue empty" and "thread idle" and be stranded.
    this.active.delete(threadKey);
  }

  private async takeNext(threadKey: string): Promise<{ item: T } | undefined> {
    for (;;) {
      const queue = this.waiting.get(threadKey);
      const head = queue?.shift();
      if (!queue || !head) {
        this.waiting.delete(threadKey);
        return undefined;
      }
      if (queue.length === 0) this.waiting.delete(threadKey);

      const waitedMs = this.now() - head.queuedAt;
      if (waitedMs <= this.options.queuedTtlMs) return { item: head.item };
      try {
        await this.options.onStale?.(head.item, waitedMs);
      } catch (error) {
        this.reportError(head.item, error);
      }
    }
  }

  private reportError(item: T, error: unknown): void {
    try {
      this.options.onError?.(item, error);
    } catch {
      // An error reporter that throws must not stop the thread draining.
    }
  }
}

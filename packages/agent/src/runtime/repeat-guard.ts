import { createHash } from "node:crypto";
import type { ToolResultContent } from "../tools/agent-tool";

/**
 * Detects a model that is stuck calling the same tool over and over.
 *
 * Decisions depend only on hashed tool names, arguments and results, never on
 * the model's wording, so the policy behaves the same however the model phrases
 * itself. It is deliberately conservative, because each false positive ends a
 * turn that was making progress:
 *
 * - Two different calls returning identical bytes are NOT treated as a loop.
 *   Writes commonly acknowledge with a constant body (`{"ok":true}`), so two
 *   distinct writes look identical by result; and two different in-flight jobs
 *   read as `in_progress` byte for byte. Neither is a stuck model.
 * - Re-running an identical read is allowed. Polling a job until it finishes is
 *   a legitimate reason to send the same arguments twice, and the answer may
 *   not have changed yet. Only a long streak of the same call returning the
 *   same result counts, and even then the turn is not aborted: the model is
 *   asked for a final answer from what it already has.
 * - An identical mutating call that already executed is not run a second time.
 *   Doing the same write twice is never what a retry intends, and the earlier
 *   result is handed back instead. A mutating call that failed may be retried.
 *
 * The iteration limit and the wall-clock deadline remain the backstop for any
 * spinning this policy lets through.
 */
export interface RepeatGuardOptions {
  /**
   * How many identical repeats (same tool, same arguments, same result) are
   * tolerated before the model is asked to stop calling tools. The first call
   * is not a repeat, so 4 allows five identical calls.
   */
  maxRepeats: number;
  /** Tools never counted as repeating, for reads that are expected to be polled. */
  exemptTools?: Iterable<string>;
}

export type BeforeCallDecision =
  | { action: "run" }
  | {
      action: "skip";
      /** What the model is told instead of a fresh result. */
      content: string;
      /** Set when the model has now been told this too many times. */
      forceFinal?: string;
    };

export type AfterCallDecision = { action: "continue" } | { action: "force_final"; reason: string };

/** Largest prior result kept to hand back for a skipped duplicate write. */
const MAX_REMEMBERED_CHARS = 4_000;

interface CallRecord {
  lastResultHash?: string;
  streak: number;
  executedWrite: boolean;
  rememberedResult?: string;
}

export class RepeatGuard {
  private readonly calls = new Map<string, CallRecord>();
  private readonly exempt: Set<string>;
  private skippedWrites = 0;

  constructor(private readonly options: RepeatGuardOptions) {
    this.exempt = new Set(options.exemptTools ?? []);
  }

  beforeCall(name: string, args: Record<string, unknown>, mutating: boolean): BeforeCallDecision {
    if (!mutating) return { action: "run" };
    const record = this.calls.get(callKey(name, args));
    if (!record?.executedWrite) return { action: "run" };

    this.skippedWrites += 1;
    const prior = record.rememberedResult ?? "(the earlier result was too large to keep)";
    const content =
      `Not run again: "${name}" already ran with these exact arguments in this turn and changed something. ` +
      `Running it again would repeat the change. Its earlier result was:\n${prior}`;
    if (this.skippedWrites > this.options.maxRepeats) {
      return {
        action: "skip",
        content,
        forceFinal: `"${name}" was requested again with identical arguments after it had already run.`,
      };
    }
    return { action: "skip", content };
  }

  afterCall(
    name: string,
    args: Record<string, unknown>,
    mutating: boolean,
    result: { content: ToolResultContent; isError?: boolean; executed: boolean },
  ): AfterCallDecision {
    const key = callKey(name, args);
    const record: CallRecord = this.calls.get(key) ?? { streak: 0, executedWrite: false };
    const resultHash = hashValue({ isError: result.isError === true, content: result.content });

    record.streak = record.lastResultHash === resultHash ? record.streak + 1 : 0;
    record.lastResultHash = resultHash;
    if (mutating && result.executed) {
      record.executedWrite = true;
      const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      record.rememberedResult = text.length <= MAX_REMEMBERED_CHARS ? text : undefined;
    }
    this.calls.set(key, record);

    if (record.streak >= this.options.maxRepeats && !this.exempt.has(name)) {
      return {
        action: "force_final",
        reason: `"${name}" was called ${record.streak + 1} times with the same arguments and returned the same result each time.`,
      };
    }
    return { action: "continue" };
  }
}

function callKey(name: string, args: Record<string, unknown>): string {
  return `${name}\u0000${hashValue(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** A content hash that ignores object key order. */
export function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

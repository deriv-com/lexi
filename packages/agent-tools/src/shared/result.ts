import type { GovernedOutcome, ToolResult } from "@lexi/agent";

/**
 * Result helpers shared by every module.
 *
 * Two rules every tool here follows, so they live in one place:
 * - A result never exceeds the caller's `maxResultChars`. A tool that overruns
 *   it is cut here, with a note saying how much was withheld, rather than
 *   being dropped whole by the loop.
 * - A mutating tool reports `executed: true` only after the write returned.
 *   Every other path, including a dry-run deployment, says nothing changed.
 */

/** Characters kept free for the truncation note itself. */
const NOTE_RESERVE = 200;

/** Cuts `text` to `maxChars`, appending a note that says what was withheld. */
export function truncateToBudget(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - NOTE_RESERVE);
  return (
    `${text.slice(0, keep)}\n\n` +
    `[Truncated: showing the first ${keep} of ${text.length} characters. ` +
    `Do not treat this as the complete result; narrow the request to see the rest.]`
  );
}

export function textResult(text: string, maxChars: number): ToolResult {
  return { content: truncateToBudget(text, maxChars) };
}

/** Pretty JSON, truncated to the budget. */
export function jsonResult(value: unknown, maxChars: number): ToolResult {
  return textResult(JSON.stringify(value, null, 2), maxChars);
}

/** A read that failed. No outcome: reads change nothing. */
export function readError(message: string): ToolResult {
  return { isError: true, content: message };
}

function outcome(executed: boolean, blocked: boolean, reason: string, auditId?: string): GovernedOutcome {
  return { authorized: true, executed, blocked, reason, ...(auditId ? { auditId } : {}) };
}

/** The write happened. */
export function executed(reason: string, auditId?: string): ToolResult {
  return { content: reason, outcome: outcome(true, false, reason, auditId) };
}

/**
 * The tool refused before writing anything: bad arguments, a guard, a target
 * outside the configured scope. `reason` should say that nothing changed.
 */
export function refused(reason: string): ToolResult {
  return { isError: true, content: reason, outcome: outcome(false, true, reason) };
}

/** The deployment's write switch is off or in dry-run, so nothing was sent. */
export function writesDisabled(action: string, gateReason: string): ToolResult {
  const reason =
    `Writes are disabled in this deployment (${gateReason}), so ${action} was not performed. ` +
    `Nothing was changed. Say so plainly; do not report it as done.`;
  return { content: reason, outcome: outcome(false, true, reason) };
}

/** The write was attempted and the provider rejected it. */
export function writeFailed(action: string, error: unknown): ToolResult {
  const reason = `${action} failed: ${redactProviderError(errorMessage(error))}. Nothing was changed.`;
  return { isError: true, content: reason, outcome: outcome(false, true, reason) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

/**
 * Strips credentials out of a provider error before it reaches a chat thread.
 * A thread is a wider audience than a log, and an HTTP client error can carry
 * the request URL or an echoed header.
 */
export function redactProviderError(message: string): string {
  const redacted = message
    .replace(/\b(ghp|ghs|gho|ghu|github_pat)_[A-Za-z0-9_]+/g, "$1_[REDACTED]")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]+/g, "xox?-[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(/\b(token|access_token|key|secret|password)=[^\s&"']+/gi, "$1=[REDACTED]");
  return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
}

/** Recognises the GitHub and Slack write gates' "would have done it" refusals. */
export function writeGateReason(error: unknown): string | null {
  if (error instanceof Error && error.name === "WriteGateBlockedError") {
    const reason = (error as Error & { reason?: unknown }).reason;
    return typeof reason === "string" && reason ? reason : "writes disabled";
  }
  return null;
}

/** Recognises a write gate reason that arrives as a Slack `{ ok: false, error }`. */
export function isWriteGateErrorCode(code: string | undefined): boolean {
  return code === "GOVERNED_DRY_RUN=true" || code === "GOVERNED_WRITES_ENABLED=false";
}

/**
 * Runs one write and turns every way it can end into an honest result.
 * `onSuccess` builds the success reason from what the provider returned.
 */
export async function governedWrite<T>(
  action: string,
  write: () => Promise<T>,
  onSuccess: (value: T) => ToolResult | Promise<ToolResult>,
): Promise<ToolResult> {
  let value: T;
  try {
    value = await write();
  } catch (error) {
    const gate = writeGateReason(error);
    if (gate) return writesDisabled(action, gate);
    return writeFailed(action, error);
  }
  return onSuccess(value);
}

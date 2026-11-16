/**
 * Argument readers. A schema's `required` list is a hint to the model, not a
 * guarantee about what arrives, so every tool reads its arguments through
 * these and treats anything malformed as absent.
 */

export function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

/** A positive safe integer, or undefined. A numeric string is not accepted. */
export function readPositiveInt(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A finite number clamped to [min, max], or the fallback. */
export function readBoundedInt(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function readBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Non-empty trimmed strings, deduplicated, in order. */
export function readStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function readEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[key];
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

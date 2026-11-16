/**
 * Optional per-request model choice keyed by intent class.
 *
 * This is a price decision, not a capability gate: every class must be
 * answerable on any configured model. A class absent from the map uses
 * `defaultModel`, and with neither set the client's own model is used.
 */
export interface ModelRouting {
  defaultModel?: string;
  byIntent?: Record<string, string>;
}

/** The model to request for this intent class, or `undefined` for the client default. */
export function resolveModelForIntent(routing: ModelRouting | undefined, intentClass?: string): string | undefined {
  if (!routing) return undefined;
  const pinned = intentClass ? routing.byIntent?.[intentClass]?.trim() : undefined;
  if (pinned) return pinned;
  const fallback = routing.defaultModel?.trim();
  return fallback ? fallback : undefined;
}

/**
 * The two SDKs disagree about who owns the API version segment of a URL.
 *
 * The Anthropic client appends `/v1/messages` by plain concatenation, so a base
 * URL that already ends in `/v1` produces `/v1/v1/messages` and a 404 on every
 * request. The OpenAI client appends only `/chat/completions`, so its base URL
 * must end in `/v1`. Gateways commonly document a single base URL for both, so
 * each client normalises the same configured value for its own transport rather
 * than asking operators to keep two variables in sync.
 */

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

/**
 * Removes a trailing `/v1` (and trailing slashes). Only a trailing segment is
 * removed: a path prefix such as `/anthropic` belongs to the gateway's routing.
 */
export function normalizeAnthropicBaseUrl(raw: string): string {
  return stripTrailingSlashes(raw.trim()).replace(/\/v1$/i, "");
}

/** Ensures a trailing `/v1`. An empty value stays empty, meaning "use the SDK default". */
export function normalizeOpenAiCompatBaseUrl(raw: string): string {
  const trimmed = stripTrailingSlashes(raw.trim());
  if (trimmed.length === 0) return "";
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

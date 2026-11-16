import { describe, expect, it } from "vitest";
import { normalizeAnthropicBaseUrl, normalizeOpenAiCompatBaseUrl } from "./base-url";

describe("base URL normalisation", () => {
  it.each([
    ["https://gateway.test/v1", "https://gateway.test"],
    ["https://gateway.test/v1/", "https://gateway.test"],
    ["https://gateway.test", "https://gateway.test"],
    ["https://gateway.test/anthropic", "https://gateway.test/anthropic"],
    ["https://gateway.test/v1beta", "https://gateway.test/v1beta"],
    ["", ""],
  ])("strips a trailing /v1 for the Anthropic SDK: %s", (raw, expected) => {
    expect(normalizeAnthropicBaseUrl(raw)).toBe(expected);
  });

  it.each([
    ["https://gateway.test", "https://gateway.test/v1"],
    ["https://gateway.test/", "https://gateway.test/v1"],
    ["https://gateway.test/v1", "https://gateway.test/v1"],
    ["https://gateway.test/V1/", "https://gateway.test/V1"],
    ["", ""],
  ])("ensures a trailing /v1 for the OpenAI SDK: %s", (raw, expected) => {
    expect(normalizeOpenAiCompatBaseUrl(raw)).toBe(expected);
  });
});

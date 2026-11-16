import { isAllowedFigmaMcpUrl } from "./mcp-client";

/** Figma-hosted MCP endpoint, the only one the client will send a token to. */
export const DEFAULT_FIGMA_MCP_URL = "https://mcp.figma.com/mcp";

/**
 * Figma settings, read from the environment. Every flag defaults to off: a
 * deployment that sets nothing never talks to Figma.
 */
export interface FigmaConfig {
  /** Master switch for the MCP client (reads and writes). */
  FIGMA_MCP_ENABLED: boolean;
  /** Switch for the design-read path (opening a design link). */
  FIGMA_DESIGN_CONTEXT_ENABLED: boolean;
  /** Must pass `isAllowedFigmaMcpUrl` (Figma-hosted HTTPS only). */
  FIGMA_MCP_URL: string;
  /** OAuth access token for the Figma account the MCP calls run as. Never logged. */
  FIGMA_OAUTH_ACCESS_TOKEN: string;
  /** Files no write may touch (comma- or whitespace-separated in the environment). */
  FIGMA_FORBIDDEN_FILE_KEYS: string[];
  /** Files outside the prototypes this process created that reads may open. */
  FIGMA_READ_ALLOWED_FILE_KEYS: string[];
}

const flag = (value: string | undefined): boolean => value === "true";
const list = (value: string | undefined): string[] =>
  [...new Set((value ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];

export class FigmaConfigError extends Error {}

export function loadFigmaConfig(env: Record<string, string | undefined> = process.env): FigmaConfig {
  const url = (env.FIGMA_MCP_URL ?? "").trim() || DEFAULT_FIGMA_MCP_URL;
  if (!isAllowedFigmaMcpUrl(url)) {
    throw new FigmaConfigError(`FIGMA_MCP_URL must be ${DEFAULT_FIGMA_MCP_URL} (Figma-hosted HTTPS only; never localhost)`);
  }
  return {
    FIGMA_MCP_ENABLED: flag(env.FIGMA_MCP_ENABLED),
    FIGMA_DESIGN_CONTEXT_ENABLED: flag(env.FIGMA_DESIGN_CONTEXT_ENABLED),
    FIGMA_MCP_URL: url,
    FIGMA_OAUTH_ACCESS_TOKEN: (env.FIGMA_OAUTH_ACCESS_TOKEN ?? "").trim(),
    FIGMA_FORBIDDEN_FILE_KEYS: list(env.FIGMA_FORBIDDEN_FILE_KEYS),
    FIGMA_READ_ALLOWED_FILE_KEYS: list(env.FIGMA_READ_ALLOWED_FILE_KEYS),
  };
}

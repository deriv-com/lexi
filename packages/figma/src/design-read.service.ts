/**
 * Figma design reader for links shared in chat.
 *
 * Opens a design link by:
 * 1. Parsing the URL (never fetching it — SSRF),
 * 2. Checking `FigmaReadGateway` (Lexi prototype OR allowlisted source),
 * 3. Calling Figma MCP `get_metadata` / `get_screenshot` / optional
 *    `get_design_context` with the extracted fileKey + nodeId only.
 *
 * Kill-switch: `FIGMA_DESIGN_CONTEXT_ENABLED` (the Figma READ path flag).
 * Token and MCP URL come from the same `FigmaConfig` the client uses.
 */

import type { FigmaConfig } from "./config";
import {
  FigmaMcpClient,
  isAllowedFigmaMcpUrl,
  normalizeFigmaNodeId,
  type FigmaMcpCallResult,
  type McpImageBytes,
} from "./mcp-client";
import { parseFigmaDesignLink } from "./design-link";
import { FigmaReadGateway } from "./read-gateway";

const MAX_METADATA_CHARS = 6_000;
const MAX_CONTEXT_CHARS = 8_000;

export interface FigmaDesignReadVision {
  mediaType: string;
  /** Raw base64 without a data-URL prefix. */
  data: string;
}

export interface FigmaDesignReadResult {
  ok: boolean;
  reason: string;
  fileKey?: string;
  nodeId?: string;
  vision?: FigmaDesignReadVision;
}

export interface FigmaDesignReadFigmaPort {
  getMetadata(args: { fileKey: string; nodeId?: string }): Promise<FigmaMcpCallResult>;
  getScreenshot(args: { fileKey: string; nodeId?: string }): Promise<FigmaMcpCallResult>;
  getDesignContext?(args: { fileKey: string; nodeId: string }): Promise<FigmaMcpCallResult>;
}

export interface FigmaDesignReadServiceDeps {
  figma: FigmaDesignReadFigmaPort;
  gateway: FigmaReadGateway;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n…(truncated)`;
}

function visionFromImages(images: McpImageBytes[] | undefined): FigmaDesignReadVision | undefined {
  const first = images?.[0];
  if (!first || first.bytes.byteLength === 0) return undefined;
  return {
    mediaType: first.mimeType,
    data: first.bytes.toString("base64"),
  };
}

export class FigmaDesignReadService {
  constructor(
    private readonly config: Pick<
      FigmaConfig,
      "FIGMA_DESIGN_CONTEXT_ENABLED" | "FIGMA_MCP_ENABLED" | "FIGMA_MCP_URL" | "FIGMA_OAUTH_ACCESS_TOKEN"
    >,
    private readonly deps: FigmaDesignReadServiceDeps,
  ) {}

  static create(
    config: FigmaConfig,
    deps: Omit<FigmaDesignReadServiceDeps, "figma"> & { figma?: FigmaDesignReadFigmaPort },
  ): FigmaDesignReadService {
    const figma =
      deps.figma ??
      new FigmaMcpClient({
        url: config.FIGMA_MCP_URL,
        accessToken: config.FIGMA_OAUTH_ACCESS_TOKEN,
      });
    return new FigmaDesignReadService(config, { ...deps, figma });
  }

  async view(input: { url: string }): Promise<FigmaDesignReadResult> {
    if (!this.config.FIGMA_DESIGN_CONTEXT_ENABLED) {
      return {
        ok: false,
        reason:
          "Figma design read is disabled (FIGMA_DESIGN_CONTEXT_ENABLED=false). No design was read.",
      };
    }
    if (!this.config.FIGMA_MCP_ENABLED || this.config.FIGMA_OAUTH_ACCESS_TOKEN.length === 0) {
      return {
        ok: false,
        reason: "Figma MCP is not configured for this deployment. No design was read.",
      };
    }
    if (!isAllowedFigmaMcpUrl(this.config.FIGMA_MCP_URL)) {
      return {
        ok: false,
        reason: "Figma MCP URL is not allowlisted. No design was read.",
      };
    }

    const parsed = parseFigmaDesignLink(input.url);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };

    const { fileKey, nodeId } = parsed.link;
    const allowed = await this.deps.gateway.assertReadable(fileKey);
    if (!allowed.ok) return { ok: false, reason: allowed.reason };

    const metaArgs = { fileKey, ...(nodeId ? { nodeId } : {}) };
    let metadata: FigmaMcpCallResult;
    let screenshot: FigmaMcpCallResult;
    try {
      [metadata, screenshot] = await Promise.all([
        this.deps.figma.getMetadata(metaArgs),
        this.deps.figma.getScreenshot(metaArgs),
      ]);
    } catch (error) {
      return {
        ok: false,
        reason: `Figma MCP read failed: ${error instanceof Error ? error.message : String(error)}. No design was read.`,
        fileKey,
        ...(nodeId ? { nodeId } : {}),
      };
    }

    if (!metadata.ok && !screenshot.ok) {
      return {
        ok: false,
        reason:
          `Figma refused the read for ${fileKey}` +
          (nodeId ? ` node ${nodeId}` : "") +
          `: ${metadata.text || screenshot.text || "unknown error"}. ` +
          "The Full-seat account may lack access, or the node id may be wrong.",
        fileKey,
        ...(nodeId ? { nodeId } : {}),
      };
    }

    let contextText = "";
    if (nodeId && this.deps.figma.getDesignContext) {
      try {
        const context = await this.deps.figma.getDesignContext({
          fileKey,
          nodeId: normalizeFigmaNodeId(nodeId),
        });
        if (context.ok && context.text.trim().length > 0) {
          contextText = clip(context.text, MAX_CONTEXT_CHARS);
        }
      } catch {
        // Metadata + screenshot are enough; context is best-effort.
      }
    }

    const vision = visionFromImages(screenshot.images);
    const parts = [
      `Read Figma ${parsed.link.kind} file \`${fileKey}\`` +
        (nodeId ? ` at node \`${nodeId}\`` : "") +
        ` (via ${allowed.via}).`,
      "The caller URL was parsed only — it was never HTTP-fetched.",
      vision
        ? "A screenshot is attached to this tool result — look at the pixels when describing the design."
        : screenshot.ok
          ? "Screenshot bytes were not available; use the metadata below."
          : `Screenshot failed: ${clip(screenshot.text, 400)}`,
      metadata.ok
        ? `Metadata:\n${clip(metadata.text, MAX_METADATA_CHARS)}`
        : `Metadata failed: ${clip(metadata.text, 400)}`,
      contextText ? `Design context:\n${contextText}` : "",
    ].filter(Boolean);

    return {
      ok: true,
      reason: parts.join("\n\n"),
      fileKey,
      ...(nodeId ? { nodeId } : {}),
      ...(vision ? { vision } : {}),
    };
  }
}

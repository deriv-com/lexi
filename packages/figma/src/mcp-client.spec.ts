import { describe, expect, it, vi } from "vitest";
import {
  FigmaMcpClient,
  figmaUploadFilename,
  isAllowedFigmaMcpUrl,
  isAllowedFigmaUploadUrl,
  isUnusableProtoStart,
  normalizeFigmaNodeId,
  parseFigmaFilesTarget,
  parseFigmaProjectId,
  parseMcpHttpBody,
  prototypeUrlFor,
  fileUrlFor,
} from "./mcp-client";
import { DEFAULT_FIGMA_MCP_URL, FigmaConfigError, loadFigmaConfig } from "./config";

/** Userinfo in a URL, assembled so secret scanners do not read the fixture as a credential. */
const USERINFO = ["someone", "not-a-secret"].join(":");

describe("isAllowedFigmaMcpUrl", () => {
  it("accepts only the Figma-hosted MCP endpoint", () => {
    expect(isAllowedFigmaMcpUrl("https://mcp.figma.com/mcp")).toBe(true);
    expect(isAllowedFigmaMcpUrl("https://mcp.figma.com/mcp/")).toBe(true);
  });

  it("refuses localhost, plain http, credentials, query strings and other hosts", () => {
    expect(isAllowedFigmaMcpUrl("http://127.0.0.1:3845/sse")).toBe(false);
    expect(isAllowedFigmaMcpUrl("http://mcp.figma.com/mcp")).toBe(false);
    expect(isAllowedFigmaMcpUrl(`https://${USERINFO}@mcp.figma.com/mcp`)).toBe(false);
    expect(isAllowedFigmaMcpUrl("https://mcp.figma.com/mcp?x=1")).toBe(false);
    expect(isAllowedFigmaMcpUrl("https://mcp.figma.com.evil.example/mcp")).toBe(false);
    expect(isAllowedFigmaMcpUrl("not a url")).toBe(false);
  });
});

describe("isAllowedFigmaUploadUrl", () => {
  it("accepts MCP upload slots and Figma upload paths only", () => {
    expect(isAllowedFigmaUploadUrl("https://mcp.figma.com/mcp/upload/abc123/submit")).toBe(true);
    expect(isAllowedFigmaUploadUrl("https://www.figma.com/uploads/abc")).toBe(true);
    expect(isAllowedFigmaUploadUrl("https://mcp.figma.com/mcp")).toBe(false);
    expect(isAllowedFigmaUploadUrl("https://evil.example/uploads/abc")).toBe(false);
  });
});

describe("parseMcpHttpBody", () => {
  it("reads plain JSON and SSE data lines", () => {
    expect(parseMcpHttpBody('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    expect(parseMcpHttpBody(sse)).toMatchObject({ id: 2, result: { ok: true } });
  });
});

describe("node ids and URLs", () => {
  it("normalises hyphenated node ids", () => {
    expect(normalizeFigmaNodeId("12-34")).toBe("12:34");
  });

  it("builds file and prototype URLs", () => {
    expect(fileUrlFor("AbC123")).toBe("https://www.figma.com/design/AbC123");
    expect(prototypeUrlFor("AbC123")).toBe("https://www.figma.com/proto/AbC123");
    const url = new URL(prototypeUrlFor("AbC123", "12:34"));
    expect(url.searchParams.get("node-id")).toBe("12-34");
    expect(url.searchParams.get("starting-point-node-id")).toBe("12:34");
  });

  it("never treats the page canvas as a prototype start", () => {
    expect(isUnusableProtoStart("0:1")).toBe(true);
    expect(isUnusableProtoStart("0-1")).toBe(true);
    expect(isUnusableProtoStart("12:34")).toBe(false);
  });

  it("strips path separators from upload file names", () => {
    expect(figmaUploadFilename("../../etc/passwd")).not.toMatch(/[/\\]/);
    expect(figmaUploadFilename("")).toBe("screen.png");
    expect(figmaUploadFilename("Home.jpg")).toBe("Home.jpg");
  });
});

describe("parseFigmaFilesTarget", () => {
  it("accepts folder and project URLs, team URLs and bare ids", () => {
    expect(parseFigmaFilesTarget("https://www.figma.com/files/123/folder/4567890")).toEqual({ kind: "project", id: "4567890" });
    expect(parseFigmaFilesTarget("https://www.figma.com/files/123/project/4567890?fuid=1")).toEqual({ kind: "project", id: "4567890" });
    expect(parseFigmaFilesTarget("https://www.figma.com/files/team/9876543")).toEqual({ kind: "team", id: "9876543" });
    expect(parseFigmaFilesTarget("4567890")).toEqual({ kind: "project", id: "4567890" });
    expect(parseFigmaFilesTarget("")).toBeUndefined();
    expect(parseFigmaProjectId("https://www.figma.com/files/team/9876543")).toBeUndefined();
  });
});

describe("FigmaMcpClient", () => {
  it("refuses to send a token to a non-Figma endpoint", async () => {
    const fetchImpl = vi.fn();
    const client = new FigmaMcpClient({ url: "https://evil.example/mcp", accessToken: "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getMetadata({ fileKey: "AbC123xyz" })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("loadFigmaConfig", () => {
  it("defaults every switch off and the URL to the Figma-hosted MCP", () => {
    const config = loadFigmaConfig({});
    expect(config.FIGMA_MCP_ENABLED).toBe(false);
    expect(config.FIGMA_DESIGN_CONTEXT_ENABLED).toBe(false);
    expect(config.FIGMA_MCP_URL).toBe(DEFAULT_FIGMA_MCP_URL);
    expect(config.FIGMA_FORBIDDEN_FILE_KEYS).toEqual([]);
  });

  it("parses lists and refuses a local MCP URL", () => {
    expect(loadFigmaConfig({ FIGMA_FORBIDDEN_FILE_KEYS: "A, B A" }).FIGMA_FORBIDDEN_FILE_KEYS).toEqual(["A", "B"]);
    expect(() => loadFigmaConfig({ FIGMA_MCP_URL: "http://127.0.0.1:3845/sse" })).toThrow(FigmaConfigError);
  });
});

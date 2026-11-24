/**
 * HTTP JSON-RPC client for Figma's remote MCP (`https://mcp.figma.com/mcp`).
 *
 * This is a reader/writer of MCP *messages*, not an orchestrator: it does not
 * decide which frames to draw or what to read — its callers do.
 *
 * Auth is a Bearer token the caller already has. This file never logs it.
 * Transport failures fail closed: they throw or return an error result, they
 * do not retry with a weaker auth.
 */

export interface FigmaMcpCallResult {
  ok: boolean;
  text: string;
  raw: unknown;
  /** Populated by `getScreenshot` after inline bytes or an allowlisted asset fetch. */
  images?: McpImageBytes[];
}

export interface FigmaMcpClientOptions {
  url: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string;
  error: { code: number; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcSuccess(value: unknown): value is JsonRpcSuccess {
  return isRecord(value) && value.jsonrpc === "2.0" && "result" in value;
}

/**
 * MCP streamable HTTP may return JSON or an SSE stream of `data: {json}` lines.
 * Both are ordinary here; treating only JSON would make a working Figma server
 * look like an empty result.
 */
export function parseMcpHttpBody(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as unknown;
  }
  const payloads: unknown[] = [];
  for (const line of trimmed.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("data:")) continue;
    const rest = trimmedLine.slice("data:".length);
    if (rest.length === 0) continue;
    const data = rest.trim();
    if (data === "[DONE]") continue;
    payloads.push(JSON.parse(data) as unknown);
  }
  if (payloads.length === 0) {
    throw new Error("MCP response was neither JSON nor SSE data frames");
  }
  return payloads[payloads.length - 1];
}

function rpcErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const message = value.error.message;
  return typeof message === "string" ? message : undefined;
}

function toolText(result: unknown): string {
  if (!isRecord(result)) return JSON.stringify(result);
  const content = result.content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  const parts: string[] = [];
  for (const item of content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n") || JSON.stringify(result);
}

const ALLOWED_SCREENSHOT_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** Same raw cap as the vision describer — Anthropic rejects ~5MB encoded. */
const MAX_SCREENSHOT_RAW_BYTES = 3.75 * 1024 * 1024;

export interface McpImageBytes {
  mimeType: string;
  /** Raw bytes, never a data-URL prefix. */
  bytes: Buffer;
}

function normalizeScreenshotMime(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase().split(";")[0]?.trim() ?? "";
  if (lower === "image/jpg") return "image/jpeg";
  return ALLOWED_SCREENSHOT_MIME.has(lower) ? lower : undefined;
}

function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function decodeScreenshotBase64(data: string): Buffer | undefined {
  const stripped = data.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").replace(/\s/g, "");
  if (stripped.length < 32) return undefined;
  if (/^https?:\/\//i.test(stripped)) return undefined;
  try {
    const bytes = Buffer.from(stripped, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCREENSHOT_RAW_BYTES) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Pull inline image bytes out of an MCP `tools/call` result. `toolText` drops
 * non-text content, so screenshots must be read from `raw`. Only allowlisted
 * image MIME types and inline base64 (or MCP `resource.blob`) are accepted here.
 * Figma's remote MCP usually returns an asset URL instead — see
 * `extractFigmaMcpAssetUrls`.
 */
export function extractMcpImages(raw: unknown, depth = 0): McpImageBytes[] {
  if (depth > 6 || raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => extractMcpImages(item, depth + 1));
  }
  if (!isRecord(raw)) return [];

  const found: McpImageBytes[] = [];
  const type = typeof raw.type === "string" ? raw.type : "";
  const mimeHint =
    (typeof raw.mimeType === "string" ? raw.mimeType : undefined) ??
    (typeof raw.media_type === "string" ? raw.media_type : undefined) ??
    (isRecord(raw.source) && typeof raw.source.media_type === "string" ? raw.source.media_type : undefined) ??
    (isRecord(raw.resource) && typeof raw.resource.mimeType === "string" ? raw.resource.mimeType : undefined);
  const dataHint =
    (typeof raw.data === "string" ? raw.data : undefined) ??
    (isRecord(raw.source) && typeof raw.source.data === "string" ? raw.source.data : undefined) ??
    (isRecord(raw.resource) && typeof raw.resource.blob === "string" ? raw.resource.blob : undefined);

  if (type === "image" || (typeof mimeHint === "string" && mimeHint.toLowerCase().startsWith("image/"))) {
    const mime = normalizeScreenshotMime(mimeHint) ?? (type === "image" ? "image/png" : undefined);
    const bytes = typeof dataHint === "string" ? decodeScreenshotBase64(dataHint) : undefined;
    if (mime && bytes) found.push({ mimeType: mime, bytes });
  }

  if ("content" in raw) found.push(...extractMcpImages(raw.content, depth + 1));
  if ("result" in raw) found.push(...extractMcpImages(raw.result, depth + 1));
  return found;
}

/**
 * Figma's remote `get_screenshot` returns a short-lived asset URL, not
 * inline base64:
 * `https://www.figma.com/api/mcp/asset/<uuid>.png`
 *
 * Only that host + path shape is accepted (SSRF). Query, userinfo, and
 * other hosts are refused.
 */
const FIGMA_MCP_ASSET_PATH =
  /^\/api\/mcp\/asset\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp)$/i;

export interface FigmaUploadSlot {
  url: string;
  nodeId?: string;
}

export interface FigmaUploadResult extends FigmaMcpCallResult {
  nodeIds: string[];
  placed: number;
}

/**
 * POST target for `upload_assets`. Two shapes are live:
 * - `https://mcp.figma.com/mcp/upload/<id>/submit` (`submitUrl` from the
 *   remote MCP; query such as `scaleMode` is allowed)
 * - `https://www.figma.com|api.figma.com` `/api/mcp/` or `/uploads/`
 *
 * The JSON-RPC endpoint `https://mcp.figma.com/mcp` is **not** an upload
 * target — posting PNG bytes there would hit the MCP server, not a slot.
 * Userinfo is refused (SSRF).
 */
const FIGMA_MCP_SUBMIT_PATH = /^\/mcp\/upload\/[A-Za-z0-9._~-]+\/submit$/;
const FIGMA_HOST_UPLOAD_RE =
  /https:\/\/(?:www|api)\.figma\.com\/(?:api\/mcp|uploads)\/[A-Za-z0-9._/-]+(?:\?[A-Za-z0-9._/=&%-]*)?/g;
const FIGMA_MCP_SUBMIT_RE =
  /https:\/\/mcp\.figma\.com\/mcp\/upload\/[A-Za-z0-9._~-]+\/submit(?:\?[A-Za-z0-9._~\-/=&%]*)?/g;

export function isAllowedFigmaUploadUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.hostname === "mcp.figma.com") return FIGMA_MCP_SUBMIT_PATH.test(parsed.pathname);
  if (parsed.hostname !== "www.figma.com" && parsed.hostname !== "api.figma.com") return false;
  return parsed.pathname.startsWith("/api/mcp/") || parsed.pathname.startsWith("/uploads/");
}

/** Layer name Figma takes from multipart `file`. Path separators stripped. */
export function figmaUploadFilename(label?: string): string {
  const stem = (label ?? "screen")
    .replace(/[/\\]/g, " ")
    .replace(/[^\w .·-]/g, "")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const base = stem.length > 0 ? stem : "screen";
  return /\.(png|jpe?g|webp|svg)$/i.test(base) ? base : `${base}.png`;
}

export function extractFigmaUploadSlots(text: string, raw?: unknown): FigmaUploadSlot[] {
  const slots: FigmaUploadSlot[] = [];
  const seen = new Set<string>();
  const add = (url: string, nodeId?: string) => {
    if (!isAllowedFigmaUploadUrl(url) || seen.has(url)) return;
    seen.add(url);
    slots.push({ url, ...(nodeId && /^\d+[:-]\d+$/.test(nodeId) ? { nodeId: nodeId.replace("-", ":") } : {}) });
  };
  collectUploadSlots(raw, add, 0);
  for (const match of text.match(FIGMA_HOST_UPLOAD_RE) ?? []) add(match);
  for (const match of text.match(FIGMA_MCP_SUBMIT_RE) ?? []) add(match);
  return slots;
}

function collectUploadSlots(
  raw: unknown,
  add: (url: string, nodeId?: string) => void,
  depth: number,
): void {
  if (depth > 6 || raw == null) return;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && depth < 6) {
      try {
        collectUploadSlots(JSON.parse(trimmed) as unknown, add, depth + 1);
      } catch {
        // not JSON — fall through to URL scan
      }
    }
    for (const match of raw.match(FIGMA_HOST_UPLOAD_RE) ?? []) add(match);
    for (const match of raw.match(FIGMA_MCP_SUBMIT_RE) ?? []) add(match);
    return;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) collectUploadSlots(item, add, depth + 1);
    return;
  }
  if (!isRecord(raw)) return;
  const url =
    (typeof raw.submitUrl === "string" ? raw.submitUrl : undefined) ??
    (typeof raw.submit_url === "string" ? raw.submit_url : undefined) ??
    (typeof raw.url === "string" ? raw.url : undefined) ??
    (typeof raw.uploadUrl === "string" ? raw.uploadUrl : undefined) ??
    (typeof raw.upload_url === "string" ? raw.upload_url : undefined);
  const nodeId =
    (typeof raw.nodeId === "string" ? raw.nodeId : undefined) ??
    (typeof raw.node_id === "string" ? raw.node_id : undefined);
  if (url) add(url, nodeId);
  for (const value of Object.values(raw)) collectUploadSlots(value, add, depth + 1);
}

function extractStartingNodeIds(text: string): string[] {
  const ids: string[] = [];
  const re = /"(?:createdNodeIds|nodeId|node_id)"\s*:\s*(?:\[\s*"([^"]+)"|"([^"]+)")/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const id = (match[1] ?? match[2] ?? "").replace("-", ":");
    if (/^\d+:\d+$/.test(id)) ids.push(id);
  }
  return ids;
}

export function isAllowedFigmaMcpAssetUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== "www.figma.com") return false;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  return FIGMA_MCP_ASSET_PATH.test(parsed.pathname);
}

const ASSET_URL_IN_TEXT =
  /https:\/\/www\.figma\.com\/api\/mcp\/asset\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|webp)/gi;

export function extractFigmaMcpAssetUrls(raw: unknown, text?: string, depth = 0): string[] {
  const found = new Set<string>();
  const add = (candidate: string) => {
    if (found.size >= 8) return;
    if (isAllowedFigmaMcpAssetUrl(candidate)) found.add(candidate.trim());
  };
  if (text) {
    for (const match of text.match(ASSET_URL_IN_TEXT) ?? []) add(match);
  }
  collectAssetUrls(raw, add, depth);
  return [...found];
}

function collectAssetUrls(raw: unknown, add: (url: string) => void, depth: number): void {
  if (depth > 6 || raw == null) return;
  if (typeof raw === "string") {
    for (const match of raw.match(ASSET_URL_IN_TEXT) ?? []) add(match);
    return;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) collectAssetUrls(item, add, depth + 1);
    return;
  }
  if (!isRecord(raw)) return;
  for (const key of ["image_url", "uri", "url"] as const) {
    const value = raw[key];
    if (typeof value === "string") add(value);
  }
  if (typeof raw.text === "string") collectAssetUrls(raw.text, add, depth + 1);
  if ("content" in raw) collectAssetUrls(raw.content, add, depth + 1);
  if ("result" in raw) collectAssetUrls(raw.result, add, depth + 1);
}

export interface FigmaJourneyFrame {
  name: string;
  nodeId: string;
}

/**
 * Journey phones from page metadata XML. Page listings and "Revision notes"
 * stickies are not frames. Caps at 16, matching `sanitizeJourneyStates`.
 */
export function extractJourneyFrames(text: string): FigmaJourneyFrame[] {
  if (looksLikePageListing(text)) return [];
  const frames: FigmaJourneyFrame[] = [];
  const seen = new Set<string>();
  const tag = /<frame\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(text))) {
    const attrs = match[1] ?? "";
    const name = /(?:^|\s)name=["']([^"']+)["']/i.exec(attrs)?.[1]?.trim() ?? "";
    const id = /(?:^|\s)(?:id|node-id|nodeId)=["'](\d+[:-]\d+)["']/i.exec(attrs)?.[1];
    if (!id || isUnusableProtoStart(id, text)) continue;
    if (!name || /^revision notes$/i.test(name) || /^page\s+\d+$/i.test(name)) continue;
    const nodeId = normalizeFigmaNodeId(id);
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    frames.push({ name, nodeId });
    if (frames.length >= 16) break;
  }
  return frames;
}

/** Start frame first, then an even sample, at most `max` phones. */
export function pickScreenshotFrames(
  frames: FigmaJourneyFrame[],
  startNodeId: string | undefined,
  max = 4,
): FigmaJourneyFrame[] {
  if (frames.length === 0 || max <= 0) return [];
  const startNorm = startNodeId ? normalizeFigmaNodeId(startNodeId) : undefined;
  const start = startNorm ? frames.find((frame) => frame.nodeId === startNorm) : frames[0];
  const rest = start ? frames.filter((frame) => frame.nodeId !== start.nodeId) : frames;
  const picked: FigmaJourneyFrame[] = start ? [start] : [];
  const slots = max - picked.length;
  if (slots <= 0 || rest.length === 0) return picked.slice(0, max);
  if (rest.length <= slots) return [...picked, ...rest];
  const seen = new Set(picked.map((frame) => frame.nodeId));
  for (let i = 0; i < slots; i += 1) {
    const idx = slots === 1 ? 0 : Math.round((i * (rest.length - 1)) / (slots - 1));
    const next = rest[idx];
    if (!next || seen.has(next.nodeId)) continue;
    seen.add(next.nodeId);
    picked.push(next);
  }
  return picked;
}

export class FigmaMcpClient {
  private nextId = 1;
  private initialized = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FigmaMcpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async whoami(): Promise<FigmaMcpCallResult> {
    return this.callTool("whoami", {});
  }

  async createDesignFile(
    fileName: string,
    planKey: string,
    projectId?: string,
  ): Promise<FigmaMcpCallResult> {
    if (!isFigmaPlanKey(planKey)) {
      return { ok: false, text: "planKey is not a team:: or organization:: key", raw: {} };
    }
    const folder = parseFigmaProjectId(projectId);
    return this.callTool("create_new_file", {
      fileName,
      planKey,
      editorType: "design",
      ...(folder ? { projectId: folder } : {}),
    });
  }

  /**
   * REST lookup of a team folder for `create_new_file`. Prefers
   * `GET /v2/teams/:id/folders` (current); falls back to deprecated
   * `GET /v1/teams/:id/projects`. Allowlisted host/path only.
   */
  async resolveTeamProjectFolder(
    teamId: string,
  ): Promise<{ ok: true; projectId: string; name: string } | { ok: false; reason: string }> {
    const foldersUrl = figmaTeamFoldersUrl(teamId);
    const projectsUrl = figmaTeamProjectsUrl(teamId);
    if (!foldersUrl || !projectsUrl) {
      return { ok: false, reason: "Figma team id is not a valid numeric id. No Figma file was created." };
    }
    const lookups: Array<{ url: string; label: string }> = [
      { url: foldersUrl, label: "team folders" },
      { url: projectsUrl, label: "team projects" },
    ];
    let lastStatus: number | undefined;
    let lastLabel = "team folders";
    for (const lookup of lookups) {
      if (!isAllowedFigmaTeamLookupUrl(lookup.url)) continue;
      let raw: unknown;
      try {
        const response = await this.fetchImpl(lookup.url, {
          method: "GET",
          headers: {
            authorization: `Bearer ${this.options.accessToken}`,
            accept: "application/json",
          },
        });
        if (!response.ok) {
          lastStatus = response.status;
          lastLabel = lookup.label;
          continue;
        }
        raw = (await response.json()) as unknown;
      } catch (error) {
        return {
          ok: false,
          reason: `Figma ${lookup.label} lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const projects = parseFigmaTeamProjects(raw);
      const picked = pickLexiTeamProject(projects);
      if (picked) return { ok: true, projectId: picked.id, name: picked.name };
      const names = projects.map((project) => project.name).filter((name) => name.length > 0).slice(0, 20);
      return {
        ok: false,
        reason:
          names.length > 0
            ? `FIGMA_PROJECT_ID is a team URL with several folders (${names.join(", ")}). Open the Lexi designs folder and set FIGMA_PROJECT_ID to its figma.com/files/.../project/<id> URL. No Figma file was created.`
            : "FIGMA_PROJECT_ID is a team URL with no project folders. Create a team project named Lexi designs, or set FIGMA_PROJECT_ID to a /project/<id> URL. No Figma file was created.",
      };
    }
    return {
      ok: false,
      reason: `Figma ${lastLabel} HTTP ${lastStatus ?? "unknown"}. No Figma file was created.`,
    };
  }

  async useFigma(arguments_: {
    fileKey: string;
    code: string;
    description: string;
  }): Promise<FigmaMcpCallResult> {
    return this.callTool("use_figma", {
      fileKey: arguments_.fileKey,
      code: arguments_.code,
      description: arguments_.description,
      skillNames: "figma-use,figma-generate-design",
    });
  }

  async getLibraries(fileKey: string): Promise<FigmaMcpCallResult> {
    return this.callTool("get_libraries", { fileKey });
  }

  async searchDesignSystem(
    query: string,
    fileKey?: string,
    includeLibraryKeys?: string[],
  ): Promise<FigmaMcpCallResult> {
    return this.callTool("search_design_system", {
      query,
      ...(fileKey ? { fileKey } : {}),
      ...(includeLibraryKeys && includeLibraryKeys.length > 0 ? { includeLibraryKeys } : {}),
      includeComponents: true,
    });
  }

  async getMetadata(args: { fileKey: string; nodeId?: string }): Promise<FigmaMcpCallResult> {
    return this.callTool("get_metadata", {
      fileKey: args.fileKey,
      ...(args.nodeId ? { nodeId: args.nodeId } : {}),
    });
  }

  /**
   * Structured design context for a node (the design-read path) — the
   * READ half of the design bridge, mirroring `getMetadata`. Read-only: no
   * `FigmaMutationGateway` involvement, callable on any file the token can
   * see, including files Lexi did not create.
   */
  async getDesignContext(args: { fileKey: string; nodeId: string }): Promise<FigmaMcpCallResult> {
    return this.callTool("get_design_context", {
      fileKey: args.fileKey,
      nodeId: args.nodeId,
      // Logging metadata the remote server expects; "unknown" is the honest
      // value — the consumer is a build brief, not a live client framework.
      clientFrameworks: "unknown",
      clientLanguages: "unknown",
    });
  }

  async getScreenshot(args: { fileKey: string; nodeId?: string }): Promise<FigmaMcpCallResult> {
    const result = await this.callTool("get_screenshot", {
      fileKey: args.fileKey,
      ...(args.nodeId ? { nodeId: args.nodeId } : {}),
    });
    const inline = extractMcpImages(result.raw);
    if (inline.length > 0) return { ...result, images: inline };
    const urls = extractFigmaMcpAssetUrls(result.raw, result.text);
    const images = await this.downloadFigmaMcpAssets(urls);
    return { ...result, images };
  }

  /**
   * POST PNG/SVG bytes to Figma MCP `upload_assets`. Upload URLs come from
   * Figma (`submitUrl` on mcp.figma.com, or a www/api.figma.com slot) and
   * must pass `isAllowedFigmaUploadUrl` before we POST. Multipart `file`
   * is required so Figma names the layer from the filename. If one tool
   * call returns fewer slots than assets, remaining assets get their own
   * `upload_assets` call — never POST leftover bytes at the JSON-RPC URL.
   */
  async uploadAssets(args: {
    fileKey: string;
    assets: Array<{ bytes: Buffer; mimeType: string; nodeId?: string; filename?: string }>;
  }): Promise<FigmaUploadResult> {
    const assets = args.assets.slice(0, 32);
    if (assets.length === 0) {
      return { ok: false, text: "no assets to upload", raw: {}, nodeIds: [], placed: 0 };
    }
    const nodeIds: string[] = [];
    let placed = 0;
    let lastText = "";
    let lastRaw: unknown = {};
    let index = 0;
    while (index < assets.length) {
      const remaining = assets.slice(index);
      const single = remaining.length === 1 ? remaining[0] : undefined;
      const issued = await this.callTool("upload_assets", {
        fileKey: args.fileKey,
        count: remaining.length,
        scaleMode: "FIT",
        ...(single?.nodeId ? { nodeId: single.nodeId } : {}),
      });
      lastText = issued.text;
      lastRaw = issued.raw;
      if (!issued.ok) {
        return { ok: false, text: issued.text, raw: issued.raw, nodeIds, placed };
      }
      const slots = extractFigmaUploadSlots(issued.text, issued.raw);
      if (slots.length === 0) {
        return {
          ok: false,
          text: "Figma upload_assets returned no allowlisted upload URL",
          raw: issued.raw,
          nodeIds,
          placed,
        };
      }
      const batch = Math.min(slots.length, remaining.length);
      for (let i = 0; i < batch; i += 1) {
        const slot = slots[i]!;
        const asset = remaining[i]!;
        if (!isAllowedFigmaUploadUrl(slot.url)) {
          return {
            ok: false,
            text: "Figma upload_assets returned no allowlisted upload URL",
            raw: issued.raw,
            nodeIds,
            placed,
          };
        }
        const posted = await this.postUploadSlot(slot.url, asset);
        if (!posted.ok) {
          return {
            ok: false,
            text: `Figma asset upload HTTP ${posted.status}`,
            raw: issued.raw,
            nodeIds,
            placed,
          };
        }
        placed += 1;
        index += 1;
        if (slot.nodeId) nodeIds.push(slot.nodeId);
      }
    }
    const fromText = extractStartingNodeIds(lastText);
    return {
      ok: placed === assets.length,
      text: lastText,
      raw: lastRaw,
      nodeIds: nodeIds.length > 0 ? nodeIds : fromText,
      placed,
    };
  }

  /**
   * Multipart POST to an allowlisted submit/upload URL. Do not set
   * Content-Type — fetch must attach the multipart boundary. Filename
   * becomes the Figma layer name.
   */
  private async postUploadSlot(
    url: string,
    asset: { bytes: Buffer; mimeType: string; filename?: string },
  ): Promise<Response> {
    const form = new FormData();
    const mime = asset.mimeType.trim() || "image/png";
    form.append("file", new Blob([new Uint8Array(asset.bytes)], { type: mime }), figmaUploadFilename(asset.filename));
    return this.fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.accessToken}` },
      body: form,
    });
  }

  /**
   * GET a Figma MCP asset URL. The URL must already have passed
   * `isAllowedFigmaMcpAssetUrl`. Redirects are followed by fetch; the first
   * hop is the only one we construct, and it is allowlisted.
   */
  private async downloadFigmaMcpAssets(urls: string[]): Promise<McpImageBytes[]> {
    const images: McpImageBytes[] = [];
    for (const url of urls) {
      if (!isAllowedFigmaMcpAssetUrl(url)) continue;
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            authorization: `Bearer ${this.options.accessToken}`,
            accept: "image/png,image/jpeg,image/webp,application/octet-stream",
          },
        });
        if (!response.ok) continue;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength === 0 || buffer.byteLength > MAX_SCREENSHOT_RAW_BYTES) continue;
        const mime =
          sniffImageMime(buffer) ??
          normalizeScreenshotMime(response.headers.get("content-type") ?? undefined);
        if (!mime) continue;
        images.push({ mimeType: mime, bytes: buffer });
      } catch {
        continue;
      }
    }
    return images;
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<FigmaMcpCallResult> {
    await this.ensureInitialized();
    const response = await this.rpc("tools/call", { name, arguments: arguments_ });
    const error = rpcErrorMessage(response);
    if (error) return { ok: false, text: error, raw: response };
    const result = isJsonRpcSuccess(response) ? response.result : response;
    const isError = isRecord(result) && result.isError === true;
    return { ok: !isError, text: toolText(result), raw: result };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const response = await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lexi", version: "0.0.0" },
    });
    const error = rpcErrorMessage(response);
    if (error) throw new Error(`Figma MCP initialize failed: ${error}`);
    await this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const body = await this.post({ jsonrpc: "2.0", id, method, params });
    return parseMcpHttpBody(body);
  }

  private async post(payload: Record<string, unknown>): Promise<string> {
    if (!isAllowedFigmaMcpUrl(this.options.url)) {
      throw new Error("Figma MCP URL is not the Figma-hosted endpoint; the token was not sent.");
    }
    const response = await this.fetchImpl(this.options.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      throw new Error(
        response.status === 413
          ? `Figma MCP HTTP 413 (request ${bytes} bytes; use_figma ceiling is 20KB)`
          : `Figma MCP HTTP ${response.status}`,
      );
    }
    return text;
  }
}

export function extractFigmaFileKey(text: string, raw?: unknown): string | undefined {
  const fromUrl = /figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/.exec(text);
  if (fromUrl?.[1]) return fromUrl[1];
  const fromJson = /"file_key"\s*:\s*"([A-Za-z0-9]{22,128})"/.exec(text);
  if (fromJson?.[1]) return fromJson[1];
  if (isRecord(raw) && typeof raw.file_key === "string" && /^[A-Za-z0-9]{22,128}$/.test(raw.file_key)) {
    return raw.file_key;
  }
  return undefined;
}

export interface FigmaPlan {
  name: string;
  seat: string;
  key: string;
}

const FIGMA_PLAN_KEY = /^(team|organization)::\d+$/;

export function isFigmaPlanKey(value: string): boolean {
  return FIGMA_PLAN_KEY.test(value);
}

function asFigmaPlan(value: unknown): FigmaPlan | null {
  if (!isRecord(value)) return null;
  const key = typeof value.key === "string" ? value.key : "";
  if (!isFigmaPlanKey(key)) return null;
  return {
    key,
    name: typeof value.name === "string" && value.name.length > 0 ? value.name : key,
    seat: typeof value.seat === "string" ? value.seat : "",
  };
}

function plansFromUnknown(value: unknown): FigmaPlan[] {
  if (Array.isArray(value)) {
    return value.map(asFigmaPlan).filter((plan): plan is FigmaPlan => plan !== null);
  }
  if (isRecord(value) && Array.isArray(value.plans)) return plansFromUnknown(value.plans);
  return [];
}

/** Plans from `whoami` JSON or from a stringified payload in `text`. */
export function parseFigmaPlans(text: string, raw?: unknown): FigmaPlan[] {
  const fromRaw = plansFromUnknown(raw);
  if (fromRaw.length > 0) return fromRaw;
  try {
    const parsed = JSON.parse(text) as unknown;
    const fromText = plansFromUnknown(parsed);
    if (fromText.length > 0) return fromText;
  } catch {
    // whoami may be prose wrapping a JSON object
  }
  const embedded = embeddedPlansObject(text);
  if (embedded) {
    try {
      const fromEmbedded = plansFromUnknown(JSON.parse(embedded));
      if (fromEmbedded.length > 0) return fromEmbedded;
    } catch {
      // fall through
    }
  }
  return [];
}

/**
 * One Full-seat `team::` / `organization::` key, or a configured key that
 * matches a Full plan on this account. Multiple Full plans without a
 * preferred key fail closed — the pod cannot pick a team in a browser.
 */
export function pickWritablePlanKey(
  plans: FigmaPlan[],
  preferred?: string,
): { ok: true; planKey: string } | { ok: false; reason: string } {
  const preferredKey = preferred?.trim() ?? "";
  if (preferredKey.length > 0) {
    if (!isFigmaPlanKey(preferredKey)) {
      return {
        ok: false,
        reason: "Preferred Figma planKey is not a team:: or organization:: key. No Figma file was created.",
      };
    }
    const match = plans.find((plan) => plan.key === preferredKey);
    if (!match) {
      return {
        ok: false,
        reason: "Preferred Figma planKey is not one of this account's plans. No Figma file was created.",
      };
    }
    if (match.seat.toLowerCase() !== "full") {
      return {
        ok: false,
        reason: `Figma plan ${match.name} is not a Full seat (write requires Full). No Figma file was created.`,
      };
    }
    return { ok: true, planKey: match.key };
  }
  const writable = plans.filter((plan) => plan.seat.toLowerCase() === "full");
  if (writable.length === 1) return { ok: true, planKey: writable[0]!.key };
  if (writable.length === 0) {
    return {
      ok: false,
      reason: "Figma account is not a Full seat (write requires Full). No Figma file was created or updated.",
    };
  }
  const names = writable.map((plan) => plan.name).join(", ");
  return {
    ok: false,
    reason: `Figma account has more than one Full plan (${names}). Set a single planKey. No Figma file was created.`,
  };
}

/**
 * Shareable prototype URL in the Home shape. `startingNodeId` must be a real
 * frame id from the `use_figma` plugin return or page metadata — never a
 * canvas/page (`0:1`). Without it this is only the file-key path, not a
 * starting-point proto.
 */
export function prototypeUrlFor(fileKey: string, startingNodeId?: string): string {
  const base = `https://www.figma.com/proto/${fileKey}`;
  if (!startingNodeId) return base;
  const hyphen = startingNodeId.replace(/:/g, "-");
  const colon = startingNodeId.replace(/-/g, ":");
  const params = new URLSearchParams({
    "node-id": hyphen,
    scaling: "scale-down",
    "content-scaling": "fixed",
    "starting-point-node-id": colon,
  });
  return `${base}?${params.toString()}`;
}

/** Canonical `123:456` form. Proto query params hyphenate this separately. */
export function normalizeFigmaNodeId(id: string): string {
  return id.replace(/-/g, ":");
}

/**
 * Page/canvas ids are not prototype starting points. New files list
 * `0:1: Page 1`; opening that as `node-id=0-1` is a page, not a journey frame.
 * Never treat `0:1` as a prototype start.
 */
export function isUnusableProtoStart(id: string, context?: string): boolean {
  const nodeId = normalizeFigmaNodeId(id);
  if (nodeId === "0:1") return true;
  if (context && looksLikePageListing(context)) return true;
  if (context && new RegExp(`${nodeId.replace(":", "[:\\-]")}\\s*:\\s*(?:Page|Cover)\\b`, "i").test(context)) {
    return true;
  }
  return false;
}

function isSpaceChar(ch: string | undefined): boolean {
  return ch !== undefined && ch.trim() === "";
}

/** A `12:34` / `12-34` id starting at `index`, not a slice of a longer digit run. */
function readNodeIdAt(text: string, index: number): { id: string; end: number } | null {
  if (index > 0) {
    const prev = text[index - 1]!;
    if (prev >= "0" && prev <= "9") return null;
  }
  let i = index;
  if (i >= text.length || text[i]! < "0" || text[i]! > "9") return null;
  const start = i;
  while (i < text.length && text[i]! >= "0" && text[i]! <= "9") i += 1;
  if (text[i] !== ":" && text[i] !== "-") return null;
  i += 1;
  if (i >= text.length || text[i]! < "0" || text[i]! > "9") return null;
  while (i < text.length && text[i]! >= "0" && text[i]! <= "9") i += 1;
  return { id: text.slice(start, i), end: i };
}

function findNodeId(text: string, from = 0): { id: string; start: number } | null {
  for (let i = from; i < text.length; i += 1) {
    const found = readNodeIdAt(text, i);
    if (found) return { id: found.id, start: i };
  }
  return null;
}

function pageListingIdOnLine(line: string): string | null {
  let i = 0;
  while (isSpaceChar(line[i])) i += 1;
  if (line[i] !== "-") return null;
  i += 1;
  while (isSpaceChar(line[i])) i += 1;
  const id = readNodeIdAt(line, i);
  if (!id) return null;
  let j = id.end;
  while (isSpaceChar(line[j])) j += 1;
  return line[j] === ":" ? id.id : null;
}

function quotedAttributeNodeId(attrs: string): string | null {
  const lower = attrs.toLowerCase();
  let bestAt = Number.POSITIVE_INFINITY;
  let best: string | null = null;
  for (const key of ["node-id", "nodeid", "id"]) {
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(key, from);
      if (at < 0) break;
      if (key === "id") {
        const prev = lower[at - 1];
        if (prev && ((prev >= "a" && prev <= "z") || prev === "-")) {
          from = at + 1;
          continue;
        }
      }
      if (attrs[at + key.length] !== "=") {
        from = at + key.length;
        continue;
      }
      const quote = attrs[at + key.length + 1];
      if (quote !== '"' && quote !== "'") {
        from = at + key.length;
        continue;
      }
      const valueStart = at + key.length + 2;
      const valueEnd = attrs.indexOf(quote, valueStart);
      if (valueEnd < 0) break;
      const value = attrs.slice(valueStart, valueEnd);
      const id = readNodeIdAt(value, 0);
      if (id && id.end === value.length && at < bestAt) {
        bestAt = at;
        best = id.id;
      }
      break;
    }
  }
  return best;
}

function canvasOrPageTagId(text: string): string | null {
  const lower = text.toLowerCase();
  let from = 0;
  while (from < lower.length) {
    const canvasAt = lower.indexOf("<canvas", from);
    const pageAt = lower.indexOf("<page", from);
    let at = -1;
    let width = 0;
    if (canvasAt >= 0 && (pageAt < 0 || canvasAt < pageAt)) {
      at = canvasAt;
      width = "<canvas".length;
    } else if (pageAt >= 0) {
      at = pageAt;
      width = "<page".length;
    } else return null;
    const boundary = lower[at + width];
    if (boundary && boundary >= "a" && boundary <= "z") {
      from = at + width;
      continue;
    }
    const close = text.indexOf(">", at);
    if (close < 0) return null;
    const id = quotedAttributeNodeId(text.slice(at, close));
    if (id) return id;
    from = close + 1;
  }
  return null;
}

function namedPageOrCoverId(text: string): string | null {
  let from = 0;
  while (from < text.length) {
    const found = findNodeId(text, from);
    if (!found) return null;
    const located = readNodeIdAt(text, found.start);
    if (!located) return null;
    let j = located.end;
    while (isSpaceChar(text[j])) j += 1;
    if (text[j] !== ":") {
      from = found.start + 1;
      continue;
    }
    j += 1;
    while (isSpaceChar(text[j])) j += 1;
    const rest = text.slice(j);
    if (/^(?:Page|Cover)\b/i.test(rest)) return found.id;
    from = found.start + 1;
  }
  return null;
}

function embeddedPlansObject(text: string): string | null {
  let from = 0;
  while (from < text.length) {
    const keyAt = text.indexOf('"plans"', from);
    if (keyAt < 0) return null;
    let i = keyAt + '"plans"'.length;
    while (isSpaceChar(text[i])) i += 1;
    if (text[i] !== ":") {
      from = keyAt + 1;
      continue;
    }
    i += 1;
    while (isSpaceChar(text[i])) i += 1;
    if (text[i] !== "[") {
      from = keyAt + 1;
      continue;
    }
    let depth = 0;
    let start = -1;
    for (let j = keyAt; j >= 0; j -= 1) {
      const ch = text[j]!;
      if (ch === "}") depth += 1;
      else if (ch === "{") {
        if (depth === 0) {
          start = j;
          break;
        }
        depth -= 1;
      }
    }
    if (start < 0) {
      from = keyAt + 1;
      continue;
    }
    depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = start; j < text.length; j += 1) {
      const ch = text[j]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, j + 1);
      }
    }
    return null;
  }
  return null;
}

function looksLikePageListing(text: string): boolean {
  if (/<frame\b/i.test(text)) return false;
  if (/"startingNodeId"\s*:/.test(text)) return false;
  if (/Top-level pages/i.test(text)) return true;
  return text.split("\n").some((line) => pageListingIdOnLine(line) !== null);
}

/**
 * First canvas/page id in a `get_metadata` page listing, used only to drill in.
 * Never use this as `starting-point-node-id`.
 */
export function extractCanvasPageId(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const id = pageListingIdOnLine(line);
    if (id) return normalizeFigmaNodeId(id);
  }
  const canvas = canvasOrPageTagId(text);
  if (canvas) return normalizeFigmaNodeId(canvas);
  const named = namedPageOrCoverId(text);
  if (named) return normalizeFigmaNodeId(named);
  return undefined;
}

/**
 * `create_new_file` project (folder) id. Bare digits, or the id segment of
 * `figma.com/files/.../folder/:id` or `.../project/:id` — Figma's UI emits the
 * first, its older URLs the second, and both denote the same folder. A
 * `/team/:id` files URL is not a folder — use `parseFigmaFilesTarget` +
 * team-project lookup. Empty / malformed → omitted, which puts the file in
 * drafts.
 */
export function parseFigmaProjectId(raw: string | undefined): string | undefined {
  const target = parseFigmaFilesTarget(raw);
  return target?.kind === "project" ? target.id : undefined;
}

export type FigmaFilesTarget = { kind: "project" | "team"; id: string };

/**
 * Where `FIGMA_PROJECT_ID` points.
 *
 * `/folder/` and `/project/` are the same thing — a folder id `create_new_file`
 * takes directly. Figma's current UI puts `/folder/` in the address bar and the
 * older one used `/project/`; only the latter was recognised here, so pasting a
 * folder URL copied out of Figma today parsed as *nothing* and the publish fell
 * through to drafts without saying why. Both are accepted now.
 *
 * `/team/` is the team home, not a folder, and needs a lookup to resolve one.
 * `?fuid=` is a viewer id and is ignored.
 */
export function parseFigmaFilesTarget(raw: string | undefined): FigmaFilesTarget | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const project = /\/(?:project|folder)\/(\d{6,})(?:\/|$|\?|#)/.exec(trimmed);
  if (project?.[1]) return { kind: "project", id: project[1] };
  const team = /\/team\/(\d{6,})(?:\/|$|\?|#)/.exec(trimmed);
  if (team?.[1]) return { kind: "team", id: team[1] };
  if (/^\d{6,}$/.test(trimmed)) return { kind: "project", id: trimmed };
  return undefined;
}

export function figmaTeamProjectsUrl(teamId: string): string | undefined {
  if (!/^\d{6,}$/.test(teamId)) return undefined;
  return `https://api.figma.com/v1/teams/${teamId}/projects`;
}

export function figmaTeamFoldersUrl(teamId: string): string | undefined {
  if (!/^\d{6,}$/.test(teamId)) return undefined;
  return `https://api.figma.com/v2/teams/${teamId}/folders`;
}

export function isAllowedFigmaTeamProjectsUrl(url: string): boolean {
  return isAllowedFigmaTeamLookupUrl(url);
}

export function isAllowedFigmaTeamLookupUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.hostname !== "api.figma.com") return false;
  if (parsed.search || parsed.hash) return false;
  return (
    /^\/v1\/teams\/\d{6,}\/projects$/.test(parsed.pathname) ||
    /^\/v2\/teams\/\d{6,}\/folders$/.test(parsed.pathname)
  );
}

export function parseFigmaTeamProjects(raw: unknown): Array<{ id: string; name: string }> {
  if (!isRecord(raw)) return [];
  const buckets = [raw.projects, raw.folders];
  const projects: Array<{ id: string; name: string }> = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      if (!isRecord(item)) continue;
      const id =
        typeof item.id === "number" && Number.isFinite(item.id)
          ? String(Math.trunc(item.id))
          : typeof item.id === "string" && /^\d{6,}$/.test(item.id)
            ? item.id
            : undefined;
      const name = typeof item.name === "string" ? item.name.replace(/[^\w .+-]/g, "").trim().slice(0, 64) : "";
      if (id && !projects.some((project) => project.id === id)) projects.push({ id, name });
    }
  }
  return projects.slice(0, 50);
}

/** Prefer a folder whose name contains "lexi"; otherwise the only folder. */
export function pickLexiTeamProject(
  projects: Array<{ id: string; name: string }>,
): { id: string; name: string } | undefined {
  if (projects.length === 0) return undefined;
  const lexi = projects.filter((project) => /lexi/i.test(project.name));
  if (lexi.length === 1) return lexi[0];
  if (lexi.length > 1) return lexi.find((project) => /design/i.test(project.name)) ?? lexi[0];
  if (projects.length === 1) return projects[0];
  return undefined;
}

/**
 * First Figma *frame* id in metadata XML/JSON or a `use_figma` plugin return,
 * preferring a frame whose name matches `preferredFrameName` when given.
 * Page listings (`0:1: Page 1`) are not start nodes.
 */
export function extractStartingNodeId(text: string, preferredFrameName?: string): string | undefined {
  const fromPlugin = /"startingNodeId"\s*:\s*"(\d+[:-]\d+)"/.exec(text);
  if (fromPlugin?.[1] && !isUnusableProtoStart(fromPlugin[1], text)) {
    return normalizeFigmaNodeId(fromPlugin[1]);
  }
  if (looksLikePageListing(text)) return undefined;

  if (preferredFrameName && preferredFrameName.length > 0) {
    const escaped = preferredFrameName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = new RegExp(
      `(?:name=["']${escaped}["'][^>]*(?:id|node-id|nodeId)=["']([^"']+)["']|(?:id|node-id|nodeId)=["']([^"']+)["'][^>]*name=["']${escaped}["'])`,
      "i",
    );
    const namedMatch = named.exec(text);
    const candidate = namedMatch?.[1] ?? namedMatch?.[2];
    if (candidate && findNodeId(candidate) && !isUnusableProtoStart(candidate, text)) {
      return normalizeFigmaNodeId(candidate);
    }
  }
  const attr = /(?:id|node-id|nodeId)=["'](\d+[:-]\d+)["']/.exec(text);
  if (attr?.[1] && !isUnusableProtoStart(attr[1], text)) return normalizeFigmaNodeId(attr[1]);
  const loose = findNodeId(text);
  if (loose && !isUnusableProtoStart(loose.id, text)) return normalizeFigmaNodeId(loose.id);
  return undefined;
}

/** True only when `whoami` confirms a Full seat that can write. */
export function seatAllowsFigmaWrite(whoamiText: string, raw?: unknown): boolean {
  const plans = parseFigmaPlans(whoamiText, raw);
  if (plans.some((plan) => plan.seat.toLowerCase() === "full")) return true;
  const lower = whoamiText.toLowerCase();
  if (/\bdev\s*seat\b/.test(lower) && !/\bfull\b/.test(lower)) return false;
  return /\bfull\s*seat\b/.test(lower) || (/\bseat\b/.test(lower) && /\bfull\b/.test(lower));
}

export function fileUrlFor(fileKey: string): string {
  return `https://www.figma.com/design/${fileKey}`;
}

/**
 * The only MCP endpoint a Bearer token is ever sent to. `loadFigmaConfig`
 * refuses a bad URL at boot; the client checks it again before every request,
 * for callers that built their options by hand.
 */
export function isAllowedFigmaMcpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.search || parsed.hash) return false;
  if (parsed.hostname !== "mcp.figma.com") return false;
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  return path === "/mcp";
}

export type { JsonRpcSuccess, JsonRpcFailure };

/**
 * Strict parser for Figma design links shared in Slack.
 *
 * Security posture (SSRF / open-redirect):
 * - Never HTTP-fetch the caller-supplied URL. Callers extract fileKey + nodeId
 *   and talk only to allowlisted Figma MCP / api.figma.com endpoints.
 * - HTTPS only; exact host www.figma.com or figma.com; no userinfo.
 * - Path must be /design|/file|/proto/:fileKey — not board/slides/community/make.
 * - fileKey is alphanumeric only; node-id is digits with : or - only.
 */

export interface ParsedFigmaDesignLink {
  fileKey: string;
  /** Canonical `123:456` form when present. */
  nodeId?: string;
  kind: "design" | "file" | "proto";
}

export type FigmaDesignLinkParseResult =
  | { ok: true; link: ParsedFigmaDesignLink }
  | { ok: false; reason: string };

const MAX_RAW_LENGTH = 2048;
const FILE_KEY_RE = /^[A-Za-z0-9]{10,128}$/;
const NODE_ID_RE = /^\d+[:-]\d+$/;
const PATH_RE = /^\/(design|file|proto)\/([A-Za-z0-9]{10,128})(?:\/|$)/;

/**
 * Unwrap Slack link markup and pull the first embeddable Figma URL from a
 * longer message. Returns the candidate string for `parseFigmaDesignLink`.
 */
export function extractFigmaDesignUrlCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";

  const slack = /^<([^|>]+)(?:\|[^>]*)?>$/.exec(trimmed);
  if (slack?.[1]) return slack[1].trim();

  // Prefer an already-complete URL (keeps ?node-id=…). Only fall back to a
  // substring match when the message has surrounding prose.
  if (/^https:\/\//i.test(trimmed)) {
    try {
      const asUrl = new URL(trimmed);
      if (asUrl.hostname === "www.figma.com" || asUrl.hostname === "figma.com") {
        return trimmed;
      }
    } catch {
      // fall through to embedded scan
    }
  }

  const embedded =
    /https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/[A-Za-z0-9][^\s<>"']*/i.exec(trimmed);
  if (embedded?.[0]) {
    return embedded[0].replace(/[>,)\].'"\s]+$/g, "");
  }
  return trimmed;
}

export function parseFigmaDesignLink(raw: string): FigmaDesignLinkParseResult {
  const candidate = extractFigmaDesignUrlCandidate(raw);
  if (candidate.length === 0) {
    return { ok: false, reason: "Figma design URL is empty. Nothing was fetched." };
  }
  if (candidate.length > MAX_RAW_LENGTH) {
    return { ok: false, reason: "Figma design URL is too long. Nothing was fetched." };
  }
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(candidate)) {
    return { ok: false, reason: "Figma design URL contains control characters. Nothing was fetched." };
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "Figma design URL is not a valid URL. Nothing was fetched." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "Figma design URL must be https. Nothing was fetched." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Figma design URL must not carry credentials. Nothing was fetched." };
  }
  if (parsed.hostname !== "www.figma.com" && parsed.hostname !== "figma.com") {
    return {
      ok: false,
      reason: "Figma design URL host must be www.figma.com or figma.com. Nothing was fetched.",
    };
  }

  const pathMatch = PATH_RE.exec(parsed.pathname);
  if (!pathMatch) {
    return {
      ok: false,
      reason:
        "Figma design URL path must be /design/, /file/, or /proto/ with a file key. Nothing was fetched.",
    };
  }

  const kind = pathMatch[1] as ParsedFigmaDesignLink["kind"];
  const fileKey = pathMatch[2]!;
  if (!FILE_KEY_RE.test(fileKey)) {
    return { ok: false, reason: "Figma file key is malformed. Nothing was fetched." };
  }

  const nodeRaw =
    parsed.searchParams.get("node-id") ??
    parsed.searchParams.get("node_id") ??
    parsed.searchParams.get("starting-point-node-id") ??
    undefined;
  let nodeId: string | undefined;
  if (nodeRaw != null && nodeRaw.length > 0) {
    const decoded = decodeURIComponent(nodeRaw.trim());
    if (!NODE_ID_RE.test(decoded)) {
      return {
        ok: false,
        reason: "Figma node-id must be digits with : or - only. Nothing was fetched.",
      };
    }
    nodeId = decoded.replace(/-/g, ":");
  }

  return { ok: true, link: { fileKey, kind, ...(nodeId ? { nodeId } : {}) } };
}

/** True when a file key is already in the Lexi / allowlist key shape. */
export function isFigmaFileKeyShape(fileKey: string): boolean {
  return FILE_KEY_RE.test(fileKey.trim());
}

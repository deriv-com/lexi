/* Bridge configuration, read from the environment (and an optional, git-ignored
   `.env` next to this file — see `.env.example`). Everything is optional: with
   nothing set, the bridge runs on 127.0.0.1:7341, builds in ~/LexiBuilds, uses
   the generic seed spec, no design system, no reference app and no Mobbin. */
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** An npm package name: `name` or `@scope/name`, lowercase, URL-safe. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const expandHome = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

/**
 * Resolves `LEXI_DESIGN_SYSTEM`. The design system is a pluggable input:
 *  - a path to a markdown file → copied into the workspace steering as-is;
 *  - a path to a directory → copied whole (its README.md / DESIGN.md / *.md
 *    become the steering the agents read);
 *  - an npm package name → added to the workspace `package.json` and named in
 *    the steering, so builders use its components and tokens.
 * Anything else (or nothing) means "no design system": agents follow the
 * hallmark/taste skills and their own judgement, and say so.
 */
export function resolveDesignSystem(raw, version = "") {
  const value = String(raw ?? "").trim();
  if (!value) return { kind: "none" };
  const asPath = path.resolve(expandHome(value));
  if (existsSync(asPath)) {
    return statSync(asPath).isDirectory() ? { kind: "dir", path: asPath } : { kind: "file", path: asPath };
  }
  if (NPM_NAME.test(value)) return { kind: "package", name: value, version: String(version || "").trim() || "latest" };
  return { kind: "invalid", value, reason: `LEXI_DESIGN_SYSTEM is neither an existing path nor an npm package name: ${value}` };
}

/** MCP endpoints must be HTTPS (or plain HTTP on loopback, for a local server). */
export function isAllowedMcpUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname);
}

export function loadConfig(env = process.env) {
  const optionalPath = (name) => {
    const v = String(env[name] ?? "").trim();
    if (!v) return null;
    const p = path.resolve(expandHome(v));
    return existsSync(p) ? p : null;
  };
  const mcp = (name) => {
    const v = String(env[name] ?? "").trim();
    return v && isAllowedMcpUrl(v) ? v : null;
  };
  const port = Number(env.LEXI_BRIDGE_PORT || 7341);
  return {
    host: "127.0.0.1",
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7341,
    defaultRunner: String(env.LEXI_RUNNER || "claude"),
    workspaceRoot: path.resolve(expandHome(env.LEXI_WORKSPACE_ROOT || path.join(os.homedir(), "LexiBuilds"))),
    businessSpec: optionalPath("LEXI_BUSINESS_SPEC"),
    sourcesDir: optionalPath("LEXI_SOURCES_DIR"),
    referenceAppDir: optionalPath("LEXI_REFERENCE_APP_DIR"),
    referenceAppName: String(env.LEXI_REFERENCE_APP_NAME || "").trim() || "the reference app",
    designSystem: resolveDesignSystem(env.LEXI_DESIGN_SYSTEM, env.LEXI_DESIGN_SYSTEM_VERSION),
    mobbinMcpUrl: mcp("LEXI_MOBBIN_MCP_URL"),
    figmaMcpUrl: mcp("LEXI_FIGMA_MCP_URL"),
    /* Extra browser origins allowed to open the WebSocket (comma-separated).
       Loopback origins are always allowed; nothing else is unless listed. */
    allowedOrigins: String(env.LEXI_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
    phaseTimeoutMs: Number(env.LEXI_PHASE_TIMEOUT_MS || 20 * 60 * 1000),
    maxSteps: Number(env.LEXI_MAX_STEPS || 40),
  };
}

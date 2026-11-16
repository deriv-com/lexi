/* Request guards for the bridge. The bridge only listens on loopback, but a
   web page in the user's browser can still reach loopback ports: without an
   Origin check any site could open the WebSocket and start a build whose
   agents run with full tool access in the workspace. And the preview route
   serves files, so its paths must never resolve outside the workspace. */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * True when a WebSocket upgrade may proceed. Browsers always send `Origin`;
 * non-browser clients (curl, tests) send none and are allowed, since they
 * already run on this machine. Browser origins must be loopback or listed
 * in `LEXI_ALLOWED_ORIGINS`.
 */
export function isAllowedOrigin(origin, allowedOrigins = []) {
  if (origin === undefined || origin === null || origin === "") return true;
  if (allowedOrigins.includes(origin)) return true;
  let url;
  try { url = new URL(origin); } catch { return false; }
  return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.test(url.hostname);
}

/**
 * True when a request's `Host` header names this bridge on loopback: one of
 * `localhost`, `127.0.0.1` or `[::1]`, with the bound port. Listening on
 * loopback is not enough on its own: with DNS rebinding a site the user visits
 * can resolve its own name to 127.0.0.1 and read `/health` or `/preview/...`
 * from the browser. Such a request still carries the site's name as `Host`.
 */
export function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== "string" || hostHeader === "" || /[\s/@?#\\]/.test(hostHeader)) return false;
  let url;
  try { url = new URL(`http://${hostHeader}`); } catch { return false; }
  const hostPort = url.port === "" ? 80 : Number(url.port);
  return LOOPBACK.test(url.hostname) && hostPort === Number(port);
}

/** True when `child` is `parent` or inside it (no `..` escape, no sibling prefix match). */
export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Maps `/preview/<slug>/<rest>` to a file in a shipped workspace, preferring the
 * Vite build output (`dist/`). Returns null for anything that is not a plain
 * workspace slug or resolves outside the app root.
 */
export function resolvePreviewFile(workspaceRoot, relPath) {
  let rel;
  try { rel = decodeURIComponent(relPath); } catch { return null; }
  if (rel.includes("\0")) return null;
  const slash = rel.indexOf("/");
  const slug = slash < 0 ? rel : rel.slice(0, slash);
  const rest = slash < 0 ? "" : rel.slice(slash + 1);
  if (!SLUG.test(slug)) return null;
  const wsDir = path.resolve(workspaceRoot, slug);
  if (!isInside(workspaceRoot, wsDir)) return null;
  const appRoot = existsSync(path.join(wsDir, "dist", "index.html")) ? path.join(wsDir, "dist") : wsDir;
  const file = path.resolve(appRoot, rest === "" || rest.endsWith("/") ? rest + "index.html" : rest);
  if (!isInside(appRoot, file) || !existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

/** Maps a request path to a file in the static UI folder, or null. */
export function resolveUiFile(uiRoot, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel.includes("\0")) return null;
  const file = path.resolve(uiRoot, "." + (rel === "/" ? "/index.html" : rel));
  if (!isInside(uiRoot, file) || !existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

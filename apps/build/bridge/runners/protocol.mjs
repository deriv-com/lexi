/* Shared agent-output protocol for every runner.
   Agents print @@SAY@@ one-liners while they work and finish with one
   ```lexi-json block. Runners turn their native output (plain text or
   stream-json) into: streamed say-lines + {text, json}. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// eslint-disable-next-line no-control-regex -- matching terminal escape codes is the point
const ANSI = /[][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
export const stripAnsi = (s) => s.replace(ANSI, "").replace(/[▰▱]/g, "").replace(/\r/g, "");

export function extractJson(text) {
  const fenced = text.match(/```lexi-json\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : (() => { const s = text.lastIndexOf("{"); const e = text.lastIndexOf("}"); return s >= 0 && e > s ? text.slice(s, e + 1) : null; })();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/* Agents are told to put each @@SAY@@ line on its own line — real models don't
   always comply: they glue two together ("done.@@SAY@@ Next…"), put prose
   before the marker, or split the marker itself across stream chunks. So:
   scan for the marker ANYWHERE, emit the text up to the next marker/newline,
   and keep a tail that could be a marker split across chunks. */
export class SayLines {
  constructor(onSay) { this.onSay = onSay; this.buf = ""; }
  feed(text) { this.buf += text; this.drain(false); }
  flush() { this.drain(true); }
  drain(final) {
    for (;;) {
      const i = this.buf.indexOf("@@SAY@@");
      if (i < 0) {
        /* no complete marker: only a split marker at the tail is worth keeping */
        this.buf = final ? "" : this.buf.slice(-7);
        return;
      }
      const rest = this.buf.slice(i + 7);
      const next = rest.indexOf("@@SAY@@");
      const nl = rest.indexOf("\n");
      let end = next < 0 ? nl : nl < 0 ? next : Math.min(next, nl);
      if (end < 0) {
        if (!final) return; // line still arriving
        end = rest.length;
      }
      const line = rest.slice(0, end).trim();
      if (line) this.onSay?.(line);
      if (end >= rest.length) { this.buf = ""; return; }
      this.buf = rest[end] === "@" ? "@@SAY@@" + rest.slice(end + 7) : rest.slice(end + 1);
    }
  }
}

/** Spawn, collect stdout+stderr, kill the whole group on timeout/abort. */
export function runProcess({ bin, args, cwd, signal, timeoutMs = 20 * 60 * 1000, onStdout }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: process.env, detached: true });
    let out = "", err = "", timedOut = false;
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => { out += d; onStdout?.(String(d)); });
    child.stderr.on("data", (d) => (err += d));
    let settled = false;
    const finish = (code, sig) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal: sig, timedOut, text: stripAnsi(out), stderr: stripAnsi(err) });
    };
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", finish);
    /* If the agent exits but a tool grandchild keeps the pipes open, `close`
       can hang forever — settle shortly after `exit` and tear the streams down. */
    child.on("exit", (code, sig) => setTimeout(() => { try { child.stdout.destroy(); child.stderr.destroy(); } catch {} finish(code, sig); }, 1500).unref?.());
  });
}

/** The one-line, human-readable reason a runner run ended badly — never a transcript dump. */
export function exitReason(r, label, timeoutMs, aborted) {
  if (aborted) { const e = new Error("cancelled"); e.code = "CANCELLED"; return e; }
  if (r.timedOut) { const ms = timeoutMs || 20 * 60 * 1000; const limit = ms >= 90000 ? `${Math.round(ms / 60000)}-minute` : `${Math.max(1, Math.round(ms / 1000))}-second`; const e = new Error(`${label} hit the ${limit} limit and was stopped — its work so far is on disk in the workspace`); e.code = "TIMEOUT"; return e; }
  if (r.code !== 0) { const e = new Error(`${label} exited ${r.code === null ? `via ${r.signal || "signal"}` : r.code}: ${(r.stderr || "").trim().slice(-200) || "no error output"}`); e.code = "RUNNER_EXIT"; return e; }
  return null;
}

export function capture(bin, args, { cwd, timeoutMs = 20000 } = {}) {
  return runProcess({ bin, args, cwd, timeoutMs }).catch((e) => ({ code: -1, text: "", stderr: String(e) }));
}

export async function binAvailable(bin) {
  if (!bin) return false;
  if (bin.includes("/")) return existsSync(bin);
  const r = await capture(bin, ["--version"], { timeoutMs: 15000 });
  return r.code === 0 || r.text.trim().length > 0;
}

/** Pull assistant text out of a stream-json line (Claude Code / Cursor shapes). */
export function streamJsonText(line) {
  let ev; try { ev = JSON.parse(line); } catch { return ""; }
  const parts = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "text" && typeof node.text === "string") parts.push(node.text);
    if (typeof node.delta === "string") parts.push(node.delta);
    for (const v of Object.values(node)) { if (v && typeof v === "object") walk(v); }
  };
  if (ev.type === "assistant" || ev.type === "result" || ev.type === "text" || ev.message) walk(ev.message || ev);
  return parts.join("");
}

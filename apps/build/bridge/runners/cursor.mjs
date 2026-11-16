/* Runner: Cursor Agent CLI (~/.local/bin/cursor-agent -p, stream-json).
   Auth via `cursor-agent login` or CURSOR_API_KEY. */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SayLines, binAvailable, capture, exitReason, extractJson, runProcess, streamJsonText } from "./protocol.mjs";

export const id = "cursor";
export const label = "Cursor Agent";
export const model = () => process.env.LEXI_MODEL_CURSOR || ""; // "" = agent default
export const installHint = "Install Cursor, then run: cursor-agent login (or set CURSOR_API_KEY)";

export function bin() {
  if (process.env.CURSOR_AGENT_BIN) return process.env.CURSOR_AGENT_BIN;
  const local = path.join(os.homedir(), ".local", "bin", "cursor-agent");
  return existsSync(local) ? local : "cursor-agent";
}

export async function checkAuth() {
  if (!(await binAvailable(bin()))) return { available: false, authenticated: false, detail: "cursor-agent not found on this machine" };
  if (process.env.CURSOR_API_KEY) return { available: true, authenticated: true, detail: "CURSOR_API_KEY set" };
  const r = await capture(bin(), ["status"], { timeoutMs: 20000 });
  const t = r.text + r.stderr;
  if (/not logged in/i.test(t)) return { available: true, authenticated: false, detail: "Cursor Agent is not logged in. Run: cursor-agent login (or set CURSOR_API_KEY)" };
  return { available: true, authenticated: true, detail: "cursor-agent session found" };
}

export async function run({ cwd, prompt, signal, timeoutMs, onSay }) {
  const say = new SayLines(onSay);
  let text = "", lineBuf = "";
  const args = ["-p", "--output-format", "stream-json", "--force"];
  if (model()) args.push("--model", model());
  args.push(prompt);
  const r = await runProcess({
    bin: bin(), args, cwd, signal, timeoutMs,
    onStdout: (d) => {
      lineBuf += d;
      let i;
      while ((i = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, i); lineBuf = lineBuf.slice(i + 1);
        const t = streamJsonText(line);
        if (t) { text += t; say.feed(t); }
      }
    },
  });
  say.flush();
  const bad = exitReason(r, "cursor-agent", timeoutMs, signal?.aborted);
  if (bad) throw bad;
  return { text, json: extractJson(text) };
}

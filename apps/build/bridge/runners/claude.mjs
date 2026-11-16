/* Runner: Claude Code (claude -p, stream-json). Runs on this machine under the
   user's Claude login. Default model alias "opus" (LEXI_MODEL_CLAUDE overrides). */
import { existsSync } from "node:fs";
import { SayLines, binAvailable, capture, exitReason, extractJson, runProcess, streamJsonText } from "./protocol.mjs";

export const id = "claude";
export const label = "Claude Code";
export const model = () => process.env.LEXI_MODEL_CLAUDE || "opus";
export const installHint = "Install Claude Code (npm i -g @anthropic-ai/claude-code), then run: claude (login once)";

export function bin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  return existsSync("/opt/homebrew/bin/claude") ? "/opt/homebrew/bin/claude" : "claude";
}

export async function checkAuth() {
  if (!(await binAvailable(bin()))) return { available: false, authenticated: false, detail: "claude not found on this machine" };
  const r = await capture(bin(), ["auth", "status"], { timeoutMs: 20000 });
  try {
    const s = JSON.parse(r.text);
    return s.loggedIn
      ? { available: true, authenticated: true, detail: `claude login (${s.authMethod || "oauth"})` }
      : { available: true, authenticated: false, detail: "Claude Code is not logged in. Run: claude, then /login" };
  } catch {
    return /loggedIn"\s*:\s*true/.test(r.text)
      ? { available: true, authenticated: true, detail: "claude login found" }
      : { available: true, authenticated: false, detail: "Claude Code is not logged in. Run: claude, then /login" };
  }
}

export async function run({ cwd, prompt, signal, timeoutMs, onSay }) {
  const say = new SayLines(onSay);
  let text = "", lineBuf = "";
  const r = await runProcess({
    bin: bin(),
    args: ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", model(), prompt],
    cwd, signal, timeoutMs,
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
  const bad = exitReason(r, "claude", timeoutMs, signal?.aborted);
  if (bad) throw bad;
  return { text, json: extractJson(text) };
}

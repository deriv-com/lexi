/* Runner: Kiro CLI (~/.local/bin/kiro-cli chat --no-interactive). */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SayLines, binAvailable, capture, exitReason, extractJson, runProcess, stripAnsi } from "./protocol.mjs";

export const id = "kiro";
export const label = "Kiro CLI";
export const model = () => process.env.LEXI_MODEL_KIRO || process.env.LEXI_MODEL || "claude-opus-5.5";
export const installHint = "Install Kiro CLI from the Kiro app, then run: kiro-cli login";

export function bin() {
  if (process.env.KIRO_BIN) return process.env.KIRO_BIN;
  const local = path.join(os.homedir(), ".local", "bin", "kiro-cli");
  return existsSync(local) ? local : "kiro-cli";
}

export async function checkAuth() {
  if (!(await binAvailable(bin()))) return { available: false, authenticated: false, detail: "kiro-cli not found on this machine" };
  const r = await capture(bin(), ["agent", "list"], { timeoutMs: 20000 });
  if (/not logged in/i.test(r.text + r.stderr)) return { available: true, authenticated: false, detail: "Kiro CLI is not logged in. Run: kiro-cli login" };
  return { available: true, authenticated: true, detail: "kiro-cli session found" };
}

export async function run({ cwd, prompt, signal, timeoutMs, onSay }) {
  const say = new SayLines(onSay);
  const r = await runProcess({
    bin: bin(), args: ["chat", "--no-interactive", "--trust-all-tools", "--model", model(), prompt],
    cwd, signal, timeoutMs, onStdout: (d) => say.feed(stripAnsi(d)),
  });
  say.flush();
  const text = r.text + r.stderr;
  if (/not logged in/i.test(text)) { const e = new Error("Kiro CLI is not logged in. Run: kiro-cli login"); e.code = "NOT_LOGGED_IN"; throw e; }
  const bad = exitReason(r, "kiro-cli", timeoutMs, signal?.aborted);
  if (bad) throw bad;
  return { text, json: extractJson(text) };
}

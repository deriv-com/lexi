/* Runner: Codex (codex exec --json), workspace-write sandbox,
   scoped to the product workspace; skips the git-repo check (workspaces
   are plain folders). Auth via ChatGPT login (codex login). */
import { SayLines, binAvailable, capture, exitReason, extractJson, runProcess } from "./protocol.mjs";

export const id = "codex";
export const label = "Codex";
export const model = () => process.env.LEXI_MODEL_CODEX || ""; // "" = account default
export const installHint = "Install: npm i -g @openai/codex, then run: codex login";

export function bin() {
  return process.env.CODEX_BIN || "codex";
}

export async function checkAuth() {
  if (!(await binAvailable(bin()))) return { available: false, authenticated: false, detail: "codex not found on this machine" };
  const r = await capture(bin(), ["login", "status"], { timeoutMs: 20000 });
  const t = r.text + r.stderr;
  return /logged in/i.test(t) && !/not logged in/i.test(t)
    ? { available: true, authenticated: true, detail: "codex login found" }
    : { available: true, authenticated: false, detail: "Codex is not logged in. Run: codex login" };
}

export async function run({ cwd, prompt, signal, timeoutMs, onSay }) {
  const say = new SayLines(onSay);
  let text = "", lineBuf = "";
  const args = ["exec", "--json", "-C", cwd, "-s", "workspace-write", "--skip-git-repo-check"];
  if (model()) args.push("-m", model());
  args.push(prompt);
  const r = await runProcess({
    bin: bin(), args, cwd, signal, timeoutMs,
    onStdout: (d) => {
      lineBuf += d;
      let i;
      while ((i = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, i); lineBuf = lineBuf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          const item = ev.item || {};
          const t = (ev.type === "item.completed" && item.type === "agent_message" && item.text) ||
                    (ev.type === "agent_message" && ev.text) || "";
          if (t) { text += t + "\n"; say.feed(t + "\n"); }
        } catch { /* non-json line: ignore */ }
      }
    },
  });
  say.flush();
  const bad = exitReason(r, "codex", timeoutMs, signal?.aborted);
  if (bad) throw bad;
  return { text, json: extractJson(text) };
}

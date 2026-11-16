/* Runner registry — Lexi chooses who works. Every runner implements:
   { id, label, model(), installHint, bin(), checkAuth(), run({cwd, prompt,
   signal, timeoutMs, onSay}) -> {text, json} } */
import * as kiro from "./kiro.mjs";
import * as claude from "./claude.mjs";
import * as cursor from "./cursor.mjs";
import * as codex from "./codex.mjs";

export const RUNNERS = { kiro, claude, cursor, codex };
export const getRunner = (id) => RUNNERS[id] || RUNNERS.kiro;

export async function listRunners() {
  const out = [];
  for (const r of Object.values(RUNNERS)) {
    let auth;
    try { auth = await r.checkAuth(); } catch (e) { auth = { available: false, authenticated: false, detail: String(e.message || e) }; }
    out.push({ id: r.id, label: r.label, model: r.model(), installHint: r.installHint, ...auth });
  }
  return out;
}

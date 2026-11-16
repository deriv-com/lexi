// Adds up what a run spent, from the CLI's own result events.
//
// usage: node cost.mjs <file>...   (segment-*.jsonl streams, gate-*.json and
//                                   review.md.json results)
// Prints JSON: { total, parts: { <part>: { usd, input, output, cacheRead,
// cacheWrite } } }, where a part is the phase of a segment (intent, spec,
// plan, build), "gate" or "review".
//
// `total_cost_usd` in a result event is CUMULATIVE for its conversation: a
// resumed segment reports the earlier segments' spend again (for example
// 15.11 → 24.34 → 30.53 across three segments). So each conversation (session_id) counts
// once, at its highest figure. Prices are the CLI's list prices, an estimate.
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

const byConversation = new Map();
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) continue;
  const name = basename(file);
  let part = "build";
  const seg = name.match(/^segment-(\d+)\.jsonl$/);
  if (seg) {
    const phaseFile = file.replace(/\.jsonl$/, ".phase");
    part = existsSync(phaseFile) ? readFileSync(phaseFile, "utf8").trim() || "build" : "build";
  } else if (name.startsWith("gate-")) part = "gate";
  else if (name.startsWith("review")) part = "review";

  for (const line of readFileSync(file, "utf8").split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== "result" || typeof event.total_cost_usd !== "number") continue;
    const key = event.session_id ?? `${file}:${line.length}`;
    const seen = byConversation.get(key);
    if (!seen || event.total_cost_usd >= seen.usd) {
      const u = event.usage ?? {};
      byConversation.set(key, {
        part,
        usd: event.total_cost_usd,
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      });
    }
  }
}

const parts = {};
let total = 0;
for (const c of byConversation.values()) {
  const p = (parts[c.part] ??= { usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  for (const k of ["usd", "input", "output", "cacheRead", "cacheWrite"]) p[k] += c[k];
  total += c.usd;
}
for (const p of Object.values(parts)) p.usd = Math.round(p.usd * 100) / 100;
process.stdout.write(JSON.stringify({ total: Math.round(total * 100) / 100, parts }) + "\n");

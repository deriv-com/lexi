#!/usr/bin/env node
/* Lexi Bridge — the backend where the agents work.
   Runs on this machine (127.0.0.1 only). Drives a local agent CLI through
   Lexi's pipeline, serves the Table UI, and streams Table events to it over a
   WebSocket on the same port. Agents execute in <LEXI_WORKSPACE_ROOT>/<product>/. */
import http from "node:http";
import { readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.mjs";
import { isAllowedHost, isAllowedOrigin, resolvePreviewFile, resolveUiFile } from "./guards.mjs";
import { RUNNERS, getRunner, listRunners } from "./runners/index.mjs";
import { runPipeline } from "./pipeline.mjs";

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(BRIDGE_DIR, "..", "ui");

/* Optional local configuration (git-ignored): see .env.example. */
try { process.loadEnvFile(path.join(BRIDGE_DIR, ".env")); } catch { /* no .env — defaults apply */ }

const CONFIG = loadConfig();
const PORT = CONFIG.port;
const HOST = CONFIG.host;
const WORKSPACE_ROOT = CONFIG.workspaceRoot;
const DEFAULT_RUNNER = RUNNERS[CONFIG.defaultRunner] ? CONFIG.defaultRunner : "claude";
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".md": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

const sendFile = (res, file) => {
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "x-content-type-options": "nosniff" });
  res.end(readFileSync(file));
};

const server = http.createServer((req, res) => {
  /* DNS rebinding: a page whose own name resolves to 127.0.0.1 can reach this
     port, but its requests still carry that name as Host. */
  if (!isAllowedHost(req.headers.host, PORT)) {
    res.writeHead(421, { "content-type": "text/plain" });
    res.end("misdirected request · the bridge answers only on localhost");
    return;
  }
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === "/health") {
    listRunners().then((runners) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true, bridge: "lexi-bridge", defaultRunner: DEFAULT_RUNNER, runners, workspaceRoot: WORKSPACE_ROOT,
        designSystem: CONFIG.designSystem.kind, referenceApp: !!CONFIG.referenceAppDir, sources: !!CONFIG.sourcesDir,
        mobbin: !!CONFIG.mobbinMcpUrl, figma: !!CONFIG.figmaMcpUrl,
      }));
    });
    return;
  }
  if (url.pathname.startsWith("/preview/")) {
    /* serve a shipped workspace's app — path-traversal guarded (guards.mjs) */
    const file = resolvePreviewFile(WORKSPACE_ROOT, url.pathname.slice("/preview/".length));
    if (!file) { res.writeHead(404); res.end("not found"); return; }
    sendFile(res, file);
    return;
  }
  const uiFile = resolveUiFile(UI_DIR, url.pathname);
  if (uiFile) { sendFile(res, uiFile); return; }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found · the Table is at /build.html · GET /health for status");
});

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin, req }, done) => {
    if (!isAllowedHost(req.headers.host, PORT)) {
      console.warn(`[bridge] refused a WebSocket for host ${req.headers.host}`);
      return done(false, 421, "host not allowed");
    }
    if (isAllowedOrigin(origin, CONFIG.allowedOrigins)) return done(true);
    console.warn(`[bridge] refused a WebSocket from origin ${origin}`);
    done(false, 403, "origin not allowed");
  },
});
let activeRun = null; // {abort: AbortController, pending: Map, steering: string[]}
const sockets = new Set();
/* Every pipeline event of the current/last run, kept so a refreshed page can
   rebuild the whole table. A run survives disconnects; only Cancel stops it. */
let eventLog = [];
let askInFlight = false;

/* ---------- pipeline state + ETA history (answers "what are you doing?") ---------- */
const PHASE_ORDER = ["Intent", "Spec", "Plan", "Wireframe", "Prototype", "Build", "Review ⇄ Fix", "Your approval", "Ship"];
const HISTORY_FILE = path.join(BRIDGE_DIR, ".history.json");
let history = { phases: {} };
try { history = JSON.parse(readFileSync(HISTORY_FILE, "utf8")); } catch {}
const saveHistory = () => { try { writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); } catch {} };
const avgSecs = (name) => { const a = history.phases[name] || []; return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
const fmtDur = (s) => { s = Math.max(0, Math.round(s)); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`; };

/* live picture of what Lexi is doing, for status answers — global, so it
   survives page refreshes just like the run itself */
const S = { status: "idle", phase: null, phaseSince: 0, startedAt: 0, activity: "at the table", waiting: null, workspace: null, lastShip: null, crew: [] };
const track = (ev) => {
    const t = Date.now();
    if (ev.type === "project") { S.workspace = ev.workspace; S.status = "running"; S.startedAt = t; }
    if (ev.type === "phase") {
      if (S.phase && S.phaseSince) {
        const secs = (t - S.phaseSince) / 1000;
        /* sub-2s phases are test doubles / instant gate flips — not calibration data */
        if (secs >= 2) {
          (history.phases[S.phase] = history.phases[S.phase] || []).push(secs);
          if (history.phases[S.phase].length > 20) history.phases[S.phase].shift();
          saveHistory();
        }
      }
      S.phase = ev.name; S.phaseSince = t; S.waiting = null; if (S.status !== "idle") S.status = "running";
    }
    if (ev.type === "say") S.activity = `${ev.agent}: ${String(ev.text).slice(0, 70)}`;
    if (ev.type === "summon") { S.activity = `${ev.agent} summoned (${ev.reason || "to work"})`; if (!S.crew.includes(ev.agent)) S.crew.push(ev.agent); }
    if (ev.type === "edit") S.activity = `${ev.agent} editing ${ev.element}`;
    if (ev.type === "decision") { S.waiting = "your decision"; S.status = "waiting"; }
    if (ev.type === "approval") { S.waiting = "your approval"; S.status = "waiting"; }
    if (ev.type === "ship") S.lastShip = ev.workspace;
    if (ev.type === "done" || ev.type === "error") { S.status = "idle"; S.waiting = null; S.activity = "at the table"; }
};
const emit = (ev) => {
  track(ev);
  eventLog.push(ev); if (eventLog.length > 600) eventLog.shift();
  for (const s of sockets) if (s.readyState === s.OPEN) s.send(JSON.stringify(ev));
};
const statusText = () => {
    if (S.status === "idle") return S.lastShip
      ? `Status: at the table, nothing running. Last build shipped from ${S.lastShip}. Give me a new intent whenever you're ready.`
      : "Status: at the table, nothing running. Give me an intent and I'll assemble the crew.";
    const elapsed = (Date.now() - S.startedAt) / 1000;
    let eta = null, samples = 0;
    const idx = PHASE_ORDER.indexOf(S.phase);
    if (idx >= 0) {
      let remain = 0, have = false;
      const curAvg = avgSecs(S.phase);
      if (curAvg != null) { remain += Math.max(0, curAvg - (Date.now() - S.phaseSince) / 1000); have = true; samples += (history.phases[S.phase] || []).length; }
      for (const p of PHASE_ORDER.slice(idx + 1)) { const a = avgSecs(p); if (a != null) { remain += a; have = true; samples += (history.phases[p] || []).length; } }
      if (have) eta = remain;
    }
    return `Status: ${S.phase || "starting"} phase · ${S.activity} · running ${fmtDur(elapsed)}` +
      (S.waiting ? ` · waiting on ${S.waiting} (my clock's paused)` : "") +
      (eta != null ? ` · ETA ~${fmtDur(eta)} (from ${samples} timed phase${samples === 1 ? "" : "s"} of past runs)` : " · ETA still calibrating — first runs teach me how long phases take");
};

wss.on("connection", async (ws) => {
  sockets.add(ws);
  const send = (ev) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev)); };
  let chosen = DEFAULT_RUNNER;
  const runners = await listRunners();
  send({ type: "hello", runner: chosen, runners });
  console.log(`[bridge] table connected · runners=${runners.map((r) => `${r.id}:${r.authenticated ? "in" : r.available ? "out" : "missing"}`).join(" ")}`);
  /* Rebuild a refreshed page: replay the run's events fast-forward, skipping
     gates the human already answered; a still-pending gate is re-issued so
     it can be answered right here. Then say whether a build is live. */
  for (const ev of eventLog) {
    if ((ev.type === "decision" || ev.type === "approval") && !(activeRun && activeRun.pending.has(ev.id))) continue;
    send({ ...ev, replay: true });
  }
  if (eventLog.length) send({ type: "session", running: !!activeRun });

  ws.on("message", async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.type === "set-runner") {
      if (RUNNERS[msg.runner]) {
        chosen = msg.runner;
        const r = getRunner(chosen);
        const auth = await r.checkAuth().catch(() => ({ available: false, authenticated: false, detail: "check failed" }));
        send({ type: "runner", runner: chosen, label: r.label, model: r.model(), installHint: r.installHint, ...auth });
      }
      return;
    }

    if (msg.type === "intent") {
      if (activeRun) { send({ type: "error", message: "A build is already running at this table." }); return; }
      const runner = getRunner(chosen);
      const freshAuth = await runner.checkAuth();
      if (!freshAuth.authenticated) {
        send({ type: "error", code: "NOT_LOGGED_IN", message: `${runner.label} can't work yet: ${freshAuth.detail}. ${freshAuth.available ? "" : runner.installHint}` });
        return;
      }
      send({ type: "sys", text: `— agents: ${runner.label}${runner.model() ? ` · model ${runner.model()}` : ""} —` });
      eventLog = [];
      const abort = new AbortController();
      const pending = new Map();
      let seq = 0;
      activeRun = { abort, pending, steering: [] };
      const ask = (ev) => new Promise((resolve) => { const id = "gate-" + (++seq); pending.set(id, resolve); emit({ ...ev, id }); });
      try {
        await runPipeline({
          emit,
          config: CONFIG,
          runnerId: chosen,
          steeringNotes: () => activeRun ? activeRun.steering : [],
          intent: String(msg.text || "").slice(0, 500),
          signal: abort.signal,
          askDecision: ({ title, why, options }) => ask({ type: "decision", title, why, options }),
          askApproval: (arg) => ask({ type: "approval", ...(typeof arg === "string" ? { summary: arg } : { title: arg.title, summary: arg.summary }) }),
        });
      } catch (err) {
        if (err.code === "NOT_LOGGED_IN") send({ type: "error", code: err.code, message: err.message });
        else if (err.code !== "CANCELLED") send({ type: "error", message: `Pipeline stopped: ${err.message}` });
        console.error("[bridge] pipeline error:", err.stack || err.message);
      } finally {
        for (const resolve of pending.values()) resolve(0);
        activeRun = null;
      }
      return;
    }

    if ((msg.type === "decision-answer" || msg.type === "approval-answer") && activeRun) {
      const resolve = activeRun.pending.get(msg.id);
      if (resolve) {
        activeRun.pending.delete(msg.id);
        S.waiting = null; if (S.status === "waiting") S.status = "running";
        resolve(msg.type === "decision-answer" ? Number(msg.index || 0) : { verdict: msg.verdict, instruction: msg.instruction });
      }
      return;
    }

    if (msg.type === "status-query") { send({ type: "status-report", text: statusText() }); return; }

    /* Conversational Lexi: a real question gets a real answer — a short Lexi
       run with the live state as context. Read-only, one at a time, and it
       never edits the workspace. */
    if (msg.type === "ask") {
      const question = String(msg.text || "").slice(0, 500);
      if (!question) return;
      if (askInFlight) { send({ type: "say", agent: "lexi", text: "One question at a time — I'm mid-answer on the last one." }); return; }
      askInFlight = true;
      (async () => {
        try {
          const runner = getRunner(chosen);
          const personaFile = path.join(BRIDGE_DIR, "personas", "lexi.md");
          const personaText = existsSync(personaFile) ? readFileSync(personaFile, "utf8") : "";
          let planText = "";
          if (S.workspace) { try { planText = readFileSync(path.join(S.workspace, "job-plan.md"), "utf8").slice(0, 1200); } catch {} }
          const lines = [];
          const r = await runner.run({
            cwd: S.workspace && existsSync(S.workspace) ? S.workspace : process.cwd(),
            timeoutMs: 3 * 60 * 1000,
            signal: activeRun ? activeRun.abort.signal : undefined,
            onSay: (l) => { if (l) lines.push(l); },
            prompt: `${personaText}\n\n---\n\nThe human at your table just asked you a question. Answer it yourself, briefly and honestly, from the state below. Do NOT edit any file, do NOT run tools, do NOT start work — just answer in 1–3 short sentences, each prefixed with @@SAY@@.\n\n## Live state\n${statusText()}\nCrew summoned so far: ${S.crew.join(", ") || "only you"}\nWaiting on: ${S.waiting || "nobody"}\n${planText ? `\n## Your job plan\n${planText}\n` : ""}\n## The question\n${question}\n`,
          });
          const fromSay = lines.join(" ").replaceAll("@@SAY@@", "").trim();
          const fallback = (r.text || "").replace(/```lexi-json[\s\S]*?```/g, "").replaceAll("@@SAY@@", "").split("\n").map((s) => s.trim()).filter(Boolean).slice(-2).join(" ").slice(0, 400);
          emit({ type: "say", agent: "lexi", text: fromSay || fallback || "I don't have a good answer for that yet — ask me “status” for the facts." });
        } catch {
          send({ type: "say", agent: "lexi", text: "I couldn't think that through just now — ask me “status” and I'll give you the facts straight." });
        } finally { askInFlight = false; }
      })();
      return;
    }

    if (msg.type === "steer") {
      const text = String(msg.text || "").slice(0, 500);
      if (!text) return;
      if (activeRun) {
        activeRun.steering.push(text);
        if (S.workspace) { try { appendFileSync(path.join(S.workspace, "steering.md"), `- ${new Date().toISOString()} ${text}\n`); } catch {} }
        send({ type: "say", agent: "lexi", text: `Heard: “${text}” — noted in steering.md. I'll apply it from the next agent run; a run mid-thought finishes its current phase first.` });
      } else {
        send({ type: "say", agent: "lexi", text: "Noted — but nothing's running right now. Give me an intent and that steering goes in from the start." });
      }
      return;
    }

    if (msg.type === "cancel" && activeRun) { activeRun.abort.abort(); send({ type: "sys", text: "— build cancelled by the human —" }); }
  });

  /* A closed/refreshed page must not kill the build — the run keeps going and
     the next connection replays it from eventLog. Only an explicit Cancel
     (or the bridge process dying) stops a run. */
  ws.on("close", () => { sockets.delete(ws); });
});

server.listen(PORT, HOST, () => {
  console.log(`lexi-bridge listening on http://${HOST}:${PORT} · runners=${Object.keys(RUNNERS).join(",")} (default ${DEFAULT_RUNNER}) · workspaces=${WORKSPACE_ROOT}`);
});

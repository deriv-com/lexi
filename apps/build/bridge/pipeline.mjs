/* The pipeline is MANAGED BY LEXI (the LLM), not by this code. Each turn a
   real runner run of Lexi sees the job state and returns ONE action —
   dispatch an agent with a playbook, ask the human a decision, request an
   approval, ship, or end. This module executes her choices faithfully and
   enforces only the guardrails: known agents/playbooks/elements, Forge
   blocked until a prototype approval exists, no ship without the human's
   ship approval, bounded steps and invalid turns. Workspaces are seeded by
   workspace.mjs from the bridge configuration. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { getRunner } from "./runners/index.mjs";
import { seedWorkspace, workspaceFor } from "./workspace.mjs";

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(BRIDGE_DIR, "prompts");
const PERSONAS_DIR = path.join(BRIDGE_DIR, "personas");
const MAX_INVALID = 3;
const FLEET_CONCURRENCY = 3;

export const PHASES = ["Intent", "Spec", "Plan", "Wireframe", "Prototype", "Build", "Review ⇄ Fix", "Your approval", "Ship"];
export const ELEMENTS = ["nav", "hero", "features", "pricing", "footer"];
export const PLAYBOOKS = {
  lexi: { spec: "spec", custom: null },
  scout: { competitors: "scout", reference: "scout-reference", custom: null },
  pixel: { wireframe: "pixel", prototype: "pixel-prototype", custom: null },
  forge: { region: "forge-region", integrate: "forge", fix: "forge", custom: null },
  data: { data: "data", custom: null },
  words: { words: "words", custom: null },
  check: { check: "check", custom: null },
  probe: { probe: "probe", custom: null },
};

export const renderPrompt = (name, vars = {}) => {
  let text = readFileSync(path.join(PROMPTS_DIR, name + ".md"), "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v ?? "");
  return text;
};
const persona = (agent) => {
  const f = path.join(PERSONAS_DIR, agent + ".md");
  return existsSync(f) ? readFileSync(f, "utf8") + "\n\n---\n\n" : "";
};

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

export function parseSpec(text) {
  const grab = (re) => (text.match(re) || [])[1]?.trim();
  const rules = [...text.matchAll(/^[-*]\s+(R\d+\s+.*)$/gm)].map((m) => m[1].trim());
  let decisions = [];
  const block = text.match(/<!--\s*lexi-decisions:\s*([\s\S]*?)-->/);
  if (block) { try { decisions = JSON.parse(block[1]); } catch { decisions = []; } }
  return {
    // Line-anchored, so prose that quotes the field names does not match first.
    audience: grab(/^\*\*For:\*\*\s*(.+)/m), coreJourney: grab(/^\*\*Core journey:\*\*\s*(.+)/m),
    rules, decisions,
    fallbackLines: text.split("\n").filter((l) => l.trim() && !l.startsWith("<!--")).slice(0, 8).map((l) => l.replace(/^#+\s*/, "").replace(/\*\*/g, "")),
  };
}

/**
 * Validates one dispatch against the playbook table and the guardrails.
 * Returns null when the dispatch may run, or the message Lexi gets back instead.
 */
export function checkDispatch(d, approvals) {
  const agent = String(d?.agent || "");
  const playbook = String(d?.playbook || "custom");
  if (!(agent in PLAYBOOKS)) return `INVALID dispatch: unknown agent "${agent}". Valid: ${Object.keys(PLAYBOOKS).join(", ")}.`;
  if (!(playbook in PLAYBOOKS[agent])) return `INVALID dispatch: ${agent} has no playbook "${playbook}". Valid: ${Object.keys(PLAYBOOKS[agent]).join(", ")}.`;
  if ((playbook === "region" || playbook === "integrate" || playbook === "fix") && !approvals.prototype)
    return `BLOCKED by guardrail: Forge playbook "${playbook}" needs a granted prototype approval first. Get a prototype in front of the human (pixel/prototype, then an approval action with kind "prototype") or choose other work.`;
  if (playbook === "region" && !ELEMENTS.includes(d?.element)) return `INVALID dispatch: region needs element one of ${ELEMENTS.join(", ")}.`;
  return null;
}

/* ================= Lexi manages the job (LLM-planned pipeline) =================
   There is no coded sequence. Each turn Lexi (a real runner run) sees the
   state and returns ONE action; this code executes it and reports back.
   Code's only jobs: execute faithfully, validate the action schema, enforce
   the guardrails (prototype approval before Forge, ship approval before
   ship, step budget), and keep the human's gates real. */

/**
 * ctx: { emit(ev), intent, signal, runnerId, steeringNotes(),
 *        askDecision({title, why, options}) -> index,
 *        askApproval({title, summary}) -> {verdict, instruction},
 *        config? (defaults to loadConfig()) }
 */
export async function runPipeline(ctx) {
  const { emit, intent, signal } = ctx;
  const cfg = ctx.config || loadConfig();
  const PHASE_TIMEOUT = cfg.phaseTimeoutMs;
  const MANAGER_TIMEOUT = Math.min(PHASE_TIMEOUT, 5 * 60 * 1000);
  const MAX_STEPS = cfg.maxSteps;
  const workspace = workspaceFor(intent, cfg.workspaceRoot);
  const say = (agent, text) => emit({ type: "say", agent, text });
  const phase = (name) => { if (PHASES.includes(name)) emit({ type: "phase", name }); };

  const runner = ctx.runner || getRunner(ctx.runnerId);
  let referenceApp = null;
  const REUSE_AGENTS = new Set(["scout", "pixel", "forge", "data", "words", "check", "probe"]);
  const steeringNote = () => {
    const notes = (ctx.steeringNotes ? ctx.steeringNotes() : []);
    return notes.length ? `\n\n## Human steering (instructions the human gave mid-build — honor these)\n${notes.map((n) => `- ${n}`).join("\n")}\n` : "";
  };
  const reuseNote = (agent) => referenceApp && REUSE_AGENTS.has(agent)
    ? `\n\n## ${cfg.referenceAppName} — reuse before you reinvent\n\`references/app/\` is a READ-ONLY symlink to ${cfg.referenceAppName}. Before writing code or claiming a production pattern, search it. Copy-and-adapt reusable code into this workspace (translate framework specifics to React + Vite), NEVER edit under \`references/app/\`, and log every copy in \`reused.md\` (source → destination → what changed). Claims from that code are "observed"; anything else is "inferred" — label them.\n`
    : "";

  const runRaw = async (agent, fullPrompt, timeoutMs = PHASE_TIMEOUT) => {
    const { json } = await runner.run({
      cwd: workspace, prompt: fullPrompt, timeoutMs, signal,
      onSay: (line) => line && say(agent, line),
    });
    return json || {};
  };
  const runWorker = (agent, playbookFile, vars, brief) =>
    runRaw(agent, persona(agent) + (playbookFile
      ? renderPrompt(playbookFile, { INTENT: intent, ...vars })
      : renderPrompt("worker", { AGENT_NAME: agent, BRIEF: brief })) + (brief && playbookFile && !("EXTRA" in vars) ? `\n\n## Lexi's brief for this dispatch\n${brief}\n` : "") + reuseNote(agent) + steeringNote());

  const applyEdits = (edits = [], agent = "forge") => {
    const done = [];
    for (const e of edits || []) {
      if (!e || !e.element || !e.html) continue;
      emit({ type: "move", agent, to: e.element });
      emit({ type: "edit", agent, element: e.element, html: e.html });
      done.push(e.element);
    }
    return done;
  };

  emit({ type: "project", name: intent.replace(/^build\s+/i, "").slice(0, 60), workspace });
  const seeded = seedWorkspace(workspace, cfg);
  writeFileSync(path.join(workspace, "intent.md"), `# Intent\n\n${intent}\n`);
  referenceApp = seeded.referenceApp;
  const seededBits = [
    "business spec",
    cfg.sourcesDir && "docs",
    cfg.designSystem.kind !== "none" && cfg.designSystem.kind !== "invalid" && "design system",
    cfg.mobbinMcpUrl && "Mobbin MCP",
    cfg.figmaMcpUrl && "Figma MCP",
    referenceApp && "reference app linked",
  ].filter(Boolean);
  emit({ type: "sys", text: `— workspace seeded · ${seededBits.join(" · ")} · Lexi manages this job herself —` });
  if (cfg.designSystem.kind === "invalid") emit({ type: "sys", text: `— ${cfg.designSystem.reason} · building without a design system —` });
  say("lexi", referenceApp
    ? `Workspace seeded, ${cfg.referenceAppName} linked for reuse. I'm managing this job myself — I'll assemble the crew and sequence the work as I see it, and bring you the decisions and approvals that are yours.`
    : "Workspace seeded. I'm managing this job myself — I'll assemble the crew and sequence the work as I see it, and bring you the decisions and approvals that are yours. (No reference app is linked, so claims about an existing product stay labelled inferred.)");

  /* spec on the table (Lexi reads the full file herself; this is the summary) */
  phase("Spec");
  const specPath = path.join(workspace, "business-spec.md");
  let spec = { audience: "", coreJourney: "", rules: [], decisions: [] };
  if (existsSync(specPath)) {
    spec = parseSpec(readFileSync(specPath, "utf8"));
    emit({ type: "artifact", card: "spec", lines: spec.audience || spec.rules.length ? [
      { kind: "text", text: `For: ${spec.audience || "—"}` },
      { kind: "text", text: `Core journey: ${spec.coreJourney || "—"}` },
      ...spec.rules.map((text) => ({ kind: "text", text })),
    ] : spec.fallbackLines.map((text) => ({ kind: "text", text })) });
  }

  const S = {
    log: [], built: new Set(), approvals: { prototype: false, ship: false },
    findingsOpen: 0, invalid: 0, decisionLines: [],
  };
  const summarise = (agent, json) => {
    const bits = [];
    if (json.summary) bits.push(String(json.summary));
    if (json.auditNote) bits.push(`audit: ${json.auditNote}`);
    if (json.wired) bits.push(String(json.wired));
    if (Array.isArray(json.patterns)) bits.push(`${json.patterns.length} patterns`);
    if (Array.isArray(json.findings)) bits.push(`${json.findings.length} findings${json.findings.length ? ": " + json.findings.slice(0, 3).map((f) => f.text).join(" | ") : ""}`);
    if (json.audience || json.rules) bits.push("spec written");
    return bits.join(" · ").slice(0, 500) || "no structured summary";
  };
  const absorb = (agent, json) => {
    if (Array.isArray(json.wireframe) && json.wireframe.length) emit({ type: "wireframe", sketches: json.wireframe });
    const edits = [...(Array.isArray(json.edits) ? json.edits : []), ...(json.edit ? [json.edit] : [])];
    for (const el of applyEdits(edits, agent)) S.built.add(el);
    if (Array.isArray(json.patterns)) {
      emit({ type: "artifact", card: "research", lines: [
        { kind: "text", text: `${agent} · ${json.sourceNote || json.auditNote || "findings"}` },
        ...json.patterns.map((text) => ({ kind: "text", text })),
      ]});
    }
    if (Array.isArray(json.match) || Array.isArray(json.beat) || Array.isArray(json.ignore)) {
      emit({ type: "artifact", card: "positioning", lines: [
        ...((json.match || []).map((text) => ({ kind: "match", text }))),
        ...((json.beat || []).map((text) => ({ kind: "beat", text }))),
        ...((json.ignore || []).map((text) => ({ kind: "ignore", text }))),
      ]});
    }
    if (Array.isArray(json.findings)) {
      S.findingsOpen = json.findings.length;
      for (const f of json.findings.slice(0, 4)) { emit({ type: "move", agent, to: f.element || "hero" }); emit({ type: "pin", element: f.element || "hero" }); if (f.text) say(agent, f.text); }
    }
    if (json.audience !== undefined || Array.isArray(json.rules)) {
      spec = { audience: json.audience || "", coreJourney: json.coreJourney || "", rules: json.rules || [], decisions: json.decisions || spec.decisions };
      emit({ type: "artifact", card: "spec", lines: [
        { kind: "text", text: `For: ${spec.audience || "—"}` },
        { kind: "text", text: `Core journey: ${spec.coreJourney || "—"}` },
        ...spec.rules.map((text) => ({ kind: "text", text })),
      ]});
    }
  };

  const stateText = (step) => {
    const mdFiles = readdirSync(workspace).filter((f) => f.endsWith(".md"));
    const asked = S.log.filter((l) => l.startsWith("DECISION")).map((l) => l.slice(9).split(" →")[0]);
    const pendingDecisions = (spec.decisions || []).filter((d) => !asked.includes(d.title));
    return [
      `Step ${step} of max ${MAX_STEPS} (${MAX_STEPS - step} left).`,
      `Spec: ${existsSync(specPath) ? "business-spec.md present" : "MISSING — nobody can build without it"}${spec.audience ? ` · for ${spec.audience}` : ""}${spec.coreJourney ? ` · journey: ${spec.coreJourney}` : ""}`,
      spec.rules.length ? `Spec rules: ${spec.rules.join(" | ")}` : "",
      pendingDecisions.length ? `Spec decisions NOT yet asked of the human: ${pendingDecisions.map((d) => d.title).join(" | ")}` : "",
      `Approvals granted: prototype=${S.approvals.prototype ? "yes" : "no"}, ship=${S.approvals.ship ? "yes" : "no"}.`,
      `Screen regions edited so far: ${[...S.built].join(", ") || "none"}. Open findings from last review: ${S.findingsOpen}.`,
      `Workspace .md files: ${mdFiles.join(", ") || "none"}.`,
      referenceApp ? `${cfg.referenceAppName} is linked at references/app (reuse before reinventing).` : "No reference app is linked.",
      cfg.mobbinMcpUrl ? "Mobbin MCP is configured for competitor research." : "Mobbin MCP is not configured; competitor research comes from agent knowledge and must say so.",
      S.log.length ? `Actions so far:\n${S.log.map((l, i) => `${i + 1}. ${l}`).join("\n")}` : "Actions so far: none — you are opening this job.",
    ].filter(Boolean).join("\n");
  };

  const doDispatch = async (d) => {
    const refused = checkDispatch(d, S.approvals);
    if (refused) return refused;
    const agent = String(d.agent);
    const playbook = String(d.playbook || "custom");
    const brief = String(d.brief || "");
    emit({ type: "summon", agent, reason: `dispatched by Lexi · ${playbook}` });
    emit({ type: "sys", text: `— Lexi dispatched ${agent} · ${playbook}${d.element ? ` · ${d.element}` : ""}${brief ? ` · ${brief.slice(0, 110)}` : ""} —` });
    let vars = {};
    const file = PLAYBOOKS[agent][playbook];
    if (playbook === "region") vars = { REGION: d.element, REGION_LABEL: d.element };
    if (file === "forge" || file === "pixel-prototype") vars = { ...vars, EXTRA: brief };
    /* A failed worker (timeout, crash) is a RESULT Lexi manages around —
       only a human cancel is allowed to kill the whole job. */
    let json;
    try {
      json = await runWorker(agent, file, vars, brief);
    } catch (e) {
      if (e.code === "CANCELLED") throw e;
      emit({ type: "sys", text: `— ${agent} dispatch failed: ${e.message} —` });
      return `FAILED: ${e.message} — decide: retry with a narrower brief, reassign, or move on.`;
    }
    absorb(agent, json);
    return summarise(agent, json);
  };

  const doShip = async () => {
    phase("Ship");
    if (!existsSync(path.join(workspace, "dist", "index.html")) && !existsSync(path.join(workspace, "index.html")))
      emit({ type: "sys", text: "— warning: no built app found in the workspace (neither dist/ nor index.html) · preview will 404 until the build exists —" });
    writeFileSync(path.join(workspace, "SHIPPED.md"), `# Shipped\n\nIntent: ${intent}\nManaged by Lexi (LLM-planned pipeline), approved by the human at the Table.\nOpen findings at ship: ${S.findingsOpen}\n\n## How we got here\n${S.log.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n`);
    emit({ type: "ship", workspace, preview: `/preview/${path.basename(workspace)}/` });
    say("lexi", "Shipped. The preview is live, and SHIPPED.md in the workspace tells the whole story of how we got here.");
    emit({ type: "done" });
  };

  let finished = false;
  for (let step = 1; step <= MAX_STEPS && !finished; step++) {
    const decision = await runRaw("lexi", persona("lexi") + renderPrompt("lexi-manager", { INTENT: intent }) + `\n\n## Current state\n${stateText(step)}\n` + steeringNote(), MANAGER_TIMEOUT);
    const action = decision?.action;
    if (decision?.say) say("lexi", String(decision.say));
    if (decision?.phase) phase(String(decision.phase));
    if (!action || typeof action !== "object" || !action.type) {
      S.invalid++;
      S.log.push(`MANAGER produced no valid action (invalid ${S.invalid}/${MAX_INVALID}) — asked to decide again.`);
      if (S.invalid >= MAX_INVALID) { emit({ type: "sys", text: "— Lexi couldn't settle on a valid action; stopping and handing back to you —" }); break; }
      continue;
    }
    S.invalid = 0;
    switch (action.type) {
      case "dispatch": {
        const result = await doDispatch(action);
        S.log.push(`DISPATCH ${action.agent}/${action.playbook}${action.element ? ` (${action.element})` : ""} → ${result}`);
        break;
      }
      case "dispatch_many": {
        const list = (Array.isArray(action.dispatches) ? action.dispatches : []).slice(0, 3);
        if (!list.length) { S.log.push("DISPATCH_MANY with no dispatches — invalid, decide again."); S.invalid++; break; }
        const results = await mapLimit(list, FLEET_CONCURRENCY, (d) => doDispatch(d));
        list.forEach((d, i) => S.log.push(`DISPATCH ${d.agent}/${d.playbook}${d.element ? ` (${d.element})` : ""} → ${results[i]}`));
        break;
      }
      case "decision": {
        const options = Array.isArray(action.options) ? action.options : [];
        if (!options.length) { S.log.push("DECISION with no options — invalid, decide again."); S.invalid++; break; }
        const idx = await ctx.askDecision({ title: String(action.title || "Decision"), why: String(action.why || ""), options });
        const chosen = options[idx] || options[0];
        S.decisionLines.push({ kind: "decision", text: `You: ${action.title} → ${chosen.label}` });
        emit({ type: "artifact", card: "decisions", lines: [...S.decisionLines] });
        writeFileSync(path.join(workspace, "decisions.md"), S.decisionLines.map((l) => `- ${l.text}`).join("\n") + "\n");
        S.log.push(`DECISION ${action.title} → human chose "${chosen.label}"`);
        break;
      }
      case "approval": {
        const kind = ["prototype", "ship", "other"].includes(action.kind) ? action.kind : "other";
        const v = await ctx.askApproval({ title: String(action.title || "Your approval needed"), summary: String(action.summary || "") });
        if (kind !== "other") S.approvals[kind] = v.verdict === "approve";
        S.log.push(`APPROVAL (${kind}) ${action.title || ""} → human: ${v.verdict}${v.instruction ? ` · instruction: "${v.instruction}"` : ""}`);
        break;
      }
      case "ship": {
        if (!S.approvals.ship) {
          emit({ type: "sys", text: "— guardrail: ship needs the human's ship approval first · asking now —" });
          const v = await ctx.askApproval({ title: "Your approval needed — Ship is locked.", summary: String(action.summary || `Open findings: ${S.findingsOpen} · regions edited: ${[...S.built].join(", ") || "none"} · workspace: ${workspace}`) });
          S.approvals.ship = v.verdict === "approve";
          S.log.push(`APPROVAL (ship, via guardrail) → human: ${v.verdict}${v.instruction ? ` · instruction: "${v.instruction}"` : ""}`);
          if (!S.approvals.ship) break;
        }
        S.log.push("SHIP → shipped by Lexi after human approval");
        await doShip();
        finished = true;
        break;
      }
      case "done": {
        S.log.push(`DONE → ${String(action.summary || "ended by Lexi")}`);
        if (action.summary) say("lexi", String(action.summary));
        emit({ type: "done" });
        finished = true;
        break;
      }
      default:
        S.invalid++;
        S.log.push(`MANAGER chose unknown action "${action.type}" (invalid ${S.invalid}/${MAX_INVALID}) — asked to decide again.`);
        if (S.invalid >= MAX_INVALID) { emit({ type: "sys", text: "— Lexi kept choosing unknown actions; stopping and handing back to you —" }); finished = true; }
    }
  }
  if (!finished) {
    say("lexi", `I've used my ${MAX_STEPS} management steps without shipping — handing the call to you rather than circling.`);
    const v = await ctx.askApproval({ title: "Step budget reached — ship what stands?", summary: `Regions edited: ${[...S.built].join(", ") || "none"} · open findings: ${S.findingsOpen} · workspace: ${workspace}` });
    if (v.verdict === "approve") { S.approvals.ship = true; await doShip(); }
    else emit({ type: "done" });
  }
}

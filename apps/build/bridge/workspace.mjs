/* Workspace seeding: everything an agent needs before its first run.
   Each build gets `<workspaceRoot>/<slug>/` with the Business Spec, the
   user's canonical docs (optional), the design system (optional, pluggable),
   the vendored skills, house rules, MCP settings (optional) and a reference
   app linked read-only (optional). Steering lives in `.lexi/steering/`;
   `AGENTS.md` and `CLAUDE.md` index it for runners that read those, and a
   copy goes to `.kiro/` because Kiro loads its steering from there. */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = ["taste", "hallmark"];
// The repository-level prototype skill, when the bridge runs from a checkout of this repo.
const PROTOTYPE_SKILL = path.resolve(BRIDGE_DIR, "..", "..", "..", "skills", "prototype");

export const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "untitled-product";

export function workspaceFor(intent, root = path.join(os.homedir(), "LexiBuilds")) {
  return path.join(root, slugify(intent));
}

/** The seed `package.json`: React 19 + Vite, plus the design-system package when one is configured. */
export function seedPackageJson(designSystem) {
  const pkg = JSON.parse(readFileSync(path.join(BRIDGE_DIR, "seed", "package.json"), "utf8"));
  if (designSystem?.kind === "package") pkg.dependencies = { ...pkg.dependencies, [designSystem.name]: designSystem.version === "latest" ? "*" : designSystem.version };
  return pkg;
}

/** Steering text for the design system, whatever form it was supplied in. */
export function designSystemSteering(designSystem) {
  switch (designSystem?.kind) {
    case "file":
    case "dir":
      return null; // the user's own document is copied in verbatim
    case "package":
      return `# Design system — mandatory kit\n\nThis product uses the \`${designSystem.name}\` package (in \`package.json\`).\n\n- Read its type definitions and README in \`node_modules/${designSystem.name}/\` before using any component.\n- Use its components and tokens. Never invent a colour, spacing or type value it already defines.\n- If a component you need does not exist in it, build the smallest one you can from its tokens and say so in your summary.\n`;
    default:
      return "# Design system — none configured\n\nNo design system was supplied (set `LEXI_DESIGN_SYSTEM` in the bridge environment to a markdown file, a folder, or an npm package name).\n\n- Define a small token layer yourself (CSS custom properties for colour, type, spacing, radius) and use only those tokens.\n- Follow the hallmark and taste skills for composition. Say in your summary that the kit is improvised.\n";
  }
}

function copyDesignSystem(designSystem, steeringDir) {
  const target = path.join(steeringDir, "design-system");
  if (designSystem.kind === "file") {
    copyFileSync(designSystem.path, path.join(steeringDir, "design-system.md"));
    return;
  }
  cpSync(designSystem.path, target, { recursive: true, force: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
  const docs = readdirSync(target).filter((f) => f.endsWith(".md"));
  writeFileSync(path.join(steeringDir, "design-system.md"),
    `# Design system — mandatory kit\n\nThe design system is in \`design-system/\` next to this file. Read ${docs.length ? docs.map((d) => `\`design-system/${d}\``).join(", ") : "its contents"} before designing or building anything, and use only its tokens and components.\n`);
}

function houseRules(cfg) {
  return [
    "# Lexi's table — house rules",
    "",
    "- `business-spec.md` (workspace root) is the source of truth; it outranks competitors, skills and taste.",
    `- Skills live in \`.lexi/skills/\` (${SKILLS.join(", ")}, and prototype when present). Read the relevant SKILL.md before designing or building UI.`,
    "- The design system (`.lexi/steering/design-system.md`) is the kit: tokens and components come from it.",
    cfg.sourcesDir ? "- Canonical documents are in `docs/` (see `.lexi/steering/sources.md`). API shapes come only from them; never invent a payload." : "- There are no canonical documents in `docs/`. Never invent an API payload: stub it, and say it is a stub.",
    cfg.referenceAppDir ? `- \`references/app/\` is ${cfg.referenceAppName}, linked READ-ONLY (see \`.lexi/steering/reference-app.md\`).` : "- No reference app is linked; label any claim about an existing product as inferred.",
    "- Print @@SAY@@ progress lines and finish with the lexi-json block your prompt specifies.",
    "",
  ].join("\n");
}

function referenceSteering(cfg) {
  return cfg.referenceAppDir
    ? `# ${cfg.referenceAppName} — reuse before you reinvent\n\n\`references/app/\` is ${cfg.referenceAppName}, symlinked READ-ONLY.\n\n- Before writing a component, hook, util or pattern, search \`references/app/\` for an existing one.\n- Copy-and-adapt what's reusable into this workspace; translate framework specifics to this app's React + Vite stack.\n- NEVER edit, create or delete anything under \`references/app/\` — copy out first.\n- Log every reuse in \`reused.md\` (workspace root): source path → destination → what you changed.\n- Scout: code you read there is \`observed\` evidence; everything else is \`inferred\`.\n`
    : "# Reference app — not configured\n\nNo reference app is linked (set `LEXI_REFERENCE_APP_DIR` in the bridge environment to enable code reuse). Do not claim a production pattern is observed — label it inferred.\n";
}

/** MCP servers every runner can see: `.lexi/mcp.json`, `.mcp.json` (Claude Code, Cursor) and `.kiro/settings/mcp.json`. */
export function mcpServers(cfg) {
  const servers = {};
  if (cfg.mobbinMcpUrl) servers.mobbin = { type: "http", url: cfg.mobbinMcpUrl };
  if (cfg.figmaMcpUrl) servers.figma = { type: "http", url: cfg.figmaMcpUrl };
  return servers;
}

/**
 * Seeds `workspace` from `cfg` (see config.mjs). Idempotent: an existing spec or
 * package.json is kept, so re-running an intent continues the same workspace.
 */
export function seedWorkspace(workspace, cfg) {
  mkdirSync(workspace, { recursive: true });
  const seededSpecPath = path.join(workspace, "business-spec.md");
  const freshSpec = !existsSync(seededSpecPath);
  if (freshSpec) copyFileSync(cfg.businessSpec || path.join(BRIDGE_DIR, "seed", "business-spec.md"), seededSpecPath);

  if (cfg.sourcesDir) cpSync(cfg.sourcesDir, path.join(workspace, "docs"), { recursive: true, force: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });

  const lexiDir = path.join(workspace, ".lexi");
  const steering = path.join(lexiDir, "steering");
  mkdirSync(path.join(lexiDir, "skills"), { recursive: true });
  mkdirSync(steering, { recursive: true });
  for (const skill of SKILLS) cpSync(path.join(BRIDGE_DIR, "skills", skill), path.join(lexiDir, "skills", skill), { recursive: true, force: true });
  if (existsSync(path.join(PROTOTYPE_SKILL, "SKILL.md"))) cpSync(PROTOTYPE_SKILL, path.join(lexiDir, "skills", "prototype"), { recursive: true, force: true });
  copyFileSync(path.join(BRIDGE_DIR, "skills", "taste", "SKILL.md"), path.join(steering, "taste-skill.md"));
  copyFileSync(path.join(BRIDGE_DIR, "skills", "hallmark", "SKILL.md"), path.join(steering, "hallmark.md"));

  const ds = cfg.designSystem || { kind: "none" };
  const dsText = designSystemSteering(ds);
  if (dsText) writeFileSync(path.join(steering, "design-system.md"), dsText);
  else copyDesignSystem(ds, steering);

  writeFileSync(path.join(steering, "lexi-table.md"), houseRules(cfg));
  writeFileSync(path.join(steering, "reference-app.md"), referenceSteering(cfg));
  if (cfg.sourcesDir) writeFileSync(path.join(steering, "sources.md"),
    "# Canonical sources (in `docs/`)\n\nCopied from the folder named by `LEXI_SOURCES_DIR` at the start of the build. They outrank your own knowledge: build and review against them, and take endpoints and payloads only from them. List what you read in your summary.\n");

  const mcp = { mcpServers: mcpServers(cfg) };
  writeFileSync(path.join(lexiDir, "mcp.json"), JSON.stringify(mcp, null, 2) + "\n");
  writeFileSync(path.join(workspace, ".mcp.json"), JSON.stringify(mcp, null, 2) + "\n");

  const steeringFiles = readdirSync(steering).filter((f) => f.endsWith(".md")).sort();
  const index = `# Agent instructions\n\nThis is a Lexi·Build product workspace. Before any work, read:\n\n${steeringFiles.map((f) => `- \`.lexi/steering/${f}\``).join("\n")}\n\nSkills are in \`.lexi/skills/\`.\n`;
  writeFileSync(path.join(workspace, "AGENTS.md"), index);
  writeFileSync(path.join(workspace, "CLAUDE.md"), index);

  /* Kiro loads `.kiro/steering` and `.kiro/settings/mcp.json` on its own. */
  const kiro = path.join(workspace, ".kiro");
  cpSync(steering, path.join(kiro, "steering"), { recursive: true, force: true });
  cpSync(path.join(lexiDir, "skills"), path.join(kiro, "skills"), { recursive: true, force: true });
  mkdirSync(path.join(kiro, "settings"), { recursive: true });
  writeFileSync(path.join(kiro, "settings", "mcp.json"), JSON.stringify(mcp, null, 2) + "\n");

  if (!existsSync(path.join(workspace, "package.json"))) writeFileSync(path.join(workspace, "package.json"), JSON.stringify(seedPackageJson(ds), null, 2) + "\n");

  const refs = path.join(workspace, "references");
  mkdirSync(refs, { recursive: true });
  if (!existsSync(path.join(refs, "README.md"))) writeFileSync(path.join(refs, "README.md"),
    "# References\n\nDrop screenshots and notes of an existing product here — Scout studies them.\n");
  const link = path.join(refs, "app");
  if (cfg.referenceAppDir && !existsSync(link) && statSync(cfg.referenceAppDir).isDirectory()) {
    try { symlinkSync(cfg.referenceAppDir, link, "dir"); } catch { /* reported by the steering file */ }
  }
  return { freshSpec, referenceApp: cfg.referenceAppDir && existsSync(link) ? cfg.referenceAppDir : null };
}

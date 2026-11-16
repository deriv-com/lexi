#!/usr/bin/env node
/**
 * Regenerates the marker-delimited graph block in PROGRAMME_LIFECYCLE.md from
 * the live programme state machines, so the committed diagrams can never
 * describe a transition the runtime does not permit.
 *
 * Usage:
 *   npm run graph:programme -w @lexi/programme             # write the section
 *   npm run graph:programme -w @lexi/programme -- --check  # exit 1 if stale
 *
 * Same in-memory swc transpile approach as
 * packages/workitems/scripts/generate-work-item-graph.mjs: the generator
 * reads the same source the drift test reads, so the two can never disagree
 * about what "in sync" means.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { transformSync } from "@swc/core";

const require = createRequire(import.meta.url);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const docPath = resolve(packageRoot, "PROGRAMME_LIFECYCLE.md");

/** Transpile one TS file to CJS in a temp dir, rewriting relative TS imports. */
function compile(outDir, relativePath) {
  const source = readFileSync(resolve(packageRoot, "src", relativePath), "utf8");
  const { code } = transformSync(source, {
    filename: relativePath,
    jsc: { parser: { syntax: "typescript" }, target: "es2021" },
    module: { type: "commonjs" },
  });
  const outPath = join(outDir, relativePath.replace(/\//g, "__").replace(/\.ts$/, ".cjs"));
  // Flattened filenames, so relative imports must be flattened to match.
  writeFileSync(
    outPath,
    code
      .replace(/require\("\.\.\/programme-state-machine"\)/g, 'require("./programme-state-machine.cjs")')
      .replace(/require\("\.\.\/milestone-state-machine"\)/g, 'require("./milestone-state-machine.cjs")')
      .replace(/require\("\.\.\/build-task-state-machine"\)/g, 'require("./build-task-state-machine.cjs")')
      .replace(/require\("@lexi\/contracts"\)/g, "({})"),
    "utf8",
  );
  return outPath;
}

const outDir = mkdtempSync(join(tmpdir(), "programme-graph-"));
compile(outDir, "programme-state-machine.ts");
compile(outDir, "milestone-state-machine.ts");
compile(outDir, "build-task-state-machine.ts");
const graphModulePath = compile(outDir, "graph/programme-graph.ts");

// createRequire, not import(): swc's CJS output uses `_export` helpers that
// Node's named-export detection for .cjs cannot see through.
const { applyProgrammeGraphSection } = require(graphModulePath);

const markdown = readFileSync(docPath, "utf8");
const result = applyProgrammeGraphSection(markdown);

if (!result.updatedContent) {
  console.error(`✗ ${result.reason}`);
  process.exit(1);
}

if (process.argv.includes("--check")) {
  if (result.inSync) {
    console.log("✓ PROGRAMME_LIFECYCLE.md is in sync with the programme state machines.");
    process.exit(0);
  }
  console.error(`✗ ${result.reason}`);
  console.error("  Run `npm run graph:programme -w @lexi/programme` to regenerate.");
  process.exit(1);
}

if (result.inSync) {
  console.log("✓ PROGRAMME_LIFECYCLE.md already in sync — nothing to write.");
  process.exit(0);
}

writeFileSync(docPath, result.updatedContent, "utf8");
console.log("✓ Regenerated the programme graph in PROGRAMME_LIFECYCLE.md.");

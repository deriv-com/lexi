#!/usr/bin/env node
/**
 * Regenerates the marker-delimited graph block in WORK_ITEM_LIFECYCLE.md from
 * the live `WorkItemStateMachine`, so the committed diagram can never describe
 * a transition the runtime does not permit.
 *
 * Usage:
 *   npm run graph:workitem -w @lexi/workitems           # write the section
 *   npm run graph:workitem -w @lexi/workitems -- --check   # exit 1 if stale
 *
 * The TypeScript sources are transpiled in-memory with swc (already a repo
 * dependency, via unplugin-swc) rather than read from `dist/`. That keeps the
 * generator runnable without a build step — and, more importantly, means it
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
const docPath = resolve(packageRoot, "WORK_ITEM_LIFECYCLE.md");

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
      .replace(/require\("\.\.\/work-item-state-machine"\)/g, 'require("./work-item-state-machine.cjs")')
      .replace(/require\("@lexi\/contracts"\)/g, "({})"),
    "utf8",
  );
  return outPath;
}

const outDir = mkdtempSync(join(tmpdir(), "workitem-graph-"));
compile(outDir, "work-item-state-machine.ts");
const graphModulePath = compile(outDir, "graph/work-item-graph.ts");

// createRequire, not import(): swc's CJS output uses `_export` helpers that
// Node's named-export detection for .cjs cannot see through.
const { applyWorkItemGraphSection } = require(graphModulePath);

const markdown = readFileSync(docPath, "utf8");
const result = applyWorkItemGraphSection(markdown);

if (!result.updatedContent) {
  console.error(`✗ ${result.reason}`);
  process.exit(1);
}

if (process.argv.includes("--check")) {
  if (result.inSync) {
    console.log("✓ WORK_ITEM_LIFECYCLE.md is in sync with WorkItemStateMachine.");
    process.exit(0);
  }
  console.error(`✗ ${result.reason}`);
  console.error("  Run `npm run graph:workitem -w @lexi/workitems` to regenerate.");
  process.exit(1);
}

if (result.inSync) {
  console.log("✓ WORK_ITEM_LIFECYCLE.md already in sync — nothing to write.");
  process.exit(0);
}

writeFileSync(docPath, result.updatedContent, "utf8");
console.log("✓ Regenerated the work item graph in WORK_ITEM_LIFECYCLE.md.");

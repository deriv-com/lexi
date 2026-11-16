/**
 * Regenerate docs/capability-matrix.md from the live tool modules.
 *
 * The document is rendered, never hand-edited, so it cannot drift: the spec
 * apps/server/src/capability/capability-matrix.spec.ts fails when the
 * committed file differs from what the modules would render. It covers the
 * opt-in modules (app-build, programme) as if enabled.
 *
 * Usage (builds first):  npm run docs:capability-matrix
 *            check only:  node scripts/generate-capability-matrix.mjs --check
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { buildCapabilitySnapshot } = require(resolve(repoRoot, "packages/agent-tools/dist/capability-snapshot.js"));
const { capabilityProblems, renderCapabilityMatrix } = require(resolve(repoRoot, "packages/governance/dist/index.js"));

const target = resolve(repoRoot, "docs/capability-matrix.md");
const { allToolModules } = require(resolve(repoRoot, "apps/server/dist/capability/all-tool-modules.js"));
const snapshot = buildCapabilitySnapshot({ modules: allToolModules() });
const problems = capabilityProblems(snapshot);
for (const problem of problems) console.warn(`! ${problem}`);

const rendered = renderCapabilityMatrix(snapshot);
const current = existsSync(target) ? readFileSync(target, "utf8") : null;

if (current === rendered) {
  console.log("docs/capability-matrix.md is up to date.");
} else if (process.argv.includes("--check")) {
  console.error("docs/capability-matrix.md is stale. Run `npm run docs:capability-matrix`.");
  process.exit(1);
} else {
  writeFileSync(target, rendered, "utf8");
  console.log("Regenerated docs/capability-matrix.md.");
}

const tools = snapshot.modules.flatMap((m) => m.tools);
console.log(`  ${snapshot.modules.length} modules, ${tools.length} tools, ${snapshot.actionClasses.length} classified actions.`);
if (problems.length) process.exit(1);

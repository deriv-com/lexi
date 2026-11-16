#!/usr/bin/env node
// Fails when an installed dependency's licence is not on the permissive allowlist below.
// Reads `npm query`, so it sees exactly what npm installed, including transitive packages.
//
// Usage: node scripts/check-licenses.mjs [--all]
//   Default checks runtime (non-dev) dependencies, which are what ships. --all adds dev tooling.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
  "BlueOak-1.0.0",
  "Python-2.0",
]);

/** Normalises the shapes package.json uses for licences into one SPDX-ish string. */
export function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    const types = pkg.licenses.map((l) => (typeof l === "string" ? l : l.type)).filter(Boolean);
    return types.length > 1 ? `(${types.join(" OR ")})` : types[0];
  }
  return undefined;
}

/** True when an SPDX expression is satisfiable from the allowlist (any OR branch, every AND term). */
export function isAllowed(expr) {
  if (!expr) return false;
  const clean = expr.replace(/[()]/g, " ").trim();
  return clean
    .split(/\s+OR\s+/i)
    .some((branch) => branch.split(/\s+AND\s+/i).every((term) => ALLOWED.has(term.trim())));
}

function main(argv) {
  const selector = argv.includes("--all") ? "*" : ".prod";
  const out = execFileSync("npm", ["query", selector], {
    cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const pkgs = JSON.parse(out).filter((p) => p.name && !p.isWorkspace && p.location !== "");
  const bad = pkgs
    .map((p) => ({ name: p.name, version: p.version, license: licenseOf(p) }))
    .filter((p) => !isAllowed(p.license));

  for (const p of bad) console.log(`${p.name}@${p.version}: ${p.license ?? "no licence field"}`);
  console.log(`licenses: ${pkgs.length} ${selector === "*" ? "" : "runtime "}packages checked, ${bad.length} not allowed`);
  if (bad.length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

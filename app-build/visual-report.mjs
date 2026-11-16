// Scores the builder's screenshots against the prototype's.
//
// usage: node visual-report.mjs <shots-dir> <out-dir>
//
// The builder's own Playwright suite (`lexi:visual`) visits every route in
// BOTH apps and writes pairs named `<screen>__app__<viewport>.png` and
// `<screen>__prototype__<viewport>.png`. This script owns the measurement, so
// the number in the PR comment is never computed by the code it grades.
//
// Writes <out-dir>/visual.json and, for every pair, a diff image
// <out-dir>/<screen>__diff__<viewport>.png. Mismatch is the share of pixels
// pixelmatch flags in the overlapping area; a height difference is reported
// separately, because a page that is 400px shorter is a finding on its own.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(join(process.env.LEXI_TOOLS_DIR ?? process.cwd(), "package.json"));
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch").default ?? require("pixelmatch");

const [shotsDir, outDir] = process.argv.slice(2);
if (!shotsDir || !outDir) {
  console.error("usage: visual-report.mjs <shots-dir> <out-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const pairs = new Map();
if (existsSync(shotsDir)) {
  for (const file of readdirSync(shotsDir)) {
    const m = /^(.+)__(app|prototype)__(.+)\.png$/.exec(file);
    if (!m) continue;
    const key = `${m[1]}__${m[3]}`;
    const entry = pairs.get(key) ?? { screen: m[1], viewport: m[3] };
    entry[m[2]] = join(shotsDir, file);
    pairs.set(key, entry);
  }
}

function crop(png, width, height) {
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    png.data.copy(out.data, y * width * 4, y * png.width * 4, y * png.width * 4 + width * 4);
  }
  return out;
}

const results = [];
for (const entry of [...pairs.values()].sort((a, b) => `${a.screen}${a.viewport}`.localeCompare(`${b.screen}${b.viewport}`))) {
  if (!entry.app || !entry.prototype) {
    results.push({ ...entry, status: entry.app ? "no prototype shot" : "no app shot" });
    continue;
  }
  const a = PNG.sync.read(readFileSync(entry.app));
  const p = PNG.sync.read(readFileSync(entry.prototype));
  const width = Math.min(a.width, p.width);
  const height = Math.min(a.height, p.height);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(crop(a, width, height).data, crop(p, width, height).data, diff.data, width, height, {
    threshold: 0.1,
  });
  const diffPath = join(outDir, `${entry.screen}__diff__${entry.viewport}.png`);
  writeFileSync(diffPath, PNG.sync.write(diff));
  results.push({
    screen: entry.screen,
    viewport: entry.viewport,
    status: "compared",
    mismatchPct: Number(((changed / (width * height)) * 100).toFixed(2)),
    appSize: `${a.width}x${a.height}`,
    prototypeSize: `${p.width}x${p.height}`,
    heightDelta: a.height - p.height,
    app: entry.app,
    prototype: entry.prototype,
    diff: diffPath,
  });
}

writeFileSync(join(outDir, "visual.json"), JSON.stringify(results, null, 2));
const compared = results.filter((r) => r.status === "compared");
console.log(`visual: ${compared.length} pairs compared, ${results.length - compared.length} unpaired`);

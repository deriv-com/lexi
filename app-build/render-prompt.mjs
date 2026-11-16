// usage: node render-prompt.mjs <template> <out>
// Replaces __NAME__ in the template with the content of the file named by
// process.env.PROMPT_NAME_FILE when that is set, else with process.env.PROMPT_NAME.
// Large values (feedback, assessment, ...) come as files so they never sit in
// the environment of this process or of the builder. A _FILE that cannot be
// read fails the render without writing <out>; the message names the variable
// only. Done in node, not sed, because the feedback text is written by people
// and can hold any character sed treats as special.
import { readFileSync, writeFileSync } from "node:fs";

const [template, out] = process.argv.slice(2);
const values = new Map();
const value = (name) => {
  if (values.has(name)) return values.get(name);
  let result = process.env[`PROMPT_${name}`];
  const file = process.env[`PROMPT_${name}_FILE`];
  if (file !== undefined) {
    try {
      result = readFileSync(file, "utf8");
    } catch {
      process.stderr.write(`render-prompt: cannot read PROMPT_${name}_FILE\n`);
      process.exit(1);
    }
  }
  values.set(name, result);
  return result;
};
const text = readFileSync(template, "utf8").replace(
  /__([A-Z_]+)__/g,
  (whole, name) => {
    const v = value(name);
    return v === undefined ? whole : v;
  },
);
writeFileSync(out, text);

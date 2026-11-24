#!/usr/bin/env node
// Fails when the repository contains something that looks like an internal identifier or a
// credential. Two rule sets:
//
//   - Built-in rules below: generic shapes (chat workspace IDs, private keys, API tokens) that
//     are safe to publish.
//   - Private rules: organisation-specific names, hosts and people. They are deliberately NOT
//     in this repository, because the list itself would publish what it guards against. They
//     come from LEAK_SCAN_PATTERNS (newline-separated, set from a CI secret), the file named by
//     LEAK_SCAN_PATTERNS_FILE, or a git-ignored `.leak-patterns.local`. One regex per line,
//     matched case-insensitively; blank lines and `#` comments are ignored.
//
// Usage: node scripts/leak-scan.mjs [--require-private] [--report-only] [--metadata] [path ...]
//   With no paths, scans every tracked and untracked-but-not-ignored file.
//   --metadata         scan commit and pull-request metadata instead of files: each commit's
//                      author and committer email and its message, for the commits in
//                      LEAK_SCAN_COMMIT_RANGE (default: all of HEAD), plus PR_TITLE, PR_BODY and
//                      PR_HEAD_REF when set. Author names are not scanned: a contributor's own
//                      public identity is not a leak. GitHub noreply addresses are not scanned
//                      either, since they only carry the public login.
//   --require-private  fail when no private rules were loaded (CI uses this, so a missing
//                      secret fails loudly instead of silently scanning with half the rules).
//   --report-only      print findings but exit 0 (used by the copy script to triage).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MAX_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);

export const BUILT_IN_RULES = [
  // Slack user, channel, group, DM and user-group IDs: a type letter and 8-11
  // more uppercase letters or digits, at least one a digit. Older workspaces
  // issue IDs that do not start with 0 (e.g. "UD..."), so the second character
  // is not fixed. Fictional IDs in this repository contain TEST (U0TEST01).
  { name: "slack-id", re: /\b(?![CUWGDS]0?TEST)[CUWGDS](?=[A-Z]*[0-9])[0-9A-Z]{8,11}\b/ },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "llm-api-key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
];

/** Parses a newline-separated pattern list into case-insensitive rules. */
export function parsePrivateRules(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    rules.push({ name: "private", re: new RegExp(line, "i") });
  }
  return rules;
}

/**
 * Parses `.leak-scan-allow`. Each entry is `<path glob> | <literal text>  # reason`: a finding is
 * allowed when its file matches the glob and its line contains the literal text. With --metadata
 * the "file" is the entry's name: `commit <sha>`, `pull request branch`, `pull request title` or
 * `pull request body`.
 */
export function parseAllowlist(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const bar = line.indexOf("|");
    if (bar < 0) throw new Error(`.leak-scan-allow: expected "<glob> | <text>", got: ${raw}`);
    entries.push({ path: globToRegExp(line.slice(0, bar).trim()), text: line.slice(bar + 1).trim() });
  }
  return entries;
}

export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** Returns one finding per rule match per line, skipping allowlisted ones. */
export function scanText(file, text, rules, allowlist = []) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const allowed = allowlist.some((a) => a.path.test(file) && line.includes(a.text));
      if (!allowed) findings.push({ file, line: i + 1, rule: rule.name, match: m[0] });
    }
  });
  return findings;
}

/** Shows enough of a match to find it without printing a credential into CI logs. */
export function redact(match) {
  return match.length <= 6 ? match : `${match.slice(0, 4)}…(${match.length} chars)`;
}

const NOREPLY_EMAIL = /\b(?:\d+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com\b/g;
// GitHub writes "Merge pull request #N from <owner>/<branch>" for merge commits. The owner is
// this repository's own organisation, so only the branch name after it is worth scanning.
const MERGE_SOURCE = /^(Merge pull request #\d+ from )[^/\s]+\//;

/** Removes the parts of commit metadata that are public by construction. */
export function normaliseMetadata(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(NOREPLY_EMAIL, "<noreply>").replace(MERGE_SOURCE, "$1"))
    .join("\n");
}

const FIELD = "\x1f";
const RECORD = "\x1e";
/** `git log` format read by parseCommitLog: sha, author email, committer email, message. */
export const COMMIT_LOG_FORMAT = `%H${FIELD}%ae${FIELD}%ce${FIELD}%B${RECORD}`;

/** Turns `git log --format=COMMIT_LOG_FORMAT` output into scannable entries. */
export function parseCommitLog(out) {
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, authorEmail, committerEmail, message = ""] = r.split(FIELD);
      return {
        file: `commit ${sha.slice(0, 12)}`,
        text: normaliseMetadata(`author: ${authorEmail}\ncommitter: ${committerEmail}\n${message}`),
      };
    });
}

/** Pull-request fields from the environment, when CI sets them. */
export function pullRequestEntries(env) {
  return [
    ["pull request branch", env.PR_HEAD_REF],
    ["pull request title", env.PR_TITLE],
    ["pull request body", env.PR_BODY],
  ]
    .filter(([, text]) => text)
    .map(([file, text]) => ({ file, text: normaliseMetadata(text) }));
}

function metadataEntries() {
  const range = process.env.LEAK_SCAN_COMMIT_RANGE || "HEAD";
  const log = execFileSync("git", ["log", `--format=${COMMIT_LOG_FORMAT}`, range], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...parseCommitLog(log), ...pullRequestEntries(process.env)];
}

function loadPrivateRules() {
  const sources = [];
  if (process.env.LEAK_SCAN_PATTERNS) sources.push(process.env.LEAK_SCAN_PATTERNS);
  const file = process.env.LEAK_SCAN_PATTERNS_FILE || join(ROOT, ".leak-patterns.local");
  if (existsSync(file)) sources.push(readFileSync(file, "utf8"));
  return parsePrivateRules(sources.join("\n"));
}

function listRepoFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  // A nested repository (another worktree, a submodule not yet added) is
  // listed as a directory; it is not this repository's content.
  return out.split("\0").filter((f) => f && existsSync(join(ROOT, f)) && !statSync(join(ROOT, f)).isDirectory());
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function main(argv) {
  const requirePrivate = argv.includes("--require-private");
  const reportOnly = argv.includes("--report-only");
  const targets = argv.filter((a) => !a.startsWith("--"));

  const privateRules = loadPrivateRules();
  if (requirePrivate && privateRules.length === 0) {
    console.error(
      "leak-scan: no private rules loaded. Set LEAK_SCAN_PATTERNS (CI secret), LEAK_SCAN_PATTERNS_FILE, or .leak-patterns.local.",
    );
    process.exit(2);
  }
  const rules = [...BUILT_IN_RULES, ...privateRules];
  const allowFile = join(ROOT, ".leak-scan-allow");
  const allowlist = existsSync(allowFile) ? parseAllowlist(readFileSync(allowFile, "utf8")) : [];

  if (argv.includes("--metadata")) {
    const entries = metadataEntries();
    const findings = entries.flatMap((e) => scanText(e.file, e.text, rules, allowlist));
    for (const f of findings) console.log(`${f.file}:${f.line}: ${f.rule}: ${redact(f.match)}`);
    console.log(`leak-scan --metadata: ${entries.length} entries, ${findings.length} finding(s)`);
    if (findings.length && !reportOnly) process.exit(1);
    return;
  }

  const files = targets.length
    ? targets.flatMap((t) => (statSync(t).isDirectory() ? walk(resolve(t)) : [resolve(t)])).map((f) => relative(ROOT, f))
    : listRepoFiles();

  const findings = [];
  for (const file of files) {
    const full = join(ROOT, file);
    if (statSync(full).size > MAX_BYTES) continue;
    const buf = readFileSync(full);
    if (buf.includes(0)) continue; // binary
    findings.push(...scanText(file, buf.toString("utf8"), rules, allowlist));
  }

  for (const f of findings) console.log(`${f.file}:${f.line}: ${f.rule}: ${redact(f.match)}`);
  console.log(
    `leak-scan: ${files.length} files, ${BUILT_IN_RULES.length} built-in + ${privateRules.length} private rules, ${findings.length} finding(s)`,
  );
  if (findings.length && !reportOnly) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

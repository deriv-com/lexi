// Scrubs credentials from text before it reaches disk, a report or an artifact.
//
//   node redact-output.mjs               stdin -> stdout, redacted
//   node redact-output.mjs --find        print the names of credentials whose
//                                        values appear on stdin; exit 1 if any
//   node redact-output.mjs --files P...  redact files in place (directories
//                                        recursively); exit 1 on any error, so
//                                        the caller can refuse to upload
//
// Two kinds of redaction:
//
// - By value: every environment variable that holds a credential, in its raw,
//   JSON-escaped (once, and twice for JSON inside JSON), URL-encoded and
//   form-encoded forms. A credential is a variable in NAMES, any variable
//   prefixed LEXI_REDACT_, and any variable with a credential word as one of
//   the _-separated parts of its name (TOKEN, SECRET, PASSWORD, KEY, WEBHOOK,
//   EMAIL, ...): GH_TOKEN, ANTHROPIC_AUTH_TOKEN, CF_ACCESS_CLIENT_SECRET and so
//   on. A value shorter than MIN_VALUE is skipped (splitting on it would shred
//   the text) and named on stderr.
// - By shape: GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_), model
//   keys (sk-...), Slack tokens and webhook URLs, AWS access key ids, PEM
//   private keys (also JSON-escaped or URL-encoded), bearer headers and
//   credentials inside URLs. This catches what the redacting step was
//   deliberately not given, such as an App installation token or the App
//   private key: a step that runs after an agent is never handed a secret the
//   agent did not already hold.
//
// --find matches values only (push.sh refuses a commit with it), so code that
// merely looks like a token never blocks a push.
//
// --files: a text file is rewritten in place. A binary file (it holds a NUL
// byte) cannot be edited safely, so it is deleted if any form or strict shape
// appears in it (the loose bearer and URL shapes are text only). Inside a
// directory, an entry whose name holds a credential is deleted too, and so is a
// symlink or special file, never followed: it could point outside the upload.
// A missing path is ignored, so a shell glob that matched nothing is harmless.
import { readFileSync, writeFileSync, lstatSync, readdirSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const NAMES = ['STAGING_TEST_PASSWORD', 'STAGING_TEST_EMAIL', 'STAGING_REAL_PASSWORD', 'STAGING_REAL_EMAIL',
  'MAILISK_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'MODEL_API_KEY',
  'MODEL_TOKEN', 'BRIEF_TOKEN', 'EVIDENCE_TOKEN', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET',
  'LEXI_SLACK_WEBHOOK_URL', 'TEST_ACCOUNT_EMAIL', 'TEST_ACCOUNT_PASSWORD', 'TURNSTILE_BYPASS_USER_AGENT'];
const CREDENTIAL_WORD =
  /(^|_)(TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|PASS|KEY|APIKEY|PAT|WEBHOOK|CREDENTIAL|CREDENTIALS|COOKIE|EMAIL)(_|$)/;
const MIN_VALUE = 4;
const MARK = '[redacted]';

function credentials(env) {
  const out = [];
  const names = Object.keys(env)
    .filter(name => NAMES.includes(name) || name.startsWith('LEXI_REDACT_') || CREDENTIAL_WORD.test(name)).sort();
  for (const name of names) {
    const value = env[name];
    if (!value) continue;
    if (value.length < MIN_VALUE) {
      console.error(`redact-output: ${name} is shorter than ${MIN_VALUE} characters; it is not redacted by value`);
      continue;
    }
    const json = JSON.stringify(value).slice(1, -1);
    const forms = [value, json, JSON.stringify(json).slice(1, -1), encodeURIComponent(value),
      new URLSearchParams({ value }).toString().slice('value='.length)];
    out.push({ name: name.replace(/^LEXI_REDACT_/, ''), forms: [...new Set(forms)] });
  }
  return out;
}

// A space in a PEM header may arrive raw, URL-encoded or form-encoded.
const SP = '(?: |%20|\\+)';
const PEM_TAIL = `(?:${SP}[A-Z0-9]+)*${SP}PRIVATE${SP}KEY-----`;
const SHAPES = [
  { name: 'private-key', re: new RegExp(`-----BEGIN${PEM_TAIL}[\\s\\S]*?-----END${PEM_TAIL}`, 'g') },
  // A key whose END line was cut off: the header and the base64 after it.
  { name: 'private-key', re: new RegExp(`-----BEGIN${PEM_TAIL}[A-Za-z0-9+/=\\s\\\\%]*`, 'g') },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'model-key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'slack-token', re: /\bx(?:ox[abprs]|app)-[A-Za-z0-9-]{10,}/g },
  { name: 'slack-webhook', re: /hooks\.slack\.com(?:\/|%2F)(?:services|workflows|triggers)(?:\/|%2F)[A-Za-z0-9_\/%-]+/gi },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Text only: in binary data these loose shapes match noise.
  { name: 'bearer', re: /\b(Bearer(?: |%20|\+))[A-Za-z0-9._~+\/-]{20,}=*/g, prefix: true, textOnly: true },
  { name: 'url-credentials', re: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s\/:@'"<>\\]+:[^\s\/@'"<>\\]+@/gi, prefix: true, suffix: '@',
    textOnly: true },
];

function redact(text, creds, binary = false) {
  const found = new Set();
  const forms = [...new Set(creds.flatMap(({ forms }) => forms))].sort((a, b) => b.length - a.length);
  for (const form of forms) {
    if (text.includes(form)) {
      text = text.split(form).join(MARK);
      found.add('value');
    }
  }
  for (const { name, re, prefix, suffix, textOnly } of SHAPES) {
    if (binary && textOnly) continue;
    text = text.replace(re, (_match, first) => {
      found.add(name);
      return (prefix ? first : '') + MARK + (suffix || '');
    });
  }
  return { text, found };
}

function walk(path, files, creds) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      // A name is uploaded too: an entry whose name holds a credential goes.
      if (redact(entry, creds).found.size) {
        rmSync(join(path, entry), { recursive: true, force: true });
        console.error(`redact-output: removed an entry of ${path} whose name holds a credential`);
        continue;
      }
      walk(join(path, entry), files, creds);
    }
  } else if (stat.isFile()) {
    files.push(path);
  } else {
    unlinkSync(path);
    console.error(`redact-output: removed ${path}, which is not a regular file`);
  }
}

function redactFiles(paths, creds) {
  const files = [];
  for (const path of paths) walk(path, files, creds);
  let changed = 0;
  for (const file of files) {
    const bytes = readFileSync(file);
    if (bytes.includes(0)) {
      // latin1 maps each byte to one character, so every form and shape is still found.
      if (redact(bytes.toString('latin1'), creds, true).found.size) {
        unlinkSync(file);
        console.error(`redact-output: removed ${file}: a binary file that holds a credential`);
        changed++;
      }
      continue;
    }
    const { text, found } = redact(bytes.toString('utf8'), creds);
    if (!found.size) continue;
    const tmp = `${file}.redact-${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
    console.error(`redact-output: redacted ${file} (${[...found].sort().join(', ')})`);
    changed++;
  }
  console.error(`redact-output: checked ${files.length} file(s), changed ${changed}`);
}

const mode = process.argv[2];
if (mode === '--files') {
  try {
    redactFiles(process.argv.slice(3), credentials(process.env));
  } catch (error) {
    console.error(`::error::redact-output: ${error.message}`);
    process.exit(1);
  }
} else {
  const text = readFileSync(0, 'utf8');
  const creds = credentials(process.env);
  if (mode === '--find') {
    const found = creds.filter(({ forms }) => forms.some(form => text.includes(form))).map(({ name }) => name);
    if (found.length) process.stdout.write(found.join('\n') + '\n');
    process.exit(found.length ? 1 : 0);
  }
  process.stdout.write(redact(text, creds).text);
}

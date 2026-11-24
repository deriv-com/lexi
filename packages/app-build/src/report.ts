/**
 * The app-build loop's vocabulary, and the parsers for what it posts.
 *
 * The loop is the reusable workflow `.github/workflows/app-build.yml` (with
 * `app-build/report.sh`), started in a product repository through a thin
 * caller (`examples/workflows/app-build.yml`). An agent that relays the loop
 * never builds anything itself: it starts, stops and reads the loop, and
 * relays what it says. Everything here is pure so every reader parses a report
 * the same way.
 *
 * What the loop posts:
 *
 *   <!-- app-build:report -->
 *   <!-- app-build:feedback-read-at=… -->
 *   <!-- app-build:session app=web session=3 phase=build -->   (newer loops)
 *   ## Session 3 — <app label>
 *   [Run log](…) · commit `abc1234` · [progress](…)
 *   …the builder's LAST_SESSION.md (questions only a person can answer, a cost line)…
 *   ### Phase gate          (newer loops)
 *   ### Checks
 *   …
 *   _Session 4 starts now. …_   |   _The build loop stopped: <reason>._
 *
 * and, separately, an assessment comment that starts with
 * `<!-- app-build:assessment app=web session=3 -->`.
 *
 * Every field is best-effort: a report from an older loop without the session
 * marker still yields its session number from the heading, and an absent
 * section is null rather than a guess.
 */

export const APP_BUILD_APPS = ["web", "mobile"] as const;
export type AppBuildApp = (typeof APP_BUILD_APPS)[number];

export function isAppBuildApp(value: unknown): value is AppBuildApp {
  return typeof value === "string" && (APP_BUILD_APPS as readonly string[]).includes(value);
}

/** The caller workflow in the product repo; the reusable loop is behind it. */
export const APP_BUILD_WORKFLOW_FILE = "app-build.yml";
/** Default prefix of the build branch (the workflow's `branch_prefix` input). */
export const APP_BUILD_BRANCH_PREFIX = "lexi/build-";
/** Honoured by the loop at session start and at every segment boundary. */
export const APP_BUILD_STOP_LABEL = "app-build:stop";
export const APP_BUILD_REPORT_MARKER = "<!-- app-build:report -->";
export const APP_BUILD_ASSESSMENT_MARKER = "<!-- app-build:assessment";
/** Share of max_sessions at which a relay should warn that the cap is near. */
export const APP_BUILD_CEILING_WARNING_RATIO = 0.75;

/** The one branch the builder works on for an app. */
export function appBuildBranch(app: AppBuildApp, prefix = APP_BUILD_BRANCH_PREFIX): string {
  return `${prefix}${app}`;
}

/** How people name the app in a sentence. */
export function appBuildLabel(app: AppBuildApp): string {
  return app === "web" ? "web app" : "mobile app";
}

export interface ParsedCheckCounts {
  pass: number;
  fail: number;
  missing: number;
}

export interface ParsedSessionReport {
  kind: "report";
  app: AppBuildApp | null;
  session: number | null;
  phase: string | null;
  runUrl: string | null;
  /** A few lines of what the session did, from the builder's LAST_SESSION.md. */
  summary: string | null;
  /** Items under the builder's "questions only a person can answer" heading. */
  questions: string[];
  cost: string | null;
  gateVerdict: string | null;
  checks: ParsedCheckCounts;
  /** Set when the report's last line says the loop stopped. */
  stopReason: string | null;
  /** True when the report says the next session starts now. */
  continuing: boolean;
}

export interface ParsedAssessment {
  kind: "assessment";
  app: AppBuildApp | null;
  session: number | null;
  checks: ParsedCheckCounts;
  blockers: number | null;
  majors: number | null;
  runUrl: string | null;
}

export type ParsedBuildComment = ParsedSessionReport | ParsedAssessment;

/** The loop writes the marker as the body's first line; anywhere else is not a report. */
export function isAppBuildReport(body: string): boolean {
  return body.trimStart().startsWith(APP_BUILD_REPORT_MARKER);
}

export function isAppBuildAssessment(body: string): boolean {
  return body.trimStart().startsWith(APP_BUILD_ASSESSMENT_MARKER);
}

/** Null for any comment that is neither a session report nor an assessment. */
export function parseBuildComment(body: string): ParsedBuildComment | null {
  if (isAppBuildAssessment(body)) return parseAssessment(body);
  if (isAppBuildReport(body)) return parseSessionReport(body);
  return null;
}

/** `key=value` pairs from the first `<!-- app-build:<name> … -->` marker. */
function markerAttributes(body: string, name: string): Record<string, string> {
  const match = body.match(new RegExp(`<!--\\s*app-build:${name}\\b([^<>]*?)-->`));
  if (!match) return {};
  const attributes: Record<string, string> = {};
  for (const pair of match[1].matchAll(/(?<![a-z_])([a-z_]+)=(\S+)/gi)) {
    attributes[pair[1].toLowerCase()] = pair[2];
  }
  return attributes;
}

function positiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function appFrom(value: string | undefined, body: string): AppBuildApp | null {
  if (isAppBuildApp(value)) return value;
  const heading =
    body.match(/^##[^\S\r\n]+Session[^\S\r\n]+\d+[^\S\r\n]+[—-][^\S\r\n]+(\S[^\r\n\u2028\u2029]*)$/m)?.[1] ?? "";
  if (/\bmobile\b/i.test(heading)) return "mobile";
  if (/\bweb\b/i.test(heading)) return "web";
  return null;
}

/** Lines under the first heading matching `title`, up to the next heading of any level. */
function sectionUnder(body: string, title: RegExp): string[] | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+/.test(line) && title.test(line));
  if (start < 0) return null;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+/.test(line)) break;
    out.push(line);
  }
  return out;
}

/** Strips list markers, bold and surrounding whitespace from one markdown line. */
function plain(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

const NONE_LINE = /^(?:none|nothing|no (?:open )?questions?|n\/a|-)\.?$/i;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * The questions under the heading. When the section is a list, only its items
 * count — a cost line or a note the builder wrote after the list is not a
 * question. Otherwise the first paragraph is.
 */
function extractQuestions(lines: string[]): string[] {
  const keep = (line: string) => line.length > 0 && !NONE_LINE.test(line) && !/^_.*_$/.test(line) && !/\bcost\b/i.test(line);
  if (lines.some((line) => LIST_ITEM.test(line))) {
    return lines.filter((line) => LIST_ITEM.test(line)).map(plain).filter(keep);
  }
  const paragraph: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(plain(line));
  }
  return paragraph.filter(keep);
}

function countChecks(lines: string[]): ParsedCheckCounts {
  const counts: ParsedCheckCounts = { pass: 0, fail: 0, missing: 0 };
  for (const line of lines) {
    if (!line.trimStart().startsWith("|")) continue;
    if (/✅|\|\s*pass(?:ed)?\s*\|/i.test(line)) counts.pass += 1;
    else if (/❌|\|\s*fail(?:ed)?\s*\|/i.test(line)) counts.fail += 1;
    else if (/➖|\|\s*missing\s*\|/i.test(line)) counts.missing += 1;
  }
  return counts;
}

function firstRunUrl(body: string): string | null {
  return body.match(/https:\/\/github\.com\/[^/\s)]+\/[^/\s)]+\/actions\/runs\/\d+/)?.[0] ?? null;
}

function extractStopReason(lines: readonly string[]): string | null {
  const marker = "_The build loop stopped:";
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.endsWith("_")) continue;
    const idx = line.indexOf(marker);
    if (idx === -1) continue;
    const rawReason = line.slice(idx + marker.length, -1).trim();
    if (!rawReason) continue;
    const cleaned = rawReason.endsWith(".") ? rawReason.slice(0, -1).trim() : rawReason;
    if (cleaned) return cleaned;
  }
  return null;
}

export function parseSessionReport(body: string): ParsedSessionReport {
  const attributes = markerAttributes(body, "session");
  const headingSession = body.match(/^##\s+Session\s+(\d+)\b/m)?.[1];
  const lines = body.split(/\r?\n/);

  // Questions: the builder's own heading, worded however it likes as long as
  // it says "question". "None" in any spelling is no questions.
  const questions = extractQuestions(sectionUnder(body, /question/i) ?? []);

  // The phase gate: the first line that states a verdict, else the first line.
  const gateLines = (sectionUnder(body, /phase gate/i) ?? []).map(plain).filter((line) => line.length > 0);
  const gateVerdict =
    gateLines.find((line) => /\b(pass(?:ed)?|fail(?:ed)?|approved?|rejected?|blocked|advance[sd]?|hold)\b/i.test(line)) ??
    gateLines[0] ??
    null;

  const costLine = lines.find((line) => /\bcost\b/i.test(line) && /(\$|usd|£|€|\d)/i.test(line));

  // What it did: the LAST_SESSION.md region (between the run-log line and the
  // loop's own "###" sections), minus headings and the questions section.
  const runLogIndex = lines.findIndex((line) => /^\[Run log\]/.test(line.trim()));
  const regionEnd = lines.findIndex(
    (line, index) => index > runLogIndex && /^###\s+(?:phase gate|checks|screens|code review)\b/i.test(line),
  );
  const region = lines.slice(runLogIndex + 1, regionEnd < 0 ? undefined : regionEnd);
  const summaryLines: string[] = [];
  let inQuestions = false;
  for (const line of region) {
    if (/^#{1,6}\s+/.test(line)) {
      inQuestions = /question/i.test(line);
      continue;
    }
    if (inQuestions) continue;
    const text = plain(line);
    if (!text || /^<!--/.test(text) || /\bcost\b/i.test(text) || /^_.*_$/.test(text)) continue;
    summaryLines.push(text);
    if (summaryLines.length >= 3) break;
  }

  const stopReason = extractStopReason(lines);

  return {
    kind: "report",
    app: appFrom(attributes.app, body),
    session: positiveInt(attributes.session) ?? positiveInt(headingSession),
    phase: attributes.phase?.trim() || null,
    runUrl: firstRunUrl(body),
    summary: summaryLines.length > 0 ? summaryLines.join(" ") : null,
    questions,
    cost: costLine ? plain(costLine) : null,
    gateVerdict,
    checks: countChecks(sectionUnder(body, /^#{1,6}\s+checks\b/i) ?? []),
    stopReason,
    continuing: stopReason === null && /_Session\s+\d+\s+starts now/i.test(body),
  };
}

function countNamed(body: string, word: string): number | null {
  const explicit =
    body.match(new RegExp(`\\b(\\d+)\\s+${word}s?\\b`, "i")) ??
    body.match(new RegExp(`\\b${word}s?\\b\\s*[:|]\\s*(\\d+)`, "i"));
  if (explicit) return Number(explicit[1]);
  const tagged = body
    .split(/\r?\n/)
    .filter((line) => new RegExp(`^\\s*(?:[-*+]|\\d+[.)])\\s+.*\\b${word}\\b`, "i").test(line)).length;
  return tagged > 0 ? tagged : null;
}

export function parseAssessment(body: string): ParsedAssessment {
  const attributes = markerAttributes(body, "assessment");
  return {
    kind: "assessment",
    app: isAppBuildApp(attributes.app) ? attributes.app : null,
    session: positiveInt(attributes.session),
    checks: countChecks(body.split(/\r?\n/)),
    blockers: countNamed(body, "blocker"),
    majors: countNamed(body, "major"),
    runUrl: firstRunUrl(body),
  };
}

/** Status of a run that is still going, in GitHub's vocabulary. */
export const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/**
 * The app a run is for, when its title says so. The caller's runs are all
 * titled "Lexi app build" unless the caller sets a `run-name` naming the app —
 * then this is exact; otherwise null and callers fall back to the PR state.
 */
export function runApp(run: { displayTitle?: string | null; name?: string | null }): AppBuildApp | null {
  const title = `${run.displayTitle ?? ""} ${run.name ?? ""}`;
  const hasWeb = /\bweb\b/i.test(title);
  const hasMobile = /\bmobile\b/i.test(title);
  if (hasWeb === hasMobile) return null;
  return hasWeb ? "web" : "mobile";
}

/** `max_sessions` named in a run title (`max 12`, `of 12`, `max_sessions=12`). */
export function runMaxSessions(run: { displayTitle?: string | null }): number | null {
  const match = (run.displayTitle ?? "").match(/\b(?:max(?:_sessions)?\s*(?:[=:]\s*)?|of\s+)(\d+)\b/i);
  return match ? positiveInt(match[1]) : null;
}

/**
 * The caller's default max_sessions for an app, read from the workflow file:
 * its `inputs.app == 'mobile' && 'M' || 'W'` expression, or the "Empty = W for
 * web, M for mobile" description. Null when neither is present.
 */
export function callerDefaultMaxSessions(workflowYaml: string, app: AppBuildApp): number | null {
  const expression = workflowYaml.match(
    /inputs\.app\s*==\s*'mobile'\s*&&\s*'(\d+)'\s*\|\|\s*'(\d+)'/,
  );
  if (expression) return positiveInt(app === "mobile" ? expression[1] : expression[2]);
  const description = workflowYaml.match(/Empty\s*=\s*(\d+)\s+for\s+web,\s*(\d+)\s+for\s+mobile/i);
  if (description) return positiveInt(app === "mobile" ? description[2] : description[1]);
  // A caller with one app, or one cap for both:
  // `inputs.max_sessions != '' && inputs.max_sessions || '20'`, or "Empty = 20."
  const single = workflowYaml.match(/inputs\.max_sessions\s*!=\s*''\s*&&\s*inputs\.max_sessions\s*\|\|\s*'(\d+)'/);
  if (single) return positiveInt(single[1]);
  const singleDescription = workflowYaml.match(/Empty\s*=\s*(\d+)\s*\./i);
  if (singleDescription) return positiveInt(singleDescription[1]);
  return null;
}

/** The first line of PROGRESS.md when it is a `Status: …` line. */
export function progressStatusLine(progressMd: string | null): string | null {
  const first = (progressMd ?? "").split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
  return /^status\s*:/i.test(first) ? first : null;
}

/** Slack rejects a section over 3000 chars; plain text is kept well under. */
export const SLACK_TEXT_CAP = 2900;

export function clampForSlack(text: string, cap = SLACK_TEXT_CAP): string {
  if (text.length <= cap) return text;
  const suffix = "\n… (cut short — the full text is on the PR)";
  return text.slice(0, cap - suffix.length) + suffix;
}

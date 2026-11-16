/**
 * Masks personal data out of text before it leaves for a model provider.
 *
 * Each detector replaces what it finds with a typed placeholder (`[email]`,
 * `[phone]`, `[card]`, `[iban]`, `[ip]`, and `[redacted]` for a deployment's
 * own patterns), so the model still knows *that* a value was there and what
 * kind it was, without seeing it.
 *
 * The detectors are tuned against the text Lexi actually sends: Slack threads,
 * GitHub issues and tool results full of SHAs, versions, timestamps, issue
 * numbers, ports, run ids and URLs. A false positive there is not harmless —
 * masking a run id or a version makes the model wrong — so each numeric
 * detector validates what it finds (Luhn for cards, mod-97 and the country's
 * length for IBANs, an octet range for IPv4, a shape for phone numbers) and the
 * numeric detectors skip URLs entirely.
 *
 * Deliberately left alone:
 *  - GitHub logins, URLs, file paths, commit SHAs. They are how the model
 *    addresses code and people on GitHub, and a login is a public handle.
 *  - Slack mentions (`<@U…>`) and channel ids. Slack ids are pseudonymous and
 *    the agent needs them to address people in its reply.
 *  - Names and free-text descriptions of people. Recognising those needs a
 *    language model of its own; this is a pattern masker.
 *  - Images. Screenshots and attachments go to the model as pixels.
 *
 * No dependencies, no I/O. Masking is idempotent: no placeholder matches any
 * detector, so masking twice gives the same text as masking once.
 */

export type PiiKind = "email" | "phone" | "card" | "iban" | "ip" | "custom";

export type PiiCounts = Record<PiiKind, number>;

export const PII_PLACEHOLDERS: Readonly<Record<PiiKind, string>> = {
  email: "[email]",
  phone: "[phone]",
  card: "[card]",
  iban: "[iban]",
  ip: "[ip]",
  custom: "[redacted]",
};

export interface PiiMaskResult {
  text: string;
  /** How many values of each kind were replaced. Counts only, never the values. */
  counts: PiiCounts;
}

export interface PiiMasker {
  /** Masks one string and reports what it replaced. */
  mask(text: string): PiiMaskResult;
  /** How many of the configured extra patterns compiled and are in use. */
  readonly extraPatternCount: number;
}

export interface PiiMaskerOptions {
  /**
   * The deployment's own patterns, masked as `[redacted]`. A string is
   * compiled as a global regular expression; `/body/flags` sets flags. A
   * pattern that does not compile, or that matches the empty string, is skipped
   * and reported through `onInvalidPattern`.
   */
  extraPatterns?: ReadonlyArray<string | RegExp>;
  onInvalidPattern?: (pattern: string, reason: string) => void;
}

export function emptyPiiCounts(): PiiCounts {
  return { email: 0, phone: 0, card: 0, iban: 0, ip: 0, custom: 0 };
}

export function addPiiCounts(into: PiiCounts, from: PiiCounts): PiiCounts {
  for (const kind of Object.keys(into) as PiiKind[]) into[kind] += from[kind];
  return into;
}

export function totalPiiCount(counts: PiiCounts): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/** `email=2 card=1`, listing only the kinds that were masked. For logs. */
export function describePiiCounts(counts: PiiCounts): string {
  return (Object.keys(counts) as PiiKind[])
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${kind}=${counts[kind]}`)
    .join(" ");
}

/**
 * Splits an environment value into patterns: one per line, or separated by
 * `||` so a single-line `.env` value can hold several. Blank entries are dropped.
 */
export function parsePiiPatternList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n|\|\|/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The Luhn checksum every payment card number carries. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** IBAN lengths by country, from the IBAN registry. A code not listed is not an IBAN. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28,
  CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18,
  FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22,
  IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20,
  LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15,
  PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19,
  SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

/** A compact (no spaces) IBAN with the right length for its country and a valid mod-97 check. */
export function ibanValid(compact: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return false;
  if (IBAN_LENGTHS[compact.slice(0, 2)] !== compact.length) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

// --- detectors ---------------------------------------------------------------

/**
 * Emails. Bounded quantifiers keep this linear on long tool results. The
 * domain must end in an alphabetic TLD, so `pkg@1.2.3` and `user@localhost`
 * are not emails.
 */
const EMAIL = /(?<![\w.%+-])([A-Za-z0-9._%+-]{1,64})@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}[A-Za-z]{2,24})(?![\w-])/g;

/** URLs and Slack references: the numeric detectors do not look inside these. */
const PROTECTED = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'`|]+|\bwww\.[^\s<>"'`|]+|<[@#!][^>\s]{1,100}>/gi;

/** IBAN: country, check digits, then the BBAN written compact or in groups of up to four. */
const IBAN = /(?<![\w])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{1,4}){3,8}(?![\w])/g;

/**
 * Card numbers: 4-4-4-4 with one consistent separator, the 4-6-5 and 4-6-4
 * layouts, or 13–19 digits written together.
 */
const CARD = /(?<![\w.+-])(?:\d{4}([ -])\d{4}\1\d{4}\1\d{4}|\d{4}([ -])\d{6}\2\d{4,5}|\d{13,19})(?![\w-]|\.\d)/g;

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`(?<![\\w.])(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}(?![\\w]|\\.\\d)`, "g");

const IPV6 = /(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g;

/**
 * Phone candidates: an optional `+` or `(`, then digits with spaces, dots,
 * dashes and parentheses between them. The shape check in {@link phoneValid}
 * decides; this only finds candidates. It never starts right after a word
 * character, `#`, `/`, `:`, `.` or `@`, which rules out issue numbers, ports,
 * paths and the inside of identifiers.
 */
const PHONE = /(?<![\w#@/:.+-])(?:\+|\()?\d[\d \t().-]{5,22}\d(?![\w@/]|[.:-]?\d)/g;

const NANP = /^\(?\d{3}\)?[ .-]?\d{3}[ .-]\d{4}$/;
const DATE_PREFIX = /^(?:\d{4}[-.]\d{1,2}[-.]\d{1,2}|\d{1,2}[-.]\d{1,2}[-.]\d{2,4})(?!\d)/;

function emailValid(local: string, domain: string): boolean {
  // `git@github.com:org/repo.git` is an SSH remote, not a person.
  if (local.toLowerCase() === "git") return false;
  // `icon@2x.png` is an asset name.
  if (/^\d+(?:\.\d+)?x\./i.test(domain)) return false;
  return true;
}

function cardValid(match: string): boolean {
  const digits = match.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  // Card numbers start with 2 (Mastercard 2221–2720) through 6. Other leading
  // digits are other industries; excluding them keeps millisecond timestamps
  // (which start with 1) and long ids out.
  const first = digits[0];
  if (first < "2" || first > "6") return false;
  if (first === "2") {
    const prefix = Number(digits.slice(0, 4));
    if (prefix < 2221 || prefix > 2720) return false;
  }
  return luhnValid(digits);
}

function ipv4Personal(match: string): boolean {
  // Loopback and the unspecified address are never about a person, and they
  // fill logs.
  return !match.startsWith("127.") && match !== "0.0.0.0";
}

function ipv6Valid(match: string): boolean {
  if (!/\d/.test(match)) return false; // `dead::beef`, `Abc::Def`
  if (match.includes(":::")) return false;
  const compressed = match.split("::").length - 1;
  if (compressed > 1) return false;
  const groups = match.split(":").filter((group) => group.length > 0);
  if (groups.some((group) => group.length > 4)) return false;
  if (compressed === 0) return groups.length === 8 && !match.startsWith(":") && !match.endsWith(":");
  if (groups.length > 7) return false;
  if (match === "::1" || match === "::") return false;
  // `a:b:c` style leftovers with a single colon at an edge are not addresses.
  if ((match.startsWith(":") && !match.startsWith("::")) || (match.endsWith(":") && !match.endsWith("::"))) return false;
  return true;
}

function phoneValid(match: string): boolean {
  const digits = match.replace(/\D/g, "");
  if (match.startsWith("+")) return digits.length >= 8 && digits.length <= 15;
  if (digits.length < 9 || digits.length > 12) return false;
  // A bare run of digits is an id (a run, a timestamp, a database row), not a
  // phone number someone wrote down.
  if (!/[ \t().-]/.test(match)) return false;
  if (DATE_PREFIX.test(match)) return false;
  const groups = match.split(/[ \t().-]+/).filter((group) => group.length > 0);
  if (groups.length > 6 || groups.some((group) => group.length < 2)) return false;
  if (!/[ \t()-]/.test(match)) return NANP.test(match); // dots only: versions and build numbers
  // A local number either carries a trunk prefix (0…, or an area code in
  // parentheses) or has the North American 3-3-4 shape. Anything else — a
  // table of numbers, a list of ids — is left alone.
  return match.startsWith("0") || match.startsWith("(") || NANP.test(match);
}

// --- masking -----------------------------------------------------------------

type Detector = { kind: PiiKind; pattern: RegExp; replace: (match: string, counts: PiiCounts) => string };

function simple(kind: PiiKind, pattern: RegExp, valid: (match: string) => boolean): Detector {
  return {
    kind,
    pattern,
    replace: (match, counts) => {
      if (!valid(match)) return match;
      counts[kind]++;
      return PII_PLACEHOLDERS[kind];
    },
  };
}

/** An IBAN followed by an unrelated uppercase word: keep the longest valid prefix. */
const IBAN_DETECTOR: Detector = {
  kind: "iban",
  pattern: IBAN,
  replace: (match, counts) => {
    const tokens = match.split(" ");
    for (let take = tokens.length; take >= 1; take--) {
      if (ibanValid(tokens.slice(0, take).join(""))) {
        counts.iban++;
        const rest = tokens.slice(take).join(" ");
        return PII_PLACEHOLDERS.iban + (rest ? ` ${rest}` : "");
      }
    }
    return match;
  },
};

/** Run in this order: the IBAN and card checks are stricter than the phone shape, so they claim digits first. */
const NUMERIC_DETECTORS: Detector[] = [
  IBAN_DETECTOR,
  simple("card", CARD, cardValid),
  simple("ip", IPV6, ipv6Valid),
  simple("ip", IPV4, ipv4Personal),
  simple("phone", PHONE, phoneValid),
];

/**
 * Like `String.replace`, except that a candidate the validator rejects does not
 * swallow its span: the search resumes one character later. Otherwise a
 * rejected candidate that overlaps a real value (`0958 4111 1111 1111` in front
 * of a card number) would hide it.
 */
function applyDetector(text: string, detector: Detector, counts: PiiCounts): string {
  const pattern = detector.pattern;
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const replaced = detector.replace(m[0], counts);
    if (replaced === m[0]) {
      pattern.lastIndex = m.index + 1;
      continue;
    }
    out += text.slice(last, m.index) + replaced;
    last = m.index + m[0].length;
    pattern.lastIndex = last;
  }
  return out + text.slice(last);
}

function maskEmails(text: string, counts: PiiCounts): string {
  EMAIL.lastIndex = 0;
  return text.replace(EMAIL, (match, local: string, domain: string) => {
    if (!emailValid(local, domain)) return match;
    counts.email++;
    return PII_PLACEHOLDERS.email;
  });
}

/** Applies the numeric detectors to everything outside URLs and Slack references. */
function maskOutsideProtected(text: string, counts: PiiCounts): string {
  let out = "";
  let last = 0;
  PROTECTED.lastIndex = 0;
  for (let m = PROTECTED.exec(text); m !== null; m = PROTECTED.exec(text)) {
    out += maskNumeric(text.slice(last, m.index), counts) + m[0];
    last = m.index + m[0].length;
  }
  return out + maskNumeric(text.slice(last), counts);
}

function maskNumeric(segment: string, counts: PiiCounts): string {
  if (!/\d/.test(segment)) return segment;
  let out = segment;
  for (const detector of NUMERIC_DETECTORS) out = applyDetector(out, detector, counts);
  return out;
}

function compileExtra(pattern: string | RegExp, onInvalid?: (pattern: string, reason: string) => void): RegExp | undefined {
  let compiled: RegExp;
  const source = typeof pattern === "string" ? pattern : pattern.source;
  try {
    if (typeof pattern !== "string") {
      compiled = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    } else {
      const literal = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
      const flags = literal ? literal[2] : "";
      compiled = new RegExp(literal ? literal[1] : pattern, flags.includes("g") ? flags : `${flags}g`);
    }
  } catch (error) {
    onInvalid?.(source, error instanceof Error ? error.message : String(error));
    return undefined;
  }
  compiled.lastIndex = 0;
  if (compiled.test("")) {
    onInvalid?.(source, "matches the empty string");
    return undefined;
  }
  return compiled;
}

export function createPiiMasker(options: PiiMaskerOptions = {}): PiiMasker {
  const extras = (options.extraPatterns ?? [])
    .map((pattern) => compileExtra(pattern, options.onInvalidPattern))
    .filter((pattern): pattern is RegExp => pattern !== undefined);

  return {
    extraPatternCount: extras.length,
    mask(text: string): PiiMaskResult {
      const counts = emptyPiiCounts();
      if (!text) return { text, counts };
      let out = text.includes("@") ? maskEmails(text, counts) : text;
      out = maskOutsideProtected(out, counts);
      for (const extra of extras) {
        extra.lastIndex = 0;
        out = out.replace(extra, (match) => {
          if (match === PII_PLACEHOLDERS.custom) return match;
          counts.custom++;
          return PII_PLACEHOLDERS.custom;
        });
      }
      return { text: out, counts };
    },
  };
}

/**
 * Masks every string leaf of a JSON-like value, leaving object keys alone, and
 * returns a copy. For tool-call arguments, which are data, not schema.
 */
export function maskStringLeaves<T>(value: T, masker: PiiMasker, counts: PiiCounts): T {
  if (typeof value === "string") {
    const result = masker.mask(value);
    addPiiCounts(counts, result.counts);
    return result.text as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item) => maskStringLeaves(item, masker, counts)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = maskStringLeaves(item, masker, counts);
    return out as T;
  }
  return value;
}

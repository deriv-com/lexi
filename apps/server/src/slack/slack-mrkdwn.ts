/**
 * Markdown to Slack mrkdwn.
 *
 * The agent is a language model, and prompt instructions alone do not reliably
 * stop it from writing GitHub-flavoured Markdown: literal `- item` bullets,
 * `**bold**` asterisks and pipe-soup tables all render badly in Slack. This is
 * the net applied at the Slack write boundary, so a prompt regression degrades
 * to slightly odd wording instead of an unreadable message.
 *
 * Contract:
 * - Idempotent: toSlackMrkdwn(toSlackMrkdwn(x)) === toSlackMrkdwn(x).
 * - Never rewrites inside fenced code blocks (``` / ~~~) or inline code spans.
 * - Never mangles harmless Slack-native syntax: `<url>`, `<@U123>`,
 *   `<#C123|name>` or `:emoji:`.
 * - Neutralises what a prompt-injected reply could abuse: broadcast mentions
 *   (`<!channel>`, `<!here>`, `<!everyone>`) and user-group mentions
 *   (`<!subteam^…>`) become plain text that pings nobody, and a masked link
 *   `<url|text>` keeps its label only when the URL's host is allowlisted
 *   (github.com and any configured host); otherwise it is shown as
 *   `text (url)`, so the reader sees where it goes. This applies inside code
 *   too: it is a safety net, not formatting.
 * - Handles `**bold**` / `__bold__` -> `*bold*`, `- ` / `* ` / `+ ` bullets at
 *   any indent -> `• `, ATX headings -> a bold line, `---` rules -> dropped, and
 *   Markdown tables.
 * - Turns GitHub issue and pull-request URLs into labelled links whose visible
 *   text is the number (`<https://...|#123>`), so a reply stays scannable.
 * - Leaves `*single asterisk*` bold and `_italic_` untouched (already mrkdwn),
 *   which is what makes the bold conversion idempotent.
 *
 * Slack has no table primitive and monospace alignment only survives inside a
 * code block, so a table becomes one bullet per data row with `label: value`
 * pairs taken from the header row.
 */

export interface SlackMrkdwnOptions {
  /**
   * Hosts whose masked links (`<url|text>`) keep their label. github.com is
   * always included; a host also covers its subdomains.
   */
  linkHosts?: readonly string[];
}

export const DEFAULT_LINK_HOSTS: readonly string[] = ["github.com"];

const BROADCAST_ENTITY_RE = /<!(channel|here|everyone|group)(?:\|[^<>\n]*)?>/gi;
const SUBTEAM_ENTITY_RE = /<!subteam\^[^<>|\n]*(?:\|([^<>\n]*))?>/gi;
const MASKED_LINK_RE = /<([a-z][a-z0-9+.-]*:[^<>|\s]*)\|([^<>\n]*)>/gi;

function hostAllowed(url: string, hosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  return hosts.some((allowed) => {
    const h = allowed.trim().toLowerCase();
    return h.length > 0 && (host === h || host.endsWith(`.${h}`));
  });
}

/**
 * Removes what a reply could use to page people or disguise a link. Runs on
 * the whole text, code included, before any formatting pass.
 */
function neutraliseEntities(input: string, hosts: readonly string[]): string {
  return input
    .replace(BROADCAST_ENTITY_RE, (_whole, name: string) => `@${name.toLowerCase()}`)
    .replace(SUBTEAM_ENTITY_RE, (_whole, label?: string) => {
      const text = (label ?? "").trim().replace(/^@/, "");
      return text ? `@${text}` : "@group";
    })
    .replace(MASKED_LINK_RE, (whole, url: string, label: string) => {
      if (hostAllowed(url, hosts)) return whole;
      const text = label.trim();
      return text && text !== url ? `${text} (${url})` : url;
    });
}

/** Segments of a line that must be passed through untouched. */
const PROTECTED_INLINE = [
  /`[^`\n]*`/, // inline code
  /<[^<>\n]*>/, // Slack links, mentions, channels, subteams
];

const PROTECTED_INLINE_RE = new RegExp(PROTECTED_INLINE.map((r) => r.source).join("|"), "g");

/**
 * Applies `transform` only to the parts of `line` that are not protected
 * (inline code spans and Slack angle-bracket entities).
 */
function mapUnprotected(line: string, transform: (chunk: string) => string): string {
  let out = "";
  let lastIndex = 0;
  for (const match of line.matchAll(PROTECTED_INLINE_RE)) {
    const start = match.index ?? 0;
    out += transform(line.slice(lastIndex, start));
    out += match[0];
    lastIndex = start + match[0].length;
  }
  out += transform(line.slice(lastIndex));
  return out;
}

/** `**bold**` and `__bold__` -> `*bold*`. Single `*`/`_` runs are left alone. */
function convertBold(chunk: string): string {
  return chunk
    .replace(/\*\*(?!\s)([^\n]*?[^\s*])\*\*/g, "*$1*")
    .replace(/\*\*(\S)\*\*/g, "*$1*")
    .replace(/__(?!\s)([^\n]*?[^\s_])__/g, "*$1*")
    .replace(/__(\S)__/g, "*$1*");
}

const GITHUB_REFERENCE_URL_RE =
  /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/(\d+)/g;

/**
 * Slack's auto-linked URLs are technically clickable, but they make people
 * scan a long URL to find the issue or PR number. Render the canonical GitHub
 * URL as a labelled Slack link instead: `<url|#123>`. Only full GitHub URLs
 * are rewritten, so we never guess which repository a bare `#123` belongs to.
 */
function linkGithubReferenceUrls(chunk: string): string {
  return chunk.replace(GITHUB_REFERENCE_URL_RE, (url, number: string) => `<${url}|#${number}>`);
}

/** Converts a Markdown GitHub link to Slack's labelled-link form. */
function convertGithubMarkdownLinks(chunk: string): string {
  return chunk.replace(
    /\[([^\]\n]+)\]\((https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/(\d+))\)/g,
    (_whole, _label: string, url: string, number: string) => `<${url}|#${number}>`,
  );
}

const BULLET_RE = /^(\s*)([-*+])\s+(?=\S)/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HR_RE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const FENCE_RE = /^\s*(```|~~~)/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER_RE = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/;

/** Splits a `| a | b |` row into trimmed cells, respecting `\|` escapes. */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Renders a Markdown table as one bullet per data row: `• *Header*: value —
 * *Header*: value`. Single-column tables collapse to a plain bullet list.
 */
function renderTable(rows: string[]): string[] {
  const parsed = rows.map((row) =>
    splitTableRow(row).map((cell) =>
      mapUnprotected(convertGithubMarkdownLinks(cell), (chunk) => linkGithubReferenceUrls(convertBold(chunk))),
    ),
  );
  // Header cells become our own `*label*`, so drop any bold the model already
  // put around them rather than nesting asterisks.
  const header = (parsed[0] ?? []).map((cell) => cell.replace(/^\*(.*)\*$/, "$1").trim());
  const body = parsed.slice(1);

  if (body.length === 0) {
    // Header-only table: nothing to pair against, so emit the header cells.
    return header.filter(Boolean).map((cell) => `• ${cell}`);
  }

  return body.map((cells) => {
    if (header.length <= 1) {
      return `• ${cells.join(" ").trim()}`;
    }
    const pairs: string[] = [];
    for (let i = 0; i < cells.length; i += 1) {
      const value = cells[i];
      if (!value) continue;
      const label = header[i];
      pairs.push(label ? `*${label}*: ${value}` : value);
    }
    return `• ${pairs.join(" — ")}`;
  });
}

/**
 * Normalises GitHub-flavoured Markdown to Slack mrkdwn.
 * Safe to call on text that is already mrkdwn (idempotent).
 */
export function toSlackMrkdwn(input: string, options: SlackMrkdwnOptions = {}): string {
  if (!input) return input;
  const hosts = [...DEFAULT_LINK_HOSTS, ...(options.linkHosts ?? [])];

  const lines = neutraliseEntities(input, hosts).split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceToken = "";
  let tableBuffer: string[] = [];

  const flushTable = (): void => {
    if (tableBuffer.length === 0) return;
    out.push(...renderTable(tableBuffer));
    tableBuffer = [];
  };

  for (const line of lines) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inFence) {
        flushTable();
        inFence = true;
        fenceToken = fence[1];
      } else if (fence[1] === fenceToken) {
        inFence = false;
        fenceToken = "";
      }
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    if (TABLE_DIVIDER_RE.test(line)) {
      // Alignment row carries no content — drop it, keep collecting the table.
      continue;
    }
    if (TABLE_ROW_RE.test(line)) {
      tableBuffer.push(line);
      continue;
    }
    flushTable();

    if (HR_RE.test(line)) {
      // Slack renders `---` literally and it adds no structure in chat.
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const text = mapUnprotected(convertGithubMarkdownLinks(heading[2].trim()), (chunk) =>
        linkGithubReferenceUrls(convertBold(chunk)),
      );
      // Strip any bold the model already wrapped the heading in, so we do not
      // produce `**text**` -> `*text*` nested inside our own bold.
      const bare = text.replace(/^\*(.*)\*$/, "$1").trim();
      out.push(bare ? `*${bare}*` : "");
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      const rest = line.slice(bullet[0].length);
      out.push(
        `${bullet[1]}• ${mapUnprotected(convertGithubMarkdownLinks(rest), (chunk) =>
          linkGithubReferenceUrls(convertBold(chunk)),
        )}`,
      );
      continue;
    }

    out.push(
      mapUnprotected(convertGithubMarkdownLinks(line), (chunk) => linkGithubReferenceUrls(convertBold(chunk))),
    );
  }

  flushTable();
  return out.join("\n");
}

/**
 * Splitting a long reply across several Slack messages.
 *
 * Slack displays a message's `text` comfortably up to a few thousand
 * characters and truncates far beyond that, so a long answer is posted as a
 * short run of messages rather than cut off.
 */

/** Characters per posted message. Well under Slack's hard ceiling. */
export const MESSAGE_CHUNK_LIMIT = 3500;

const FENCE = "```";

/**
 * Split a reply into message-sized pieces, preferring paragraph boundaries, then
 * line boundaries, and hard-cutting only when a single line exceeds the limit.
 *
 * A piece that ends inside a fenced code block gets the fence closed, and the
 * next piece reopens it — otherwise splitting a long reply mid-fence would
 * render the remainder of the message as code.
 */
export function chunkMessage(text: string, limit = MESSAGE_CHUNK_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current.trim().length > 0) chunks.push(current.trim());
    current = "";
  };

  // Paragraphs first: the separator is re-added so a chunk keeps its shape.
  for (const paragraph of trimmed.split(/\n{2,}/)) {
    const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    flush();
    if (paragraph.length <= limit) {
      current = paragraph;
      continue;
    }
    // A single oversized paragraph: fall back to lines, then to a hard cut.
    for (const line of paragraph.split("\n")) {
      const withLine = current.length === 0 ? line : `${current}\n${line}`;
      if (withLine.length <= limit) {
        current = withLine;
        continue;
      }
      flush();
      let rest = line;
      while (rest.length > limit) {
        chunks.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      current = rest;
    }
  }
  flush();

  return balanceFences(chunks, limit);
}

/**
 * Keep every chunk's ``` fences balanced, so a split inside a code block does
 * not turn the rest of the reply into code.
 */
function balanceFences(chunks: string[], limit: number): string[] {
  const out: string[] = [];
  let openLanguage: string | null = null;

  for (const chunk of chunks) {
    // Annotated rather than inferred: `openLanguage` is reassigned below from a
    // value derived from `prefix`, and letting TS infer both ends of that makes
    // the initializer circular (TS7022).
    const prefix: string = openLanguage === null ? "" : `${FENCE}${openLanguage}\n`;
    const withPrefix: string = `${prefix}${chunk}`;
    const opensFence: boolean = (withPrefix.split(FENCE).length - 1) % 2 === 1;
    const suffix: string = opensFence ? `\n${FENCE}` : "";

    if (opensFence) {
      // Remember the language so the reopened fence highlights the same way.
      const lastFence = withPrefix.lastIndexOf(FENCE);
      openLanguage = (withPrefix.slice(lastFence + FENCE.length).split("\n", 1)[0] ?? "").trim();
    } else {
      openLanguage = null;
    }

    // Trim the BODY, never the fences: a chunk that lost its closing fence to a
    // length cut is exactly the breakage this function exists to prevent.
    const room = Math.max(0, limit - prefix.length - suffix.length);
    out.push(`${prefix}${chunk.length > room ? chunk.slice(0, room) : chunk}${suffix}`);
  }

  return out;
}

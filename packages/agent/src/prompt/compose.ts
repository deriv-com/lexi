import type { PromptSection } from "../tools/agent-tool";
import type { ConversationRef } from "../tools/agent-tool";
import type { LlmSystemSegment } from "../llm/types";

/** What a dynamic section may condition its text on. */
export interface PromptContext {
  actorId: string;
  conversation: ConversationRef;
  intentClass?: string;
}

/**
 * A prompt section rendered per turn. Use it for content that depends on who
 * is asking or where; a fixed `PromptSection` is enough for everything else.
 */
export interface DynamicPromptSection {
  id: string;
  /** Ascending. Ties break by `id` so the prompt is byte-stable across restarts. */
  order: number;
  /** Stable sections can sit in the cached prompt prefix; per-turn content must not. */
  stable: boolean;
  /** Return `undefined` or blank text to contribute nothing this turn. */
  render(ctx: PromptContext): string | undefined;
}

/**
 * Renders and orders dynamic sections. A section that throws is dropped rather
 * than allowed to take down the turn; pass `onError` to log it. Duplicate ids
 * keep the first registration.
 */
export function composePromptSections(
  sections: DynamicPromptSection[],
  ctx: PromptContext,
  onError?: (sectionId: string, error: unknown) => void,
): PromptSection[] {
  const seen = new Set<string>();
  const rendered: Array<{ id: string; order: number; section: PromptSection }> = [];
  for (const section of sections) {
    if (seen.has(section.id)) continue;
    seen.add(section.id);
    let text: string | undefined;
    try {
      text = section.render(ctx);
    } catch (error) {
      onError?.(section.id, error);
      continue;
    }
    if (!text || text.trim() === "") continue;
    rendered.push({ id: section.id, order: section.order, section: { stable: section.stable, text } });
  }
  return rendered.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map((entry) => entry.section);
}

/**
 * The system prompt as ordered segments: the base prompt, then every stable
 * section, then every volatile one. Stable content goes first because prompt
 * caching is a prefix match; relative order within each group is kept.
 */
export function composeSystemSegments(basePrompt: string, sections: PromptSection[]): LlmSystemSegment[] {
  const nonBlank = sections.filter((section) => section.text.trim().length > 0);
  return [
    ...(basePrompt.trim().length > 0 ? [{ text: basePrompt, cacheable: true }] : []),
    ...nonBlank.filter((s) => s.stable).map((s) => ({ text: s.text, cacheable: true })),
    ...nonBlank.filter((s) => !s.stable).map((s) => ({ text: s.text, cacheable: false })),
  ];
}

/** The segments joined into one string, for logging or a transport without segments. */
export function renderSystemPrompt(segments: LlmSystemSegment[]): string {
  return segments.map((segment) => segment.text).join("\n\n");
}

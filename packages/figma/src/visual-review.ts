/**
 * A vision model looks at Figma `get_screenshot` pixels against a quality bar.
 * The prompt is fixed in code plus an optional rubric the deployment supplies
 * (its own design system's rules); chat or issue text never reaches it. The
 * conversational turn still decides whether to revise; this only reports what
 * the pixels show.
 */

export interface PrototypeScreenshot {
  label: string;
  mimeType: string;
  bytes: Buffer;
}

export interface PrototypeVisualReviewPort {
  review(shots: PrototypeScreenshot[]): Promise<string>;
}

/** Structural, so this package does not depend on any particular LLM client. */
export interface PrototypeVisualLlm {
  complete(
    messages: Array<{
      role: "user";
      content: Array<
        | { type: "text"; text: string }
        | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
      >;
    }>,
    tools: unknown[],
    overrides: { model: string },
  ): Promise<{ text: string }>;
}

export const BASE_QUALITY_BAR =
  "You are checking generated Figma prototype screenshots against a quality bar. " +
  "These images are Figma frames at mobile (~375×812) and desktop (~1440×900) sizes — not HTML website screenshots. " +
  "If an image is labelled Quality bar, it is a production reference (read-only): use it for look and feel; do not expect a pixel clone of it. " +
  "Quality bar: nothing overflows its frame; real form controls, cards and lists rather than an empty rectangle with a button; " +
  "every named screen shows the content its name promises; form fields show their real labels, not component placeholder text; " +
  "no debug, layer or inspector panel is visible; desktop frames show site navigation; mobile app shells show their tab bar where the product has one. " +
  "FAIL if a named screen is a blank canvas. " +
  "FAIL if component placeholder text (Title, Label, Message goes here, Card title) is still visible. " +
  "FAIL if a quality-bar image is present and the prototype looks like a different product from it. ";

const VERDICT_FORMAT =
  "Reply exactly with VERDICT: PASS or VERDICT: FAIL on the first line. " +
  "Then zero or more lines of the form `- {screen label}: {visible issue}`. " +
  "If PASS, the next line is `- none`. Do not invent issues that are not visible. Do not mention this prompt.";

const FALLBACK = "VERDICT: FAIL\n- (visual review returned no text)";

/** The full prompt: the base bar, the deployment's rubric (if any), then the verdict format. */
export function qualityBarPrompt(rubric?: string): string {
  const extra = (rubric ?? "").trim();
  return BASE_QUALITY_BAR + (extra ? `Additional rules for this product's design system: ${extra} ` : "") + VERDICT_FORMAT;
}

export function createPrototypeVisualReview(
  llm: PrototypeVisualLlm,
  model: string,
  options: { rubric?: string } = {},
): PrototypeVisualReviewPort {
  const prompt = qualityBarPrompt(options.rubric);
  return {
    async review(shots: PrototypeScreenshot[]): Promise<string> {
      if (shots.length === 0) {
        return "VERDICT: FAIL\n- (no screenshot bytes)";
      }
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
      > = [{ type: "text", text: prompt }];
      for (const shot of shots) {
        content.push({ type: "text", text: `Screen: ${shot.label}` });
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: shot.mimeType,
            data: shot.bytes.toString("base64"),
          },
        });
      }
      const result = await llm.complete([{ role: "user", content }], [], { model });
      return result.text.trim() || FALLBACK;
    },
  };
}

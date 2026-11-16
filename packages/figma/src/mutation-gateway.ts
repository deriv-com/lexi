/**
 * The chokepoint for Figma writes.
 *
 * Authorisation decides whether a caller may publish or revise a prototype at
 * all; this gateway decides which FILE a write may touch: `use_figma` may only
 * target a file key this process created (or one the store says it created).
 * Production design sources listed as forbidden are hard-denied even if a
 * model passes them, so a prompt can never redirect a write onto the real
 * design file.
 */

export type FigmaWriteDecision = { ok: true } | { ok: false; reason: string };

/** Parses a comma- or whitespace-separated list of file keys, de-duplicated. */
export function parseFigmaFileKeys(raw: string | undefined): string[] {
  const keys = (raw ?? "")
    .split(/[\s,]+/)
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  return [...new Set(keys)];
}

export class FigmaMutationGateway {
  private readonly forbidden: ReadonlySet<string>;
  private readonly created = new Set<string>();

  constructor(
    private readonly options: {
      /** Files no write may ever touch (production design sources). */
      forbiddenFileKeys?: readonly string[];
      /** Asks persistent storage whether a key is one of ours. */
      lookup?: (fileKey: string) => Promise<boolean>;
    } = {},
  ) {
    this.forbidden = new Set(parseFigmaFileKeys((options.forbiddenFileKeys ?? []).join(",")));
  }

  /** Record a file key Figma actually returned from `create_new_file`. */
  registerCreated(fileKey: string): FigmaWriteDecision {
    const denied = this.denyReason(fileKey);
    if (denied) return { ok: false, reason: denied };
    this.created.add(fileKey);
    return { ok: true };
  }

  async assertWritable(fileKey: string): Promise<FigmaWriteDecision> {
    const denied = this.denyReason(fileKey);
    if (denied) return { ok: false, reason: denied };
    if (this.created.has(fileKey)) return { ok: true };
    if (this.options.lookup && (await this.options.lookup(fileKey))) {
      this.created.add(fileKey);
      return { ok: true };
    }
    return {
      ok: false,
      reason: `Figma file ${fileKey} is not a Lexi-owned prototype. No write was sent.`,
    };
  }

  private denyReason(fileKey: string): string | undefined {
    const trimmed = fileKey.trim();
    if (trimmed.length === 0) return "Figma file key is empty. No write was sent.";
    if (this.forbidden.has(trimmed)) {
      return `Figma file ${trimmed} is forbidden (production design source). No write was sent.`;
    }
    return undefined;
  }
}

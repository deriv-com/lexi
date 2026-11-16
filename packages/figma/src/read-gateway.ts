/**
 * Read chokepoint for opening Figma designs (a design link shared in chat, or
 * design context for a build).
 *
 * Writes stay on `FigmaMutationGateway` (Lexi-created only). Reads are wider
 * but still fail-closed: Lexi-owned prototype bindings OR an explicit
 * `FIGMA_READ_ALLOWED_FILE_KEYS` allowlist. Arbitrary Figma links the Full
 * seat can open are still refused unless listed — that is the "only if under
 * Lexi's read scope" rule.
 */

import { isFigmaFileKeyShape } from "./design-link";
import type { FigmaPrototypeStore } from "./prototype-store";

export type FigmaReadDecision = { ok: true; via: "prototype" | "allowlist" } | { ok: false; reason: string };

export function normalizeFigmaReadAllowlist(keys: readonly string[] | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const key of keys ?? []) {
    const trimmed = key.trim();
    if (isFigmaFileKeyShape(trimmed)) out.add(trimmed);
  }
  return out;
}

export class FigmaReadGateway {
  private readonly allowlist: ReadonlySet<string>;

  constructor(
    private readonly options: {
      allowedFileKeys?: readonly string[];
      prototypes: FigmaPrototypeStore;
    },
  ) {
    this.allowlist = normalizeFigmaReadAllowlist(options.allowedFileKeys);
  }

  async assertReadable(fileKey: string): Promise<FigmaReadDecision> {
    const trimmed = fileKey.trim();
    if (!isFigmaFileKeyShape(trimmed)) {
      return { ok: false, reason: "Figma file key is malformed. No design was read." };
    }
    if (await this.options.prototypes.findByFileKey(trimmed)) {
      return { ok: true, via: "prototype" };
    }
    if (this.allowlist.has(trimmed)) {
      return { ok: true, via: "allowlist" };
    }
    return {
      ok: false,
      reason:
        `Figma file ${trimmed} is not a Lexi-owned prototype and is not on the FIGMA_READ_ALLOWED_FILE_KEYS allowlist. ` +
        "No design was read. Ask an owner to allowlist the file key, or share a Lexi prototype link.",
    };
  }
}

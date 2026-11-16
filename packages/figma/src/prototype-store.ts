/**
 * Binding between a Slack thread / spec and a Lexi-owned Figma file.
 * Revise looks this up so "make the CTA bigger" hits the same file after restart.
 */

export interface FigmaPrototypeBinding {
  fileKey: string;
  fileUrl: string;
  prototypeUrl?: string;
  startingNodeId?: string;
  specId?: string;
  threadKey?: string;
  createdBy?: string;
  /** Sanitised journey screen names from the last successful publish/revise. */
  states?: string[];
  /**
   * screenId → Figma frame name for every screen drawn on this file so far.
   *
   * Accumulated across `add_prototype_screens` calls so a later batch can wire a
   * flow to a screen an earlier batch drew. Without it, flows resolved only
   * within one call's own scene and an appended journey clicked through as
   * disconnected islands.
   */
  screenFrames?: Record<string, string>;
  /**
   * Layout fragments the prototype was built from.
   *
   * Kept per file so a later `add_prototype_screens` can `use` the shell the
   * first publish defined without resending it. Resending it every batch would
   * undo the reason fragments exist — one declaration, one payload, no drift.
   */
  fragments?: Record<string, unknown[]>;
}

export interface FigmaPrototypeStore {
  save(binding: FigmaPrototypeBinding): Promise<void>;
  findByFileKey(fileKey: string): Promise<FigmaPrototypeBinding | null>;
  findBySpecId(specId: string): Promise<FigmaPrototypeBinding | null>;
  findByThreadKey(threadKey: string): Promise<FigmaPrototypeBinding | null>;
}

export class InMemoryFigmaPrototypeStore implements FigmaPrototypeStore {
  private readonly byKey = new Map<string, FigmaPrototypeBinding>();

  async save(binding: FigmaPrototypeBinding): Promise<void> {
    const previous = this.byKey.get(binding.fileKey);
    this.byKey.set(binding.fileKey, { ...previous, ...binding });
  }

  async findByFileKey(fileKey: string): Promise<FigmaPrototypeBinding | null> {
    return this.byKey.get(fileKey) ?? null;
  }

  async findBySpecId(specId: string): Promise<FigmaPrototypeBinding | null> {
    const trimmed = specId.trim();
    if (!trimmed) return null;
    for (const row of this.byKey.values()) {
      if (row.specId === trimmed) return row;
    }
    return null;
  }

  async findByThreadKey(threadKey: string): Promise<FigmaPrototypeBinding | null> {
    const trimmed = threadKey.trim();
    if (!trimmed) return null;
    for (const row of [...this.byKey.values()].reverse()) {
      if (row.threadKey === trimmed) return row;
    }
    return null;
  }
}

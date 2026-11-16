/**
 * Design-context snapshot contracts.
 *
 * A `DesignContextDocument` is a durable, **self-contained** capture of a
 * Lexi-owned Figma prototype (`FigmaPrototypeBinding`), taken by the
 * orchestrator's DesignContextService and served to build runners over
 * `GET /api/programme/design-context/:id`.
 *
 * Self-contained is the load-bearing property: the runner has no Figma
 * access, and Figma screenshot URLs expire, so nothing in `content` may rely
 * on a live Figma fetch to be meaningful. Text, layout structure and token
 * names are captured verbatim; imagery is described, not linked.
 */

export interface DesignContextNode {
  /** Figma node id, e.g. "12:34" — kept for provenance, never re-fetched. */
  nodeId: string;
  /** Sanitised journey state / screen name this node renders. */
  state: string;
  /** Node type as Figma reports it (FRAME, TEXT, INSTANCE, ...). */
  type: string;
  /** Visible text content, verbatim, in document order. */
  text?: string;
  /** Design-token / variable names bound on this node, when reported. */
  tokens?: string[];
  /** Component name for INSTANCE nodes (e.g. a design-system component). */
  componentName?: string;
  children?: DesignContextNode[];
}

/**
 * One captured screen of the prototype. `description` is the fallback when
 * structured design context is unavailable for a state — a prose rendering of
 * the screenshot, produced at capture time so it survives URL expiry.
 */
export interface DesignContextState {
  state: string;
  root?: DesignContextNode;
  description?: string;
}

export interface DesignContextDocument {
  id: string;
  figmaFileKey: string;
  /** Monotonic per fileKey; a re-snapshot is a new version, never an edit. */
  version: number;
  capturedAt: string;
  states: DesignContextState[];
  /**
   * design-system component catalogue captured alongside, for mobile programmes —
   * the `extractComponentCatalogue` output serialised. Absent for web.
   */
  componentCatalogue?: unknown;
}

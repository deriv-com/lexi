/**
 * The four delivery controls a change passes on its way to production.
 *
 * Specification (an approved spec and its security track), Experience (the
 * people who asked for the change have used it), Engineering (the change is
 * built and tested) and Production (release approval).
 */
export const DELIVERY_CONTROLS = ["specification", "experience", "engineering", "production"] as const;
export type DeliveryControl = (typeof DELIVERY_CONTROLS)[number];

export interface DeliveryControlsEvaluation {
  /** Controls with evidence attached, in DELIVERY_CONTROLS order. */
  covered: DeliveryControl[];
  /** Controls with no evidence. Absence is a gap, never a pass. */
  gaps: DeliveryControl[];
  ok: boolean;
}

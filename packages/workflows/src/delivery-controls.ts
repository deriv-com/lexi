/**
 * Delivery controls — evaluated against supplied evidence.
 *
 * The four controls are Specification (the existing spec/security track),
 * Experience, Engineering and Production. Absence is a gap, not a pass.
 */

import {
  DELIVERY_CONTROLS,
  type DeliveryControl,
  type DeliveryControlsEvaluation,
} from "./delivery-controls.types";

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

export function evaluateDeliveryControls(
  evidenceByControl: Readonly<Partial<Record<DeliveryControl, string>>>,
): DeliveryControlsEvaluation {
  const covered: DeliveryControl[] = [];
  const gaps: DeliveryControl[] = [];

  for (const control of DELIVERY_CONTROLS) {
    if (blank(evidenceByControl[control])) {
      gaps.push(control);
    } else {
      covered.push(control);
    }
  }

  return { covered, gaps, ok: gaps.length === 0 };
}

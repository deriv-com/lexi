import type { CoverageDimension } from "@lexi/contracts";
import { COVERAGE_DIMENSIONS } from "./coverage-dimensions";
import { QUESTION_PROMPTS } from "./question-prompts";

/**
 * Feature-shaped intake fields, for the generalized
 * `IntakeConversationService`.
 *
 * The bug schema asks for reproduction steps, expected behaviour and actual
 * behaviour. A feature has none of those — there is nothing to reproduce — so
 * running a feature through the bug schema leaves a reporter two bad options:
 * be refused for missing evidence that cannot exist, or invent it. The second
 * is worse, because a fabricated reproduction is indistinguishable afterwards
 * from a real one.
 *
 * The feature schema is the nine coverage dimensions, so the intake loop and
 * the clarification loop are asking the same questions in the same order and
 * the answers land in the same coverage record.
 */

export interface IntakeFieldDescriptor {
  field: CoverageDimension;
  question: string;
  defaultAnswer: string;
  required: boolean;
  /** May be explicitly deferred by the user without blocking the draft. */
  deferrable: boolean;
}

/** Every dimension, in policy order, with its question and default. */
export const FEATURE_INTAKE_FIELDS: IntakeFieldDescriptor[] = COVERAGE_DIMENSIONS.map((dimension) => ({
  field: dimension,
  question: QUESTION_PROMPTS[dimension].question,
  defaultAnswer: QUESTION_PROMPTS[dimension].defaultAnswer,
  required: true,
  deferrable: false,
}));

/**
 * Applies a policy's mandatory/deferrable lists to the field set.
 *
 * Non-mandatory dimensions stay in the schema rather than being filtered out:
 * they are still worth asking when there is room in a batch, they are just not
 * allowed to block a draft.
 */
export function featureFieldSchemaFor(policy: {
  mandatoryDimensions: readonly CoverageDimension[];
  deferrableDimensions: readonly CoverageDimension[];
}): IntakeFieldDescriptor[] {
  const mandatory = new Set(policy.mandatoryDimensions);
  const deferrable = new Set(policy.deferrableDimensions);

  return FEATURE_INTAKE_FIELDS.map((descriptor) => ({
    ...descriptor,
    required: mandatory.has(descriptor.field),
    deferrable: deferrable.has(descriptor.field),
  }));
}

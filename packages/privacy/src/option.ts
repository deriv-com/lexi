import { createPiiMasker, type PiiCounts, type PiiMasker } from "./pii-masker";

/**
 * How a model client factory masks what it sends.
 *
 * Omitted means on, with the built-in detectors: a factory that is handed no
 * option masks. `false` turns masking off, which a deployment has to ask for
 * explicitly (MODEL_PII_MASKING=false).
 */
export type PiiMaskingOption =
  | false
  | {
      masker?: PiiMasker;
      /** Called once per request that masked something, with counts only. */
      onMasked?: (counts: PiiCounts) => void;
    };

/** The masker a factory should apply, or `undefined` when masking is off. */
export function resolvePiiMasking(
  option: PiiMaskingOption | undefined,
): { masker: PiiMasker; onMasked?: (counts: PiiCounts) => void } | undefined {
  if (option === false) return undefined;
  return { masker: option?.masker ?? createPiiMasker(), onMasked: option?.onMasked };
}

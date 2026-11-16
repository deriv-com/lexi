/**
 * @lexi/privacy — masks personal data out of text before it is sent to a model.
 *
 * A leaf package: no dependencies, so both the agent loop (`@lexi/agent`) and
 * the decision engine (`@lexi/ai`) can apply the same masker.
 */
export {
  PII_PLACEHOLDERS,
  addPiiCounts,
  createPiiMasker,
  describePiiCounts,
  emptyPiiCounts,
  ibanValid,
  luhnValid,
  maskStringLeaves,
  parsePiiPatternList,
  totalPiiCount,
  type PiiCounts,
  type PiiKind,
  type PiiMaskResult,
  type PiiMasker,
  type PiiMaskerOptions,
} from "./pii-masker";
export { type PiiMaskingOption, resolvePiiMasking } from "./option";

import { describe, expect, it } from "vitest";
import { evaluateEscalation } from "./escalation-policy";

/**
 * The judge's bar for needsDynamicReproduction is "a real browser OR device
 * session", which covers reading a console warning on a public URL as well as
 * capturing a selfie. The escalation notice must not announce "requires a human
 * on a real device" for both: a console check visible in any browser is browser
 * work, while an identity-verification state is genuinely human work.
 */
describe("dynamic reproduction kind", () => {
  const base = { needsDynamicReproduction: true };

  it("reports a browser-only case as browser work", () => {
    const result = evaluateEscalation({ ...base, dynamicReproductionKind: "browser" });
    expect(result?.classification).toBe("NEEDS_MANUAL_INVESTIGATION");
    expect(result?.dynamicKind).toBe("browser");
    expect(result?.summary).toContain("Live browser session");
    // The distinguishing claim: it must NOT assert a person is needed.
    expect(result?.reasoning).not.toContain("human on a real device");
    expect(result?.reasoning).toContain("no");
  });

  it("still says human when the judge identified a human-only step", () => {
    const result = evaluateEscalation({ ...base, dynamicReproductionKind: "human" });
    expect(result?.classification).toBe("NEEDS_MANUAL_INVESTIGATION");
    expect(result?.dynamicKind).toBe("human");
  });

  it("falls back to the cautious wording when the judge did not say", () => {
    const result = evaluateEscalation(base);
    expect(result?.classification).toBe("NEEDS_MANUAL_INVESTIGATION");
    expect(result?.dynamicKind).toBeNull();
    expect(result?.summary).toContain("Visual or dynamic");
  });

  it("ignores a value outside the vocabulary rather than trusting it", () => {
    const result = evaluateEscalation({ ...base, dynamicReproductionKind: "maybe" });
    expect(result?.dynamicKind).toBeNull();
  });

  it("does not invent a kind when no dynamic reproduction was requested", () => {
    const result = evaluateEscalation(
      { needsDynamicReproduction: false, dynamicReproductionKind: "browser" },
    );
    // Either null (no escalation) or some other rung, but never a dynamic
    // hand-off manufactured from the kind alone.
    expect(result?.dynamicKind).toBeUndefined();
  });
});

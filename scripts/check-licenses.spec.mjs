import { describe, expect, it } from "vitest";
import { isAllowed, licenseOf } from "./check-licenses.mjs";

describe("check-licenses", () => {
  it("reads every licence shape package.json uses", () => {
    expect(licenseOf({ license: "MIT" })).toBe("MIT");
    expect(licenseOf({ license: { type: "ISC" } })).toBe("ISC");
    expect(licenseOf({ licenses: [{ type: "MIT" }] })).toBe("MIT");
    expect(licenseOf({ licenses: [{ type: "MIT" }, { type: "GPL-2.0" }] })).toBe("(MIT OR GPL-2.0)");
    expect(licenseOf({})).toBeUndefined();
  });

  it("accepts an OR expression if any branch is allowed", () => {
    expect(isAllowed("(MIT OR GPL-3.0)")).toBe(true);
  });

  it("rejects an AND expression unless every term is allowed", () => {
    expect(isAllowed("MIT AND GPL-3.0")).toBe(false);
    expect(isAllowed("MIT AND BSD-3-Clause")).toBe(true);
  });

  it("rejects copyleft, unknown and missing licences", () => {
    expect(isAllowed("GPL-3.0")).toBe(false);
    expect(isAllowed("SEE LICENSE IN LICENSE.txt")).toBe(false);
    expect(isAllowed(undefined)).toBe(false);
  });
});

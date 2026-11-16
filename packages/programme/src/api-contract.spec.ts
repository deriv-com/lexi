import { describe, it, expect } from "vitest";
import { filterOpenApiSpec, InvalidOpenApiError } from "./api-contract";

/** Shaped like the real Acme Core document: mixed public/archived/admin tags. */
const SPEC = {
  openapi: "3.1.0",
  info: { title: "Acme Core", version: "1.1.0" },
  paths: {
    "/platform/trading/transactions": {
      get: { tags: ["Platform/Trading/Transactions"], summary: "List transactions" },
    },
    "/accounts/summary": {
      get: { tags: ["Acme Core/Client"], operationId: "getAccount" },
      // Same path, one public op and one internal op: the path survives with
      // only the public op.
      post: { tags: ["Trading V2 (INTERNAL)/OTP Management"] },
    },
    "/admin/clients": {
      get: { tags: ["Admin (Do Not Publish)/Clients"] },
      delete: { tags: ["Admin (Do Not Publish)/Clients"] },
    },
    "/legacy/thing": {
      get: { tags: ["Archived"] },
      parameters: [{ name: "x", in: "query" }],
    },
    "/untagged": {
      get: { summary: "No tags at all" },
    },
    "/mixed-tags": {
      // One excluded tag + one public tag → EXCLUDED: the real document
      // co-tags admin/archived ops with public-looking tags, so deny wins.
      get: { tags: ["Archived", "Acme Core/Config"] },
    },
  },
};

const EXCLUDES = ["archived", "admin (do not publish)", "(internal)", "internal"];

describe("filterOpenApiSpec", () => {
  it("removes archived/admin/internal operations and empties their paths", () => {
    const result = filterOpenApiSpec(SPEC, EXCLUDES);
    const paths = Object.keys(result.spec.paths as Record<string, unknown>);
    expect(paths).toContain("/platform/trading/transactions");
    expect(paths).toContain("/accounts/summary");
    expect(paths).toContain("/untagged");
    // Fully excluded paths disappear entirely — unseeable, not just unlisted.
    expect(paths).not.toContain("/admin/clients");
    expect(paths).not.toContain("/legacy/thing");
    // ANY excluded tag removes the op, even beside a public tag.
    expect(paths).not.toContain("/mixed-tags");
    expect(result.excludedOperationCount).toBe(5);
  });

  it("keeps the public op on a path that also had an internal one", () => {
    const result = filterOpenApiSpec(SPEC, EXCLUDES);
    const account = (result.spec.paths as Record<string, Record<string, unknown>>)["/accounts/summary"];
    expect(account.get).toBeDefined();
    expect(account.post).toBeUndefined();
  });

  it("an untagged operation is kept — untagged is not evidence of internal", () => {
    const result = filterOpenApiSpec(SPEC, EXCLUDES);
    expect(result.operations.some((op) => op.path === "/untagged")).toBe(true);
  });

  it("summarises surviving operations with method/path/tags", () => {
    const result = filterOpenApiSpec(SPEC, EXCLUDES);
    const tx = result.operations.find((op) => op.path === "/platform/trading/transactions");
    expect(tx).toMatchObject({ method: "GET", summary: "List transactions" });
    expect(result.info).toEqual({ title: "Acme Core", version: "1.1.0" });
  });

  it("throws when filtering leaves zero operations — an empty contract is worse than none", () => {
    expect(() =>
      filterOpenApiSpec(
        { info: {}, paths: { "/a": { get: { tags: ["Archived"] } } } },
        EXCLUDES,
      ),
    ).toThrow(InvalidOpenApiError);
  });

  it("throws on a document with no paths object", () => {
    expect(() => filterOpenApiSpec({ openapi: "3.1.0" }, EXCLUDES)).toThrow(InvalidOpenApiError);
    expect(() => filterOpenApiSpec("not an object", EXCLUDES)).toThrow(InvalidOpenApiError);
  });

  it("is deterministic", () => {
    expect(filterOpenApiSpec(SPEC, EXCLUDES)).toEqual(filterOpenApiSpec(SPEC, EXCLUDES));
  });
});

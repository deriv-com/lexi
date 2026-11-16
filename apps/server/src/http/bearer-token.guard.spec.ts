import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { BearerTokenGuard, bearerToken, tokensMatch } from "./bearer-token.guard";

function contextWith(authorization?: string | string[]): ExecutionContext {
  const request = { headers: authorization === undefined ? {} : { authorization } };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe("BearerTokenGuard", () => {
  it("refuses every request when the token is unset, even one that sends an empty bearer", () => {
    const guard = new BearerTokenGuard({ PROCESS_API_TOKEN: "" });
    for (const header of [undefined, "Bearer ", "Bearer anything", ""]) {
      expect(() => guard.canActivate(contextWith(header))).toThrow(ForbiddenException);
    }
  });

  it("returns 401 for a missing, malformed or wrong token", () => {
    const guard = new BearerTokenGuard({ PROCESS_API_TOKEN: "s3cret-test-token" });
    for (const header of [undefined, "s3cret-test-token", "Basic s3cret-test-token", "Bearer wrong", "Bearer s3cret-test-tokenX"]) {
      expect(() => guard.canActivate(contextWith(header))).toThrow(UnauthorizedException);
    }
  });

  it("lets the right token through, with any casing of the scheme", () => {
    const guard = new BearerTokenGuard({ PROCESS_API_TOKEN: "s3cret-test-token" });
    expect(guard.canActivate(contextWith("Bearer s3cret-test-token"))).toBe(true);
    expect(guard.canActivate(contextWith("bearer s3cret-test-token"))).toBe(true);
  });
});

describe("bearer token helpers", () => {
  it("extracts the token from the header", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken(["Bearer abc", "Bearer def"])).toBe("abc");
    expect(bearerToken("Bearer a b")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  it("compares tokens of different lengths without throwing", () => {
    expect(tokensMatch("short", "a-much-longer-token")).toBe(false);
    expect(tokensMatch("same", "same")).toBe(true);
  });
});

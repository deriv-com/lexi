import { createHash, timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { CONFIG_TOKEN } from "../tokens";

/**
 * Guards the action endpoints with a shared bearer token (`PROCESS_API_TOKEN`).
 *
 * An unset token refuses every request: an unconfigured deployment must not
 * expose an open write path. The comparison is constant-time over SHA-256
 * digests, so neither the token's content nor its length leaks through timing.
 */
@Injectable()
export class BearerTokenGuard implements CanActivate {
  constructor(@Inject(CONFIG_TOKEN) private readonly config: { PROCESS_API_TOKEN: string }) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.PROCESS_API_TOKEN ?? "";
    if (expected.length === 0) {
      throw new ForbiddenException("The action API is disabled: PROCESS_API_TOKEN is not set.");
    }
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const presented = bearerToken(request.headers["authorization"]);
    if (presented === undefined || !tokensMatch(presented, expected)) {
      throw new UnauthorizedException("A valid bearer token is required.");
    }
    return true;
  }
}

/** The token from an `Authorization: Bearer <token>` header, if there is one. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match ? match[1] : undefined;
}

export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

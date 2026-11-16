import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { bearerToken, tokensMatch } from "./bearer-token.guard";
import { PROGRAMME_HTTP_DEPS_TOKEN, type ProgrammeHttpDeps } from "./programme-http.deps";

type HeaderBag = { headers: Record<string, string | string[] | undefined> };

/**
 * The shared check, in a fixed order: the feature is enabled, the token is
 * CONFIGURED (an unset token is a misconfiguration and refuses everything,
 * never "auth disabled"), then the presented token matches in constant time.
 */
function check(context: ExecutionContext, enabled: boolean, expected: string, what: string, envKey: string): true {
  if (!enabled) throw new ForbiddenException(`${what} is disabled on this deployment.`);
  if (!expected) throw new ForbiddenException(`${what} is not configured: ${envKey} is not set.`);
  const request = context.switchToHttp().getRequest<HeaderBag>();
  const presented = bearerToken(request.headers["authorization"]);
  if (presented === undefined || !tokensMatch(presented, expected)) {
    throw new UnauthorizedException("A valid bearer token is required.");
  }
  return true;
}

/**
 * Guards the read side a runner fetches at start-up (briefs and the documents
 * they cite) with `PROGRAMME_BRIEF_TOKEN`. A different bearer from the
 * evidence token, so the read and write channels revoke independently.
 */
@Injectable()
export class ProgrammeBriefTokenGuard implements CanActivate {
  constructor(@Inject(PROGRAMME_HTTP_DEPS_TOKEN) private readonly deps: ProgrammeHttpDeps) {}

  canActivate(context: ExecutionContext): boolean {
    return check(context, this.deps.programmeEnabled, this.deps.briefToken ?? "", "The programme brief API", "PROGRAMME_BRIEF_TOKEN");
  }
}

/** Guards evidence ingest with `EVIDENCE_WEBHOOK_TOKEN`. */
@Injectable()
export class ProgrammeEvidenceTokenGuard implements CanActivate {
  constructor(@Inject(PROGRAMME_HTTP_DEPS_TOKEN) private readonly deps: ProgrammeHttpDeps) {}

  canActivate(context: ExecutionContext): boolean {
    return check(context, this.deps.evidenceEnabled, this.deps.evidenceToken ?? "", "Evidence ingest", "EVIDENCE_WEBHOOK_TOKEN");
  }
}

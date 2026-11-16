import type { Authorizer } from "@lexi/agent";
import type { AuthorizationService } from "@lexi/governance";

/**
 * Adapts `@lexi/governance`'s `AuthorizationService` to the registry's
 * `Authorizer` port. The service already fails closed (unknown people,
 * missing config, out-of-scope resources); the registry additionally treats
 * a throw or a malformed verdict as a denial, so nothing here needs to.
 */
export function governanceAuthorizer(service: Pick<AuthorizationService, "evaluate">): Authorizer {
  return {
    authorize(request) {
      const decision = service.evaluate({
        actorId: request.actorId,
        action: request.action,
        ...(request.resource ? { resource: { ...request.resource } } : {}),
      });
      return { allowed: decision.allowed === true, reason: decision.reason };
    },
  };
}

import type { AuthorizationResource } from "./agent-tool";

export interface AuthorizationRequest {
  actorId: string;
  action: string;
  resource?: AuthorizationResource;
}

export interface AuthorizationVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * Decides whether an actor may perform an action. The registry treats a
 * thrown error, a rejected promise or a malformed verdict as a denial.
 */
export interface Authorizer {
  authorize(request: AuthorizationRequest): AuthorizationVerdict | Promise<AuthorizationVerdict>;
}

/** Denies everything. The default when no authorizer is configured. */
export const DENY_ALL: Authorizer = {
  authorize: () => ({ allowed: false, reason: "No authorizer is configured, so every governed action is refused." }),
};

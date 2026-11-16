import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import { AuthorizationService, authorizationConfigSchema, type AuthorizationConfig } from "@lexi/governance";

export const AUTHORIZATION_FILE = "authorization.yaml";

/**
 * A config the service reports as not ready, so every evaluation is denied.
 * Version 0 and no roles is what `AuthorizationService.isReady()` reads as
 * "missing config".
 */
const DENY_ALL: AuthorizationConfig = {
  version: 0,
  defaults: { authenticatedRole: "viewer", unknownUserRole: "denied" },
  roles: {},
  users: {},
  groups: {},
};

export interface LoadedAuthorization {
  service: AuthorizationService;
  /** False when the file was missing, unreadable or invalid. */
  loaded: boolean;
  path: string;
  error?: string;
}

/**
 * Builds the authorization service from `<configDir>/authorization.yaml`.
 *
 * Fails closed. A missing or invalid file never throws and never falls back to
 * something permissive: it yields a service that refuses every governed
 * action, and the server's readiness check reports it. Reads are governed
 * too, so the agent can then only answer from what needs no tool.
 */
export function loadAuthorization(configDir: string): LoadedAuthorization {
  const path = resolve(configDir, AUTHORIZATION_FILE);
  try {
    const raw = parseYaml(readFileSync(path, "utf8"));
    const parsed = authorizationConfigSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      return denyAll(path, `invalid ${AUTHORIZATION_FILE}: ${issues.join("; ")}`);
    }
    const service = new AuthorizationService(parsed.data);
    if (!service.isReady()) {
      return { service, loaded: false, path, error: `${AUTHORIZATION_FILE} defines no roles or has version 0` };
    }
    return { service, loaded: true, path };
  } catch (error) {
    return denyAll(path, error instanceof Error ? error.message : String(error));
  }
}

function denyAll(path: string, error: string): LoadedAuthorization {
  return { service: new AuthorizationService(DENY_ALL), loaded: false, path, error };
}

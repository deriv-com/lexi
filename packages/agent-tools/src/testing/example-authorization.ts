import { readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { AuthorizationService, authorizationConfigSchema, type AuthorizationConfig } from "@lexi/governance";

/** The fictional Acme authorization config the tests run against (`GOVERNANCE_CONFIG_DIR`). */
export function loadExampleAuthorization(): AuthorizationConfig {
  const dir = process.env.GOVERNANCE_CONFIG_DIR || path.resolve(__dirname, "../../../../examples/config");
  return authorizationConfigSchema.parse(loadYaml(readFileSync(path.join(dir, "authorization.yaml"), "utf8")));
}

export function exampleAuthorizationService(): AuthorizationService {
  return new AuthorizationService(loadExampleAuthorization());
}

/** Every permission some role in the config grants, inheritance included. */
export function grantedPermissions(config: AuthorizationConfig): Set<string> {
  const all = new Set<string>();
  for (const role of Object.keys(config.roles)) {
    const service = new AuthorizationService({ ...config, users: { U0PROBE1: { roles: [role] } } });
    for (const permission of service.getEffectivePermissions("U0PROBE1")) all.add(permission);
  }
  return all;
}

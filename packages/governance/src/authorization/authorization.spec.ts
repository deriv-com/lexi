import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { load as loadYaml } from "js-yaml";
import { authorizationConfigSchema, type AuthorizationConfig } from "./authorization.schema";
import { AuthorizationService } from "./authorization.service";

/**
 * Role-hierarchy tests for the authorization policy.
 *
 * The first block exercises `AuthorizationService` inheritance in isolation.
 * The second block asserts invariants against the deployment's
 * `authorization.yaml` (in tests, the Acme example under `examples/config`).
 * The bugs these invariants guard against live in the policy file rather than
 * in the service — a policy file with no test is a policy nobody checked.
 */

const CONFIG_PATH = path.resolve(process.env.GOVERNANCE_CONFIG_DIR || "config", "authorization.yaml");

function loadRealConfig(): AuthorizationConfig {
  return authorizationConfigSchema.parse(loadYaml(readFileSync(CONFIG_PATH, "utf8")));
}

/**
 * Effective permissions of a ROLE, independent of who currently holds it.
 * Probing through a synthetic actor keeps these tests about the hierarchy
 * instead of pinning them to a particular person's Slack id.
 */
function permissionsForRole(config: AuthorizationConfig, role: string): Set<string> {
  const service = new AuthorizationService({ ...config, users: { U_PROBE: { roles: [role] } } });
  return new Set(service.getEffectivePermissions("U_PROBE"));
}

describe("AuthorizationService role inheritance", () => {
  it("unions permissions across multiple parents", () => {
    const config = authorizationConfigSchema.parse({
      version: 1,
      defaults: { authenticatedRole: "viewer", unknownUserRole: "denied" },
      roles: {
        viewer: { permissions: ["issue.read"] },
        qa: { inherits: ["viewer"], permissions: ["bug.submit"] },
        engineer: { inherits: ["viewer"], permissions: ["issue.keep_open"] },
        both: { inherits: ["qa", "engineer"], permissions: ["batch.execute"] },
      },
      users: { U_BOTH: { roles: ["both"] } },
    });
    const service = new AuthorizationService(config);

    expect(service.getEffectivePermissions("U_BOTH")).toEqual([
      "batch.execute",
      "bug.submit",
      "issue.keep_open",
      "issue.read",
    ]);
    expect(service.evaluate({ actorId: "U_BOTH", action: "issue.keep_open" }).allowed).toBe(true);
    expect(service.evaluate({ actorId: "U_BOTH", action: "bug.submit" }).allowed).toBe(true);
  });

  it("reaches a permission through a diamond without duplicating or dropping it", () => {
    const config = authorizationConfigSchema.parse({
      version: 1,
      defaults: { authenticatedRole: "viewer", unknownUserRole: "denied" },
      roles: {
        base: { permissions: ["issue.read"] },
        left: { inherits: ["base"], permissions: ["a"] },
        right: { inherits: ["base"], permissions: ["b"] },
        top: { inherits: ["left", "right"], permissions: [] },
      },
      users: { U_TOP: { roles: ["top"] } },
    });

    expect(new AuthorizationService(config).getEffectivePermissions("U_TOP")).toEqual([
      "a",
      "b",
      "issue.read",
    ]);
  });
});

describe("authorization.yaml — policy invariants", () => {
  it("grants project.write to team_lead and, by inheritance, platform_admin", () => {
    const config = loadRealConfig();

    expect(permissionsForRole(config, "team_lead").has("project.write")).toBe(true);
    expect(permissionsForRole(config, "platform_admin").has("project.write")).toBe(true);
    // Board writes are a coordination action, not a baseline engineering one.
    expect(permissionsForRole(config, "engineer").has("project.write")).toBe(false);
    expect(permissionsForRole(config, "viewer").has("project.write")).toBe(false);
  });

  it("never grants a broad batch action to a role denied the narrower single-issue hold", () => {
    const config = loadRealConfig();

    // batch.execute can process many issues in one command; issue.keep_open
    // holds exactly one issue open and is the more conservative act. A role
    // trusted with the former must hold the latter.
    const batchRoles = Object.keys(config.roles).filter((role) =>
      permissionsForRole(config, role).has("batch.execute"),
    );

    // Guard against the loop below passing because nothing holds batch.execute.
    expect(batchRoles.length).toBeGreaterThan(0);
    for (const role of batchRoles) {
      const perms = permissionsForRole(config, role);
      expect(perms.has("issue.keep_open"), `${role} holds batch.execute but not issue.keep_open`).toBe(true);
    }
  });

  it("gives qa_lead the engineer hold/cancel grants without losing the QA-only ones", () => {
    const perms = permissionsForRole(loadRealConfig(), "qa_lead");

    // From engineer.
    expect(perms.has("issue.keep_open")).toBe(true);
    expect(perms.has("pending_closure.cancel")).toBe(true);
    expect(perms.has("evidence.add")).toBe(true);
    // From qa. Inheriting `engineer` instead of `qa` would silently drop these.
    expect(perms.has("bug.submit")).toBe(true);
    expect(perms.has("investigation.manual.request")).toBe(true);
    // Its own grants, and the read baseline.
    expect(perms.has("batch.execute")).toBe(true);
    expect(perms.has("issue.read")).toBe(true);
    // A QA lead is still not a team lead or an admin.
    expect(perms.has("issue.reassign")).toBe(false);
    expect(perms.has("rollback.execute")).toBe(false);
  });

  it("keeps platform_admin a superset of every other role", () => {
    const config = loadRealConfig();
    const admin = permissionsForRole(config, "platform_admin");

    for (const role of Object.keys(config.roles)) {
      if (role === "platform_admin" || role === "security_reviewer") continue;
      const missing = [...permissionsForRole(config, role)].filter((p) => !admin.has(p));
      expect(missing, `platform_admin is missing ${role} permissions`).toEqual([]);
    }
  });

  it("still denies an identity absent from the policy", () => {
    const service = new AuthorizationService(loadRealConfig());
    const decision = service.evaluate({ actorId: "U_NOT_IN_POLICY", action: "project.write" });

    expect(decision.allowed).toBe(false);
    // Fail-closed is the invariant; the wording is not. The message must still
    // identify the actor so an operator can act on it.
    expect(decision.reason).toContain("U_NOT_IN_POLICY");
  });

  it("grants authorization.grant only to platform_admin", () => {
    const config = loadRealConfig();
    expect(permissionsForRole(config, "platform_admin").has("authorization.grant")).toBe(true);
    expect(permissionsForRole(config, "team_lead").has("authorization.grant")).toBe(false);
    expect(permissionsForRole(config, "engineer").has("authorization.grant")).toBe(false);
    expect(permissionsForRole(config, "viewer").has("authorization.grant")).toBe(false);
  });
});

describe("AuthorizationService runtime overlay", () => {
  function config(): AuthorizationConfig {
    return authorizationConfigSchema.parse({
      version: 1,
      defaults: { authenticatedRole: "viewer", unknownUserRole: "denied" },
      roles: {
        viewer: { permissions: ["issue.read"] },
        engineer: { inherits: ["viewer"], permissions: ["issue.process"] },
        platform_admin: { inherits: ["engineer"], permissions: ["authorization.grant"] },
      },
      users: {
        U_ADMIN: { name: "Admin", roles: ["platform_admin"] },
      },
    });
  }

  it("allows a runtime assignment that is not in YAML", () => {
    const service = new AuthorizationService(config());
    service.replaceRuntimeAssignments({
      U_NEW: { name: "New lead", roles: ["engineer"] },
    });

    const decision = service.evaluate({ actorId: "U_NEW", action: "issue.process" });
    expect(decision.allowed).toBe(true);
    expect(decision.matchedRoles).toContain("engineer");
    expect(service.getEffectivePermissions("U_NEW")).toEqual(["issue.process", "issue.read"]);
  });

  it("lets YAML win over a runtime assignment for the same Slack id", () => {
    const service = new AuthorizationService(config());
    service.replaceRuntimeAssignments({
      U_ADMIN: { name: "Impostor", roles: ["engineer"] },
    });

    expect(service.isBootstrapUser("U_ADMIN")).toBe(true);
    const decision = service.evaluate({ actorId: "U_ADMIN", action: "authorization.grant" });
    expect(decision.allowed).toBe(true);
    expect(service.getEffectivePermissions("U_ADMIN")).toContain("authorization.grant");
  });

  it("drops YAML ids from replaceRuntimeAssignments so they cannot shadow bootstrap", () => {
    const service = new AuthorizationService(config());
    service.replaceRuntimeAssignments({
      U_ADMIN: { name: "Impostor", roles: ["engineer"] },
      U_NEW: { name: "New", roles: ["engineer"] },
    });
    service.removeRuntimeAssignment("U_NEW");

    expect(service.evaluate({ actorId: "U_NEW", action: "issue.process" }).allowed).toBe(false);
    expect(service.evaluate({ actorId: "U_ADMIN", action: "authorization.grant" }).allowed).toBe(true);
  });
});

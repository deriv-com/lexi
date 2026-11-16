/**
 * Spec, work-item and memory permissions.
 *
 * Asserted against the deployment's authorization.yaml (in tests, the Acme
 * example under `examples/config`), following the precedent in
 * authorization.spec.ts: the bugs this file guards against live in the YAML,
 * not in the service, and a policy file with no test is a policy nobody checked.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { load as loadYaml } from "js-yaml";
import { authorizationConfigSchema, type AuthorizationConfig } from "./authorization.schema";
import { AuthorizationService } from "./authorization.service";

const CONFIG_PATH = path.resolve(process.env.GOVERNANCE_CONFIG_DIR || "config", "authorization.yaml");

function loadConfig(): AuthorizationConfig {
  return authorizationConfigSchema.parse(loadYaml(readFileSync(CONFIG_PATH, "utf8")));
}

/** Effective permissions of a role, independent of who currently holds it. */
function permissionsForRole(config: AuthorizationConfig, role: string): Set<string> {
  const service = new AuthorizationService({ ...config, users: { U_PROBE: { roles: [role] } } });
  return new Set(service.getEffectivePermissions("U_PROBE"));
}

describe("spec authoring", () => {
  it("grants spec.create at the engineer rung", () => {
    // Authoring a spec creates a reviewable artefact and changes no software.
    expect(permissionsForRole(loadConfig(), "engineer")).toContain("spec.create");
  });

  it("grants spec.create at the qa rung", () => {
    // QA raises most of the requests that become specs.
    expect(permissionsForRole(loadConfig(), "qa")).toContain("spec.create");
  });

  it("grants spec.revise and spec.submit_review wherever spec.create is granted", () => {
    // Authoring without revising leaves a draft its author cannot correct.
    const config = loadConfig();
    for (const role of Object.keys(config.roles)) {
      const perms = permissionsForRole(config, role);
      if (!perms.has("spec.create")) continue;
      expect(perms, role).toContain("spec.revise");
      expect(perms, role).toContain("spec.submit_review");
    }
  });

  it("does NOT grant spec.create to viewer", () => {
    expect(permissionsForRole(loadConfig(), "viewer")).not.toContain("spec.create");
  });
});

describe("spec approval", () => {
  it("grants spec.approve at engineer and cascades it upward", () => {
    const config = loadConfig();
    for (const role of ["engineer", "team_lead", "qa_lead", "platform_admin"]) {
      expect(permissionsForRole(config, role), role).toContain("spec.approve");
    }
  });

  it("withholds spec.approve from qa and viewer", () => {
    const config = loadConfig();
    expect(permissionsForRole(config, "qa")).not.toContain("spec.approve");
    expect(permissionsForRole(config, "viewer")).not.toContain("spec.approve");
  });

  it("keeps spec.supersede on team_lead, never at the engineer rung", () => {
    const config = loadConfig();
    expect(permissionsForRole(config, "team_lead")).toContain("spec.supersede");
    expect(permissionsForRole(config, "engineer")).not.toContain("spec.supersede");
  });

  it("scopes spec.approve by team for a scoped team_lead", () => {
    const config = loadConfig();
    const service = new AuthorizationService({
      ...config,
      users: { U_LEAD: { roles: ["team_lead"], scopes: { teams: ["web"], repositories: [] } } },
    });

    expect(
      service.evaluate({ actorId: "U_LEAD", action: "spec.approve", resource: { team: "web" } }).allowed,
    ).toBe(true);

    const outOfScope = service.evaluate({
      actorId: "U_LEAD",
      action: "spec.approve",
      resource: { team: "payments" },
    });
    expect(outOfScope.allowed).toBe(false);
    // The refusal names the permission, so the reader knows what was missing.
    expect(outOfScope.reason).toContain("spec.approve");
  });

  it("honours the scope written in the example file", () => {
    // Alice leads home only.
    const service = new AuthorizationService(loadConfig());
    expect(
      service.evaluate({ actorId: "U0TEST01", action: "spec.supersede", resource: { team: "home" } }).allowed,
    ).toBe(true);
    expect(
      service.evaluate({ actorId: "U0TEST01", action: "spec.supersede", resource: { team: "p2p" } }).allowed,
    ).toBe(false);
  });
});

describe("work items and memory", () => {
  it("grants work_item.create at the engineer and qa rungs", () => {
    const config = loadConfig();
    expect(permissionsForRole(config, "engineer")).toContain("work_item.create");
    expect(permissionsForRole(config, "qa")).toContain("work_item.create");
  });

  it("does not grant work_item.create to viewer", () => {
    expect(permissionsForRole(loadConfig(), "viewer")).not.toContain("work_item.create");
  });

  it("grants memory.recall at the viewer rung so every authenticated role has it", () => {
    // Recall is a read. Putting it above viewer would make the agent forget
    // selectively depending on who is talking to it.
    const config = loadConfig();
    for (const role of Object.keys(config.roles)) {
      expect(permissionsForRole(config, role), role).toContain("memory.recall");
    }
  });
});

describe("AuthorizationService stays fail-closed", () => {
  const ACTIONS = [
    "spec.create",
    "spec.revise",
    "spec.submit_review",
    "spec.approve",
    "spec.supersede",
    "work_item.create",
    "memory.recall",
  ];

  it("denies an unknown Slack identity every permission", () => {
    const service = new AuthorizationService(loadConfig());
    for (const action of ACTIONS) {
      const decision = service.evaluate({ actorId: "U_NOT_IN_CONFIG", action });
      expect(decision.allowed, action).toBe(false);
      // The refusal must name the permission that was needed; the exact prose is
      // not a contract (see authorization-denial-message.spec.ts).
      expect(decision.reason, action).toContain(action);
    }
  });

  it("denies every permission when the config is empty (service not ready)", () => {
    const service = new AuthorizationService({
      version: 0,
      defaults: { authenticatedRole: "viewer", unknownUserRole: "denied" },
      roles: {},
      users: {},
      groups: {},
    });
    expect(service.isReady()).toBe(false);
    for (const action of ACTIONS) {
      expect(service.evaluate({ actorId: "U_ANY", action }).allowed, action).toBe(false);
    }
  });

  it("keeps the unknown-user default at denied", () => {
    expect(loadConfig().defaults.unknownUserRole).toBe("denied");
  });

  it("does not grant an unregistered spec action by prefix", () => {
    const config = loadConfig();
    const service = new AuthorizationService({ ...config, users: { U_ADMIN: { roles: ["platform_admin"] } } });
    expect(service.evaluate({ actorId: "U_ADMIN", action: "spec.delete" }).allowed).toBe(false);
    expect(service.evaluate({ actorId: "U_ADMIN", action: "spec.*" }).allowed).toBe(false);
  });
});

describe("closing, merging and holding", () => {
  it("gives the closure holds to every rung that may close", () => {
    // The undo travels with the action. A rung that may close a ticket but
    // cannot hold one open — or cancel a closure it already scheduled — is
    // strictly worse than one that can do neither. Iterates every role, so a
    // rung granted the close later cannot slip past by not being named here.
    const config = loadConfig();
    const closers = Object.keys(config.roles).filter((r) => permissionsForRole(config, r).has("issue.close"));
    expect(closers.length).toBeGreaterThan(0);
    for (const role of closers) {
      const perms = permissionsForRole(config, role);
      expect(perms, `${role} may close but cannot hold open`).toContain("issue.keep_open");
      expect(perms, `${role} may close but cannot cancel a pending closure`).toContain("pending_closure.cancel");
    }
  });

  it("does NOT give issue.close to the read-only rungs", () => {
    // viewer is defaults.authenticatedRole — a grant there would let any
    // authenticated workspace member close a ticket.
    const config = loadConfig();
    for (const role of ["viewer", "security_reviewer"]) {
      expect(permissionsForRole(config, role), role).not.toContain("issue.close");
    }
  });

  it("keeps merge and close of pull requests off the read-only and QA rungs", () => {
    const config = loadConfig();
    for (const role of ["viewer", "qa", "security_reviewer"]) {
      const perms = permissionsForRole(config, role);
      for (const p of ["pr.merge", "branch.merge", "pr.close"]) {
        expect(perms.has(p), `${role} holds ${p}`).toBe(false);
      }
    }
  });

  it("grants each permission once and lets the rungs above inherit it", () => {
    // A second explicit copy on a role that already inherits the permission
    // would survive a revert of the first and silently keep that rung at the
    // old level.
    const config = loadConfig();
    for (const [name, role] of Object.entries(config.roles)) {
      const inherited = new Set<string>();
      for (const parent of role.inherits ?? []) {
        for (const p of permissionsForRole(config, parent)) inherited.add(p);
      }
      const duplicated = (role.permissions ?? []).filter((p) => inherited.has(p));
      expect(duplicated, `${name} restates inherited permissions`).toEqual([]);
    }
  });
});

describe("GitHub Actions inspect/cancel", () => {
  it("lets every authenticated viewer read run status, logs, and artifacts", () => {
    const config = loadConfig();
    expect(permissionsForRole(config, "viewer")).toContain("actions.read");
    expect(permissionsForRole(config, "viewer")).not.toContain("actions.cancel");
  });

  it("lets qa and engineer cancel a run they asked to stop", () => {
    const config = loadConfig();
    for (const role of ["qa", "engineer", "team_lead"]) {
      expect(permissionsForRole(config, role), role).toContain("actions.cancel");
    }
  });
});

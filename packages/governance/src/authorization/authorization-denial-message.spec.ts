import { describe, expect, it } from "vitest";
import { AuthorizationService } from "./authorization.service";
import type { AuthorizationConfig } from "./authorization.schema";

/**
 * A denial is the only thing most people will ever see from the authorization
 * layer, and it is the moment they most need to know what to do next. These
 * tests pin the three things a refusal must carry: who was refused (by name,
 * not an opaque Slack id), what they needed, and who can grant it.
 */
const config: AuthorizationConfig = {
  version: 1,
  defaults: { authenticatedRole: "viewer", unknownUserRole: "denied" },
  roles: {
    viewer: { description: "read only", permissions: ["issue.read"], inherits: [] },
    engineer: { description: "engineers", permissions: ["quick_fix.trigger"], inherits: ["viewer"] },
    team_lead: { description: "leads", permissions: ["spec.approve"], inherits: ["engineer"] },
    platform_admin: { description: "admins", permissions: ["rollback.execute"], inherits: ["team_lead"] },
  },
  users: {
    UADMIN1: { name: "Alice", roles: ["platform_admin"] },
    UADMIN2: { name: "Mallory", roles: ["platform_admin"] },
    UENG: { name: "Erin", roles: ["engineer"] },
    ULEAD: { name: "Bob", roles: ["team_lead"], scopes: { teams: ["Web"] } },
  },
  groups: {},
} as unknown as AuthorizationConfig;

const service = new AuthorizationService(config);

describe("denial messages", () => {
  describe("an unknown Slack identity", () => {
    const decision = service.evaluate({ actorId: "UNOBODY", action: "quick_fix.trigger" });

    it("refuses", () => {
      expect(decision.allowed).toBe(false);
    });

    it("names the permission that was needed", () => {
      expect(decision.reason).toContain("quick_fix.trigger");
    });

    it("gives a next step without listing the admins to someone the access list does not know", () => {
      // A guest or Slack Connect member is not told who holds platform_admin.
      expect(decision.reason).toContain("platform admin");
      expect(decision.reason).not.toContain("Alice");
      expect(decision.reason).not.toContain("Mallory");
    });

    it("does not dead-end on an opaque id with no remedy", () => {
      // The old message was "Unknown Slack identity U… — denied by default policy."
      // Correct, and useless to the person reading it.
      expect(decision.reason).not.toMatch(/^Unknown Slack identity \S+ — denied by default policy\.$/);
    });
  });

  describe("a known user missing the permission", () => {
    const decision = service.evaluate({ actorId: "UENG", action: "rollback.execute" });

    it("refuses", () => {
      expect(decision.allowed).toBe(false);
    });

    it("addresses the person by name rather than by Slack id", () => {
      expect(decision.reason).toContain("Erin");
    });

    it("names the permission and who can grant it", () => {
      expect(decision.reason).toContain("rollback.execute");
      expect(decision.reason).toContain("Alice");
    });
  });

  describe("a user scoped out of the resource's team", () => {
    const decision = service.evaluate({
      actorId: "ULEAD",
      action: "spec.approve",
      resource: { team: "Mobile" },
    });

    it("refuses", () => {
      expect(decision.allowed).toBe(false);
    });

    it("explains it is a scope problem, not a missing permission", () => {
      // This person HAS spec.approve. Telling them to ask for the permission
      // they already hold would send them on a pointless errand.
      expect(decision.reason).toContain("Web");
      expect(decision.reason).toContain("Mobile");
    });
  });

  /**
   * With the access list cut to four people, most refusals are now expected
   * rather than an oversight. `defaults.accessContact` makes the refusal say
   * so and names one person to ask, instead of listing every admin.
   */
  describe("when defaults.accessContact names a single contact", () => {
    const contactService = new AuthorizationService({
      ...config,
      defaults: { ...config.defaults, accessContact: "Alice" },
    } as unknown as AuthorizationConfig);

    const unknown = contactService.evaluate({ actorId: "UNOBODY", action: "quick_fix.trigger" });
    const knownButUnprivileged = contactService.evaluate({ actorId: "UENG", action: "rollback.execute" });

    it("still refuses", () => {
      expect(unknown.allowed).toBe(false);
      expect(knownButUnprivileged.allowed).toBe(false);
    });

    it("names the contact to ask", () => {
      expect(unknown.reason).toContain("Alice");
      expect(knownButUnprivileged.reason).toContain("Alice");
    });

    it("says the limitation is deliberate, not a fault", () => {
      expect(unknown.reason).toContain("deliberately limited");
      expect(knownButUnprivileged.reason).toContain("deliberately limited");
    });

    it("does not send the person to the other admins", () => {
      // The whole point of the override: Mallory is still platform_admin in
      // this config and the derived hint would name him, but access requests
      // are meant to land with one person.
      expect(unknown.reason).not.toContain("Mallory");
      expect(knownButUnprivileged.reason).not.toContain("Mallory");
    });

    it("still names the permission that was needed", () => {
      expect(unknown.reason).toContain("quick_fix.trigger");
      expect(knownButUnprivileged.reason).toContain("rollback.execute");
    });

    it("leaves the derived hint alone for known people when no contact is configured", () => {
      // The original service has no accessContact — a listed person missing a
      // permission still gets every admin's name. Unknown callers do not.
      const derived = service.evaluate({ actorId: "UENG", action: "rollback.execute" });
      expect(derived.reason).toContain("Alice");
      expect(derived.reason).toContain("Mallory");
      expect(derived.reason).not.toContain("deliberately limited");
    });
  });

  describe("accessRefusal", () => {
    it("refuses an unlisted person without naming the admins", () => {
      const refusal = service.accessRefusal("UNOBODY");
      expect(refusal).toContain("not in the access list");
      expect(refusal).not.toContain("Alice");
      expect(refusal).not.toContain("Mallory");
    });

    it("names the configured contact", () => {
      const withContact = new AuthorizationService({
        ...config,
        defaults: { ...config.defaults, accessContact: "Grace (#acme-platform)" },
      } as unknown as AuthorizationConfig);
      expect(withContact.accessRefusal("UNOBODY")).toContain("Grace (#acme-platform)");
    });

    it("lets listed people through, and everyone when unlisted people default to a role", () => {
      expect(service.accessRefusal("UENG")).toBeUndefined();
      const open = new AuthorizationService({
        ...config,
        defaults: { ...config.defaults, unknownUserRole: "viewer" },
      } as unknown as AuthorizationConfig);
      expect(open.accessRefusal("UNOBODY")).toBeUndefined();
    });
  });

  describe("a scoped grant on an action that names no resource", () => {
    it("refuses an action with no resource at all", () => {
      const d = service.evaluate({ actorId: "ULEAD", action: "spec.approve" });
      expect(d.allowed).toBe(false);
      expect(d.reason).toContain("names no team");
    });

    it("refuses a resource that names a repository but no team", () => {
      // A repository repos.yaml gives no team cannot be checked against a team scope.
      const d = service.evaluate({ actorId: "ULEAD", action: "spec.approve", resource: { repository: "acme/web" } });
      expect(d.allowed).toBe(false);
    });

    it("allows an action confined to the caller", () => {
      const d = service.evaluate({ actorId: "ULEAD", action: "issue.read", resource: { callerOnly: true } });
      expect(d.allowed).toBe(true);
    });

    it("leaves an unscoped grant unaffected", () => {
      expect(service.evaluate({ actorId: "UENG", action: "quick_fix.trigger" }).allowed).toBe(true);
    });
  });

  describe("a repository-scoped grant", () => {
    const repoScoped = new AuthorizationService({
      ...config,
      users: { UREPO: { name: "Rae", roles: ["engineer"], scopes: { teams: [], repositories: ["acme/web"] } } },
    } as unknown as AuthorizationConfig);

    it("allows its repository and refuses another", () => {
      expect(repoScoped.evaluate({ actorId: "UREPO", action: "quick_fix.trigger", resource: { repository: "acme/web" } }).allowed).toBe(true);
      expect(repoScoped.evaluate({ actorId: "UREPO", action: "quick_fix.trigger", resource: { repository: "acme/api" } }).allowed).toBe(false);
    });

    it("refuses a resource that names only a team", () => {
      expect(repoScoped.evaluate({ actorId: "UREPO", action: "quick_fix.trigger", resource: { team: "Web" } }).allowed).toBe(false);
    });
  });

  describe("granting still works", () => {
    it("allows a permitted action", () => {
      expect(service.evaluate({ actorId: "UENG", action: "quick_fix.trigger" }).allowed).toBe(true);
    });

    it("allows an in-scope team resource", () => {
      const d = service.evaluate({ actorId: "ULEAD", action: "spec.approve", resource: { team: "Web" } });
      expect(d.allowed).toBe(true);
    });
  });
});

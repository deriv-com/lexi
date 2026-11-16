import { describe, expect, it } from "vitest";
import { AuthorizationService } from "./authorization.service";
import type { AuthorizationConfig } from "./authorization.schema";

/**
 * `describeCaller` exists because the agent prompt had no notion of who was
 * speaking. Thread summaries are keyed by thread, not by user, so one person's
 * refusal was replayed into the next person's turn — and a platform_admin got
 * refused on an engineer's denial without the tool ever being called.
 *
 * These tests pin the two properties that make that fix work: the description
 * matches what `evaluate` would actually do, and it never widens anything.
 */
const config: AuthorizationConfig = {
  version: 1,
  defaults: { authenticatedRole: "viewer", unknownUserRole: "denied" },
  roles: {
    viewer: { description: "read only", permissions: ["issue.read"], inherits: [] },
    engineer: { description: "engineers", permissions: ["quick_fix.trigger"], inherits: ["viewer"] },
    platform_admin: { description: "admins", permissions: ["branch.merge"], inherits: ["engineer"] },
  },
  users: {
    UADMIN: { name: "Mallory", roles: ["platform_admin"] },
    UENG: { name: "Ivan", roles: ["engineer"] },
  },
  groups: {},
} as unknown as AuthorizationConfig;

const service = new AuthorizationService(config);

describe("describeCaller", () => {
  it("names a known caller and their roles", () => {
    expect(service.describeCaller("UADMIN")).toEqual({
      id: "UADMIN",
      name: "Mallory",
      roles: ["platform_admin"],
      known: true,
    });
  });

  it("marks an identity absent from the access list as unknown", () => {
    const caller = service.describeCaller("UNOBODY");
    expect(caller.known).toBe(false);
    expect(caller.name).toBeUndefined();
  });

  it("reports no roles for an unknown identity when the default is denied", () => {
    // Mirrors `evaluate`, which refuses outright rather than falling through.
    expect(service.describeCaller("UNOBODY").roles).toEqual([]);
  });

  it("reports the default role when unknown identities fall through instead", () => {
    const permissive = new AuthorizationService({
      ...config,
      defaults: { authenticatedRole: "viewer", unknownUserRole: "viewer" },
    } as unknown as AuthorizationConfig);
    expect(permissive.describeCaller("UNOBODY").roles).toEqual(["viewer"]);
  });

  it("never advertises a role the evaluator would not honour", () => {
    // The regression this whole change exists for: two callers in one thread,
    // one refused and one permitted, must describe differently.
    const admin = service.describeCaller("UADMIN");
    const engineer = service.describeCaller("UENG");

    expect(admin.roles).not.toEqual(engineer.roles);
    expect(service.evaluate({ actorId: "UADMIN", action: "branch.merge" }).allowed).toBe(true);
    expect(service.evaluate({ actorId: "UENG", action: "branch.merge" }).allowed).toBe(false);
  });

  it("does not mutate state — describing a caller grants nothing", () => {
    service.describeCaller("UENG");
    expect(service.evaluate({ actorId: "UENG", action: "branch.merge" }).allowed).toBe(false);
  });

  it("returns a defensive copy of roles", () => {
    const caller = service.describeCaller("UADMIN");
    caller.roles.push("smuggled");
    expect(service.describeCaller("UADMIN").roles).toEqual(["platform_admin"]);
  });
});

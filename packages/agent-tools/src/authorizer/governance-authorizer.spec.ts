import { describe, expect, it, vi } from "vitest";
import { governanceAuthorizer } from "./governance-authorizer";
import { exampleAuthorizationService } from "../testing/example-authorization";

describe("governanceAuthorizer", () => {
  it("passes actor, action and resource to the service and maps its decision", () => {
    const evaluate = vi.fn(() => ({ allowed: true, reason: "ok", actorId: "U0TEST01", action: "issue.comment", matchedRoles: [], matchedPermissions: [], policyVersion: 1 }));
    const verdict = governanceAuthorizer({ evaluate }).authorize({ actorId: "U0TEST01", action: "issue.comment", resource: { repository: "acme/web", issueNumber: 3 } });
    expect(evaluate).toHaveBeenCalledWith({ actorId: "U0TEST01", action: "issue.comment", resource: { repository: "acme/web", issueNumber: 3 } });
    expect(verdict).toEqual({ allowed: true, reason: "ok" });
  });

  it("applies the example roles, team scopes and the unknown-user default", () => {
    const authorizer = governanceAuthorizer(exampleAuthorizationService());
    // Carol is an engineer.
    expect(authorizer.authorize({ actorId: "U0TEST03", action: "pr.merge" })).toMatchObject({ allowed: true });
    // Erin is QA: she may comment but not merge.
    expect(authorizer.authorize({ actorId: "U0TEST05", action: "issue.comment" })).toMatchObject({ allowed: true });
    expect(authorizer.authorize({ actorId: "U0TEST05", action: "pr.merge" })).toMatchObject({ allowed: false });
    // Alice leads the home team only.
    expect(authorizer.authorize({ actorId: "U0TEST01", action: "pr.merge", resource: { team: "home" } })).toMatchObject({ allowed: true });
    expect(authorizer.authorize({ actorId: "U0TEST01", action: "pr.merge", resource: { team: "p2p" } })).toMatchObject({ allowed: false });
    // Someone not in the access list.
    expect(authorizer.authorize({ actorId: "U0TEST99", action: "issue.comment" })).toMatchObject({ allowed: false });
  });
});

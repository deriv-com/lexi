import { describe, expect, it } from "vitest";
import { APP_BUILD_AUDIT_ACTIONS, AuditLogAppBuildStore, InMemoryAppBuildStore, appBuildPrKey, type AppBuildStore } from "./store";
import { FakeAuditPrisma } from "./testing/fake-github";

const PR = appBuildPrKey("acme", "web", 7);

describe.each([
  ["in memory", () => new InMemoryAppBuildStore()],
  ["audit log", () => new AuditLogAppBuildStore(new FakeAuditPrisma())],
])("%s store", (_name, make: () => AppBuildStore) => {
  it("folds thread, relays and notices into the relay state; history counts as handled but not as the high-water mark", async () => {
    const store = make();
    await store.recordThread(PR, { app: "web", channel: "C0TEST01", threadTs: "1.1", prNumber: 7, backlogCommentIds: [10, 11] });
    await store.recordRelay(PR, { app: "web", commentId: 12, kind: "report", session: 3 });
    await store.recordNotice(PR, "ceiling");
    await store.recordRelay(appBuildPrKey("acme", "web", 8), { app: "web", commentId: 99, kind: "report", session: 1 });
    const state = await store.loadRelayState(PR);
    expect(state.threadTs).toBe("1.1");
    expect(state.channel).toBe("C0TEST01");
    expect([...state.relayedCommentIds].sort()).toEqual([10, 11, 12]);
    expect(state.lastRelayedCommentId).toBe(12);
    expect([...state.notices]).toEqual(["ceiling"]);
  });

  it("is empty for a PR it has never seen", async () => {
    const state = await make().loadRelayState(PR);
    expect(state).toMatchObject({ threadTs: null, channel: null, lastRelayedCommentId: 0 });
  });

  it("answers max_sessions from the newest start for that repository and app only", async () => {
    const store = make();
    await store.recordAction("U0TEST01", APP_BUILD_AUDIT_ACTIONS.START, { repo: "acme/web", app: "web", maxSessions: 12 });
    await store.recordAction("U0TEST01", APP_BUILD_AUDIT_ACTIONS.START, { repo: "acme/web", app: "mobile", maxSessions: 30 });
    await store.recordAction("U0TEST01", APP_BUILD_AUDIT_ACTIONS.START, { repo: "acme/api", app: "web", maxSessions: 40 });
    expect(await store.lastDispatchedMaxSessions("acme/web", "web")).toBe(12);
    await store.recordAction("U0TEST02", APP_BUILD_AUDIT_ACTIONS.START, { repo: "acme/web", app: "web", maxSessions: null });
    expect(await store.lastDispatchedMaxSessions("acme/web", "web")).toBeNull();
    expect(await store.lastDispatchedMaxSessions("acme/web", "mobile")).toBe(30);
  });
});

describe("audit log store", () => {
  it("writes plain rows with the actor, action and details, and no thread key", async () => {
    const prisma = new FakeAuditPrisma();
    await new AuditLogAppBuildStore(prisma).recordAction("U0TEST01", APP_BUILD_AUDIT_ACTIONS.STOP, { repo: "acme/web", prNumber: 7 });
    expect(prisma.rows).toEqual([
      expect.objectContaining({ actor: "U0TEST01", action: "app_build.stop", details: { repo: "acme/web", prNumber: 7 } }),
    ]);
    expect(prisma.rows[0]).not.toHaveProperty("threadKey");
  });
});

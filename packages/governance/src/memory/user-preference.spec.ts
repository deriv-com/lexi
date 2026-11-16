import { describe, it, expect, vi } from "vitest";
import { UserPreferenceService, type UserPreferenceStore } from "./user-preference.service";

function createInMemoryStore(): UserPreferenceStore {
  const records = new Map<string, any>();
  return {
    userPreference: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const existing = records.get(where.slackId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const record = { ...create, createdAt: new Date() };
        records.set(where.slackId, record);
        return record;
      }),
      findUnique: vi.fn(async ({ where }) => records.get(where.slackId) ?? null),
      findMany: vi.fn(async () => [...records.values()]),
    },
  };
}

describe("UserPreferenceService", () => {
  it("returns defaults for unknown user", async () => {
    const store = createInMemoryStore();
    const service = new UserPreferenceService(store);

    const profile = await service.getProfile("U_UNKNOWN");

    expect(profile.slackId).toBe("U_UNKNOWN");
    expect(profile.detailLevel).toBe("standard");
    expect(profile.role).toBe("engineer");
    expect(profile.watchedIssues).toEqual([]);
  });

  it("creates profile on first update", async () => {
    const store = createInMemoryStore();
    const service = new UserPreferenceService(store);

    const profile = await service.updateProfile("U0TEST01", {
      githubLogin: "mallory",
      displayName: "Mallory",
      detailLevel: "detailed",
      timezone: "Asia/Kolkata",
      role: "admin",
      teams: ["platform"],
      ownedComponents: ["eio", "lexi"],
    });

    expect(profile.slackId).toBe("U0TEST01");
    expect(profile.detailLevel).toBe("detailed");
    expect(profile.role).toBe("admin");
    expect(profile.ownedComponents).toContain("lexi");
  });

  it("updates existing profile without overwriting unrelated fields", async () => {
    const store = createInMemoryStore();
    const service = new UserPreferenceService(store);

    await service.updateProfile("U1", { displayName: "Bob", role: "engineer", teams: ["web"] });
    await service.updateProfile("U1", { timezone: "Asia/Dubai" });

    const profile = await service.getProfile("U1");
    expect(profile.displayName).toBe("Bob");
    expect(profile.timezone).toBe("Asia/Dubai");
    expect(profile.teams).toContain("web");
  });

  it("sets detail level", async () => {
    const store = createInMemoryStore();
    const service = new UserPreferenceService(store);

    await service.setDetailLevel("U1", "brief");
    const profile = await service.getProfile("U1");
    expect(profile.detailLevel).toBe("brief");
  });

  it("watches and unwatches issues", async () => {
    const store = createInMemoryStore();
    const service = new UserPreferenceService(store);

    await service.updateProfile("U1", { watchedIssues: [] });
    await service.watchIssue("U1", 856);
    await service.watchIssue("U1", 909);

    let profile = await service.getProfile("U1");
    expect(profile.watchedIssues).toContain(856);
    expect(profile.watchedIssues).toContain(909);

    await service.unwatchIssue("U1", 856);
    profile = await service.getProfile("U1");
    expect(profile.watchedIssues).not.toContain(856);
    expect(profile.watchedIssues).toContain(909);
  });

  it("watching same issue twice is idempotent", async () => {
    const store = createInMemoryStore();
    const service = new UserPreferenceService(store);

    await service.updateProfile("U1", { watchedIssues: [] });
    await service.watchIssue("U1", 856);
    await service.watchIssue("U1", 856);

    const profile = await service.getProfile("U1");
    expect(profile.watchedIssues.filter((n) => n === 856)).toHaveLength(1);
  });

  it("getWatchers finds users watching a specific issue", async () => {
    const store = createInMemoryStore();
    const service = new UserPreferenceService(store);

    await service.updateProfile("U1", { watchedIssues: [856, 900] });
    await service.updateProfile("U2", { watchedIssues: [856] });
    await service.updateProfile("U3", { watchedIssues: [900] });

    const watchers = await service.getWatchers(856);
    expect(watchers).toHaveLength(2);
    expect(watchers.map((w) => w.slackId).sort()).toEqual(["U1", "U2"]);
  });
});

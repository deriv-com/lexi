import type { DetailLevel, UserProfile, UserRole } from "./memory.types";

/**
 * Minimal Prisma port for user preferences.
 */
export interface UserPreferenceStore {
  userPreference: {
    upsert(args: {
      where: { slackId: string };
      create: {
        id: string;
        slackId: string;
        githubLogin?: string;
        displayName?: string;
        detailLevel: string;
        timezone?: string;
        role: string;
        teams: string[];
        watchedRepos: string[];
        watchedIssues: number[];
        ownedComponents: string[];
        preferences: object;
        updatedAt: Date;
      };
      update: Partial<{
        githubLogin: string;
        displayName: string;
        detailLevel: string;
        timezone: string;
        role: string;
        teams: string[];
        watchedRepos: string[];
        watchedIssues: number[];
        ownedComponents: string[];
        preferences: object;
        updatedAt: Date;
      }>;
    }): Promise<any>;
    findUnique(args: { where: { slackId: string } }): Promise<any | null>;
    findMany(args?: { where?: { role?: string; teams?: { has: string } } }): Promise<any[]>;
  };
}

const DEFAULT_PROFILE: Omit<UserProfile, "slackId" | "createdAt" | "updatedAt"> = {
  detailLevel: "standard",
  role: "engineer",
  teams: [],
  watchedRepos: [],
  watchedIssues: [],
  ownedComponents: [],
  preferences: {},
};

/**
 * User preference service.
 *
 * Stores and retrieves per-user preferences that shape how Lexi
 * responds: detail level, timezone, role, watched issues, owned components.
 *
 * This is NOT conversation history — it's persistent user configuration.
 */
export class UserPreferenceService {
  constructor(private readonly store: UserPreferenceStore) {}

  /**
   * Get a user's profile. Returns defaults for unknown users (never null).
   */
  async getProfile(slackId: string): Promise<UserProfile> {
    const record = await this.store.userPreference.findUnique({ where: { slackId } });
    if (!record) {
      return {
        slackId,
        ...DEFAULT_PROFILE,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
    return this.toProfile(record);
  }

  /**
   * Update a user's profile (upsert — creates if doesn't exist).
   */
  async updateProfile(slackId: string, updates: Partial<Omit<UserProfile, "slackId" | "createdAt" | "updatedAt">>): Promise<UserProfile> {
    const { randomUUID } = await import("node:crypto");
    const result = await this.store.userPreference.upsert({
      where: { slackId },
      create: {
        id: randomUUID(),
        slackId,
        githubLogin: updates.githubLogin,
        displayName: updates.displayName,
        detailLevel: updates.detailLevel ?? "standard",
        timezone: updates.timezone,
        role: updates.role ?? "engineer",
        teams: updates.teams ?? [],
        watchedRepos: updates.watchedRepos ?? [],
        watchedIssues: updates.watchedIssues ?? [],
        ownedComponents: updates.ownedComponents ?? [],
        preferences: (updates.preferences ?? {}) as object,
        updatedAt: new Date(),
      },
      update: {
        ...(updates.githubLogin !== undefined && { githubLogin: updates.githubLogin }),
        ...(updates.displayName !== undefined && { displayName: updates.displayName }),
        ...(updates.detailLevel !== undefined && { detailLevel: updates.detailLevel }),
        ...(updates.timezone !== undefined && { timezone: updates.timezone }),
        ...(updates.role !== undefined && { role: updates.role }),
        ...(updates.teams !== undefined && { teams: updates.teams }),
        ...(updates.watchedRepos !== undefined && { watchedRepos: updates.watchedRepos }),
        ...(updates.watchedIssues !== undefined && { watchedIssues: updates.watchedIssues }),
        ...(updates.ownedComponents !== undefined && { ownedComponents: updates.ownedComponents }),
        ...(updates.preferences !== undefined && { preferences: updates.preferences as object }),
        updatedAt: new Date(),
      },
    });
    return this.toProfile(result);
  }

  /**
   * Set the user's preferred response detail level.
   */
  async setDetailLevel(slackId: string, level: DetailLevel): Promise<void> {
    await this.updateProfile(slackId, { detailLevel: level });
  }

  /**
   * Add an issue to the user's watch list.
   */
  async watchIssue(slackId: string, issueNumber: number): Promise<void> {
    const profile = await this.getProfile(slackId);
    if (!profile.watchedIssues.includes(issueNumber)) {
      await this.updateProfile(slackId, { watchedIssues: [...profile.watchedIssues, issueNumber] });
    }
  }

  /**
   * Remove an issue from the user's watch list.
   */
  async unwatchIssue(slackId: string, issueNumber: number): Promise<void> {
    const profile = await this.getProfile(slackId);
    await this.updateProfile(slackId, { watchedIssues: profile.watchedIssues.filter((n) => n !== issueNumber) });
  }

  /**
   * Find all users who watch a specific issue (for notifications).
   */
  async getWatchers(issueNumber: number): Promise<UserProfile[]> {
    const all = await this.store.userPreference.findMany();
    return all
      .filter((r: any) => (r.watchedIssues as number[])?.includes(issueNumber))
      .map((r: any) => this.toProfile(r));
  }

  /**
   * Find all users on a team.
   */
  async getTeamMembers(team: string): Promise<UserProfile[]> {
    const all = await this.store.userPreference.findMany({ where: { teams: { has: team } } });
    return all.map((r: any) => this.toProfile(r));
  }

  private toProfile(record: any): UserProfile {
    return {
      slackId: record.slackId,
      githubLogin: record.githubLogin ?? undefined,
      displayName: record.displayName ?? undefined,
      detailLevel: (record.detailLevel as DetailLevel) ?? "standard",
      timezone: record.timezone ?? undefined,
      role: (record.role as UserRole) ?? "engineer",
      teams: record.teams ?? [],
      watchedRepos: record.watchedRepos ?? [],
      watchedIssues: record.watchedIssues ?? [],
      ownedComponents: record.ownedComponents ?? [],
      preferences: (record.preferences as Record<string, unknown>) ?? {},
      createdAt: record.createdAt ?? new Date(),
      updatedAt: record.updatedAt ?? new Date(),
    };
  }
}

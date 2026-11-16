import type { AuthorizationConfig, UserEntry, UserScopes } from "./authorization.schema";

export interface AuthorizationContext {
  actorId: string;
  action: string;
  resource?: {
    issueNumber?: number;
    repository?: string;
    team?: string;
    assignee?: string;
    /**
     * The action touches only what belongs to the caller (their own personal
     * memory, the thread they asked in). Scoped grants cover it.
     */
    callerOnly?: boolean;
  };
}

export interface AuthorizationDecision {
  actorId: string;
  action: string;
  resource?: AuthorizationContext["resource"];
  allowed: boolean;
  matchedRoles: string[];
  matchedPermissions: string[];
  reason: string;
  policyVersion: number;
}

/**
 * A caller's identity as the evaluator sees it. Descriptive, not a grant —
 * see `AuthorizationService.describeCaller`.
 */
export interface CallerDescription {
  id: string;
  /** Configured display name; absent for identities not in the access list. */
  name?: string;
  /** Roles the evaluator would resolve, including any default fall-through. */
  roles: string[];
  /** Whether the actor is in the access list at all (vs. defaulted). */
  known: boolean;
}

/**
 * Fail-closed authorization service. Evaluates whether a Slack identity may
 * perform a governed action, combining explicit role assignments with optional
 * resource scoping.
 *
 * Principles:
 *   - Unknown user → denied (never silent viewer)
 *   - Missing config → all mutating tools disabled
 *   - Scoped grant + an action that names no team or repository → denied:
 *     a scope can only be checked against a resource, so a call that reports
 *     none is not covered by it (unless it is confined to the caller)
 *   - Role resolution failure → deny and audit
 *   - Ownership informs scope but does not grant roles
 */
export class AuthorizationService {
  private readonly resolvedPermissions = new Map<string, Set<string>>();
  /**
   * Slack-approved assignments, looked up only when the actor is absent from
   * the YAML `users:` map. YAML always wins — a runtime row cannot demote a
   * baked `platform_admin` or shadow a bootstrap grant.
   */
  private runtimeUsers = new Map<string, UserEntry>();

  constructor(private readonly config: AuthorizationConfig) {
    // Pre-resolve role inheritance into flat permission sets
    for (const roleName of Object.keys(config.roles)) {
      this.resolveRole(roleName);
    }
  }

  /** True when this Slack id is baked into `config/authorization.yaml`. */
  isBootstrapUser(actorId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.config.users ?? {}, actorId);
  }

  /** Slack ids that hold `platform_admin` in YAML — the people Lexi tags. */
  platformAdminSlackIds(): string[] {
    return Object.entries(this.config.users ?? {})
      .filter(([, entry]) => entry.roles.includes("platform_admin"))
      .map(([id]) => id);
  }

  listBootstrapUsers(): Array<{ slackId: string } & UserEntry> {
    return Object.entries(this.config.users ?? {}).map(([slackId, entry]) => ({ slackId, ...entry }));
  }

  /**
   * Replace the in-memory overlay. Bootstrap ids are dropped so a stale or
   * hostile store cannot shadow YAML. `evaluate` stays sync: callers hydrate
   * this map at boot and after each approve/revoke.
   */
  replaceRuntimeAssignments(users: Record<string, UserEntry>): void {
    const next = new Map<string, UserEntry>();
    for (const [id, entry] of Object.entries(users)) {
      if (this.isBootstrapUser(id)) continue;
      next.set(id, entry);
    }
    this.runtimeUsers = next;
  }

  upsertRuntimeAssignment(actorId: string, entry: UserEntry): void {
    if (this.isBootstrapUser(actorId)) return;
    this.runtimeUsers.set(actorId, entry);
  }

  removeRuntimeAssignment(actorId: string): void {
    this.runtimeUsers.delete(actorId);
  }

  private lookupUser(actorId: string): UserEntry | undefined {
    return this.config.users[actorId] ?? this.runtimeUsers.get(actorId);
  }

  /** Whether the service loaded a valid config and is operational. */
  isReady(): boolean {
    return this.config.version > 0 && Object.keys(this.config.roles).length > 0;
  }

  /** Evaluate whether an actor may perform an action on a resource. */
  evaluate(ctx: AuthorizationContext): AuthorizationDecision {
    const base = {
      actorId: ctx.actorId,
      action: ctx.action,
      resource: ctx.resource,
      policyVersion: this.config.version,
    };

    if (!this.isReady()) {
      return {
        ...base,
        allowed: false,
        matchedRoles: [],
        matchedPermissions: [],
        reason: "Authorization service is not ready — config missing or invalid. All mutating tools disabled.",
      };
    }

    const user = this.lookupUser(ctx.actorId);
    if (!user) {
      if (this.config.defaults.unknownUserRole === "denied") {
        return {
          ...base,
          allowed: false,
          matchedRoles: [],
          matchedPermissions: [],
          reason:
            `You are not set up to use this yet — "${ctx.action}" needs a role, and ${ctx.actorId} ` +
            `is not in the access list. ${this.grantersHint({ nameAdmins: false })} ` +
            `Reading needs a role too.`,
        };
      }
      // Fall through to default role
      return this.evaluateWithRoles(ctx, base, [this.config.defaults.authenticatedRole], undefined);
    }

    return this.evaluateWithRoles(ctx, base, user.roles, user.scopes);
  }

  /**
   * The refusal for someone who may use nothing at all — not in the access
   * list while `unknownUserRole` is `denied` — or `undefined` for anyone else.
   * Lets a surface refuse before it spends a model turn on a person every
   * tool would refuse anyway. Names `accessContact`, never the admins.
   */
  accessRefusal(actorId: string): string | undefined {
    if (!this.isReady()) return undefined;
    if (this.lookupUser(actorId)) return undefined;
    if (this.config.defaults.unknownUserRole !== "denied") return undefined;
    return (
      "You are not set up to use this yet — you are not in the access list, so I can't help with anything " +
      `here, reading included. ${this.grantersHint({ nameAdmins: false })}`
    );
  }

  /** Get all effective permissions for an actor (for introspection/debugging). */
  getEffectivePermissions(actorId: string): string[] {
    const user = this.lookupUser(actorId);
    if (!user) {
      if (this.config.defaults.unknownUserRole === "denied") return [];
      const defaultPerms = this.resolvedPermissions.get(this.config.defaults.authenticatedRole);
      return defaultPerms ? [...defaultPerms] : [];
    }
    const perms = new Set<string>();
    for (const role of user.roles) {
      const rolePerms = this.resolvedPermissions.get(role);
      if (rolePerms) {
        for (const p of rolePerms) perms.add(p);
      }
    }
    return [...perms].sort();
  }

  /**
   * Who is calling, resolved the same way `evaluate` resolves them.
   *
   * Exists because the agent prompt had no notion of a caller at all. The
   * thread summary is keyed by thread, not by user, so one person's refusal
   * ("X has the role [engineer], which does not include …") was carried into
   * the *next* person's turn verbatim — and with nothing in the prompt naming
   * the current caller, the model read that denial as its own and declined to
   * call the tool. A platform_admin was refused on an engineer's denial.
   *
   * Role resolution mirrors `evaluate` exactly, including the unknown-user
   * fall-through, so the prompt cannot advertise a role the evaluator would
   * not honour. This is descriptive only: it grants nothing, and every
   * mutating call is still evaluated per-invocation against the live actor.
   */
  describeCaller(actorId: string): CallerDescription {
    const user = this.lookupUser(actorId);
    if (user) {
      return { id: actorId, name: user.name, roles: [...user.roles], known: true };
    }
    if (this.config.defaults.unknownUserRole === "denied") {
      return { id: actorId, roles: [], known: false };
    }
    return { id: actorId, roles: [this.config.defaults.authenticatedRole], known: false };
  }

  /**
   * A refusal is the only thing most people ever see from this layer, and it is
   * the moment they most need a next step. The old messages were accurate and
   * useless — "Unknown Slack identity U0123 — denied by default policy" tells
   * someone nothing about what they needed or who to ask.
   *
   * Unknown callers get the configured contact or a generic pointer, never the
   * admins' names. Known callers without the permission get the names.
   *
   * Granters are derived from the config rather than hardcoded, so the hint
   * cannot drift as admins change. `defaults.accessContact` overrides that
   * derivation with a single named contact — still config, still one edit away
   * from correct, but it also says the list is narrow on purpose: a refusal that
   * does not say so reads as a broken bot.
   */
  private grantersHint(options: { nameAdmins?: boolean } = {}): string {
    const contact = this.config.defaults.accessContact?.trim();
    if (contact) {
      return `Access is deliberately limited — please ask ${contact} for access.`;
    }
    // Someone the access list does not know (a guest, a Slack Connect member)
    // is not told who the administrators are; naming them would hand out a
    // list of the people worth phishing. They get the generic pointer.
    if (options.nameAdmins === false) {
      return "Access is deliberately limited — ask a platform admin for access.";
    }

    const admins = Object.values(this.config.users ?? {})
      .filter((u) => u.roles?.includes("platform_admin"))
      .map((u) => u.name)
      .filter((name): name is string => Boolean(name));

    if (admins.length === 0) {
      return "A platform admin can grant access.";
    }
    const unique = [...new Set(admins)];
    const list =
      unique.length === 1
        ? unique[0]
        : `${unique.slice(0, -1).join(", ")} or ${unique[unique.length - 1]}`;
    return `Ask ${list} to grant access — they can approve a request in Slack.`;
  }

  /** Prefers the configured display name; falls back to the raw id for unknowns. */
  private describeActor(actorId: string): string {
    return this.lookupUser(actorId)?.name ?? actorId;
  }

  private evaluateWithRoles(
    ctx: AuthorizationContext,
    base: Omit<AuthorizationDecision, "allowed" | "matchedRoles" | "matchedPermissions" | "reason">,
    roles: string[],
    scopes: UserScopes | undefined,
  ): AuthorizationDecision {
    const matchedRoles: string[] = [];
    const matchedPermissions: string[] = [];
    let hasPermission = false;

    for (const role of roles) {
      const perms = this.resolvedPermissions.get(role);
      if (!perms) continue;
      if (perms.has(ctx.action)) {
        hasPermission = true;
        matchedRoles.push(role);
        matchedPermissions.push(ctx.action);
      }
    }

    if (!hasPermission) {
      return {
        ...base,
        allowed: false,
        matchedRoles: [],
        matchedPermissions: [],
        reason:
          `${this.describeActor(ctx.actorId)} has ${roles.length === 1 ? "the role" : "roles"} ` +
          `[${roles.join(", ")}], which ${roles.length === 1 ? "does" : "do"} not include "${ctx.action}". ` +
          `${this.grantersHint()}`,
      };
    }

    // A scoped grant authorizes only what it can be checked against. An action
    // whose resource does not name the scoped dimension (no team for a team
    // scope, no repository for a repository scope) is not covered: treating
    // "nothing to check" as "in scope" let a team-scoped lead pause or cancel
    // another team's programme, whose tools reported no resource, and act on
    // any repository that repos.yaml gives no team. Actions confined to the
    // caller (their own memory, their own thread) touch no team's resource and
    // stay allowed. Unscoped grants are unaffected.
    const scopedTeams = scopes?.teams ?? [];
    const scopedRepos = scopes?.repositories ?? [];
    if ((scopedTeams.length > 0 || scopedRepos.length > 0) && !ctx.resource?.callerOnly) {
      const team = ctx.resource?.team;
      const repository = ctx.resource?.repository;
      if (scopedTeams.length > 0 && !team) {
        return this.scopeDenial(ctx, base, matchedRoles, matchedPermissions, scopedTeams, "team");
      }
      if (scopedRepos.length > 0 && !repository) {
        return this.scopeDenial(ctx, base, matchedRoles, matchedPermissions, scopedRepos, "repository");
      }
      if (team && scopedTeams.length > 0 && !scopedTeams.includes(team)) {
        return {
          ...base,
          allowed: false,
          matchedRoles,
          matchedPermissions,
          // Deliberately NOT the "ask for the permission" wording: this person
          // already holds it. Sending them to an admin for a grant they have
          // would be a pointless errand — the mismatch is the team, not the role.
          reason:
            `${this.describeActor(ctx.actorId)} can do "${ctx.action}", but only for ` +
            `[${scopedTeams.join(", ")}] — and this belongs to "${team}". ` +
            `Someone on ${team} needs to action it.`,
        };
      }
      if (repository && scopedRepos.length > 0 && !scopedRepos.includes(repository)) {
        return {
          ...base,
          allowed: false,
          matchedRoles,
          matchedPermissions,
          reason: `Actor ${ctx.actorId} has permission "${ctx.action}" but is scoped to repositories [${scopedRepos.join(", ")}]; resource repository "${repository}" is outside scope.`,
        };
      }
    }

    return {
      ...base,
      allowed: true,
      matchedRoles,
      matchedPermissions,
      reason: `Authorized via role(s) [${matchedRoles.join(", ")}].`,
    };
  }

  /** A scoped grant met an action that does not name what the scope restricts. */
  private scopeDenial(
    ctx: AuthorizationContext,
    base: Omit<AuthorizationDecision, "allowed" | "matchedRoles" | "matchedPermissions" | "reason">,
    matchedRoles: string[],
    matchedPermissions: string[],
    scope: string[],
    dimension: "team" | "repository",
  ): AuthorizationDecision {
    return {
      ...base,
      allowed: false,
      matchedRoles,
      matchedPermissions,
      reason:
        `${this.describeActor(ctx.actorId)} can do "${ctx.action}" only for [${scope.join(", ")}], and this request ` +
        `names no ${dimension} to check that against, so it is refused. Someone whose access is not limited ` +
        `to a ${dimension} can do it.`,
    };
  }

  private resolveRole(roleName: string, visited = new Set<string>()): Set<string> {
    if (this.resolvedPermissions.has(roleName)) {
      return this.resolvedPermissions.get(roleName)!;
    }
    if (visited.has(roleName)) {
      // Circular inheritance — return empty to avoid infinite loop
      return new Set();
    }
    visited.add(roleName);

    const role = this.config.roles[roleName];
    if (!role) {
      const empty = new Set<string>();
      this.resolvedPermissions.set(roleName, empty);
      return empty;
    }

    const perms = new Set<string>(role.permissions);
    for (const parentName of role.inherits ?? []) {
      const parentPerms = this.resolveRole(parentName, visited);
      for (const p of parentPerms) {
        perms.add(p);
      }
    }

    this.resolvedPermissions.set(roleName, perms);
    return perms;
  }
}

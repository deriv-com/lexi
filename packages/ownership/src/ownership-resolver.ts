import {
  ComponentConfig,
  ModuleConfig,
  OwnershipConfig,
  Platform,
  PlatformConfig,
  PLATFORM_KEYS,
} from "./ownership-config.schema";
import { directoryOwnersForTeam, type PersonDirectoryEntry } from "./person-directory";

export interface OwnershipResolution {
  component: string;
  team: string;
  channel: string;
  owners: string[];
  owner?: string;
  matchedLabel?: string;
}

/** A person on a resolution, enriched from the directory where possible. */
export interface OwnershipPerson {
  githubLogin: string;
  /** Absent when the login is not in the directory — never invented. */
  slackId?: string;
  displayName?: string;
}

/**
 * The answer to "(module, platform) -> who, where". This is the contract the
 * escalation ladder consumes; `escalatesTo` is already ordered and already
 * excludes the PIC, so a caller walks it without re-deriving the hierarchy.
 */
export interface ModuleOwnershipResolution {
  /** Resolved module key. Equals `defaultModule` when nothing matched. */
  module: string;
  /**
   * True when the module was *not* identified and the default was used.
   * Callers must not present a fallback as a confident routing decision.
   */
  isDefaultModule: boolean;
  platform: Platform;
  team: string;
  channel: string;
  channelId?: string;
  /** Person-in-charge for this module on this platform — rung 1. */
  pic: OwnershipPerson;
  /** The platform's team lead — rung 2. */
  teamLead: OwnershipPerson;
  /**
   * Ordered escalation path *above* the PIC: team lead, then that lead's
   * manager when the directory records one. Never contains the PIC, never
   * contains a duplicate.
   */
  escalatesTo: OwnershipPerson[];
  description?: string;
}

/**
 * Deterministic label-priority order used when multiple GitHub labels map
 * to different components. Domain labels are more specific than category
 * labels (a domain:web + category:performance issue is still primarily a
 * Web-team concern, even though "performance" also has its own component),
 * so domain entries are checked first.
 */
const DEFAULT_LABEL_PRIORITY = [
  "domain:mobile",
  "domain:web",
  "category:performance",
  "category:uiux",
  "category:functional",
];

const UNASSIGNED_COMPONENT = "unassigned";

/**
 * Configuration-driven ownership resolver. Deterministic code (never the
 * AI) is the final authority on which team/channel/owner an issue is routed
 * to: GitHub labels are consulted first, and only when no label match exists
 * does the AI's predicted component act as a hint.
 */
export interface OwnershipResolverOptions {
  /**
   * Derived person directory. When a component's config lists no
   * owners — which is now the normal case, since `config/ownership.yaml` no
   * longer carries hand-maintained logins — owners are taken from the
   * directory by team instead.
   *
   * It is also what turns a GitHub login into a pageable identity (Slack ID)
   * and supplies the manager edge above a team lead. Without it, resolution
   * still works and simply degrades to logins with a shorter ladder.
   *
   * Optional so existing callers keep working unchanged.
   */
  directory?: readonly PersonDirectoryEntry[];
}

export class OwnershipResolver {
  private readonly roundRobinIndex = new Map<string, number>();
  private readonly directoryByLogin: Map<string, PersonDirectoryEntry>;
  /** Legacy one-dimensional view, synthesised from `platforms` when absent. */
  private readonly components: Record<string, ComponentConfig>;

  constructor(
    private readonly config: OwnershipConfig,
    private readonly labelPriority: string[] = DEFAULT_LABEL_PRIORITY,
    private readonly options: OwnershipResolverOptions = {},
  ) {
    this.directoryByLogin = new Map(
      (options.directory ?? []).map((entry) => [entry.githubLogin.trim().toLowerCase(), entry]),
    );
    this.components = config.components ?? synthesiseComponents(config);
  }

  // ---- Two-dimensional resolution (module x platform) ---------------------

  /** Configured module keys, including the default. */
  listModules(): string[] {
    return Object.keys(this.config.modules);
  }

  getDefaultModule(): string {
    return this.config.defaultModule;
  }

  getDefaultPlatform(): Platform {
    return this.config.defaultPlatform;
  }

  getModuleConfig(module: string): ModuleConfig | undefined {
    return this.config.modules[module];
  }

  /** Exact tracker-label to module mappings, normalized at the read boundary. */
  getModuleLabelMappings(): Readonly<Record<string, string>> {
    return this.config.moduleLabelMappings;
  }

  getPlatformConfig(platform: Platform): PlatformConfig {
    const platforms = this.config.platforms;
    if (!platforms) {
      throw new Error(
        "Ownership config has no `platforms` block: two-dimensional (module x platform) " +
          "resolution is unavailable. Add `platforms.web` and `platforms.mobile` to config/ownership.yaml.",
      );
    }
    return platforms[platform];
  }

  /**
   * Resolves `(module, platform)` to the person-in-charge, their channel, and
   * the escalation path above them.
   *
   * An unknown or absent module resolves to `defaultModule` with
   * `isDefaultModule: true` rather than to a guess. Naming the wrong specific
   * owner is strictly worse than naming the default one: it looks correct, so
   * nobody re-routes it.
   */
  resolveModuleOwnership(module: string | undefined, platform: Platform): ModuleOwnershipResolution {
    const platformConfig = this.getPlatformConfig(platform);

    const matched = module ? this.config.modules[module] : undefined;
    const moduleKey = matched ? (module as string) : this.config.defaultModule;
    const moduleConfig = matched ?? this.config.modules[this.config.defaultModule];

    if (!moduleConfig) {
      throw new Error(
        `Ownership config declares no module "${this.config.defaultModule}" to fall back to. ` +
          "Every config with a `platforms` block must define its `defaultModule`.",
      );
    }

    const pic = this.person(moduleConfig[platform].pic);
    const teamLead = this.person(platformConfig.teamLead);

    return {
      module: moduleKey,
      // Whether the module *is* the default, not whether it was substituted.
      // A caller that already inferred "default" and passes it in explicitly
      // holds exactly as weak an answer as one that passed nothing, and must
      // not be told otherwise just because it arrived by a different route.
      isDefaultModule: moduleKey === this.config.defaultModule,
      platform,
      team: platformConfig.team,
      channel: platformConfig.channel,
      channelId: platformConfig.channelId,
      pic,
      teamLead,
      escalatesTo: this.ladderAbove(pic, teamLead),
      description: moduleConfig.description,
    };
  }

  /**
   * Rungs above the PIC: the team lead, then the lead's manager as recorded
   * in `people-overrides.yaml`. The PIC is filtered out because a module PIC
   * is frequently also the platform lead (Bob owns the default module on
   * web *and* leads web) — telling someone to escalate to themselves is a
   * dead end that reads like a working ladder.
   */
  private ladderAbove(pic: OwnershipPerson, teamLead: OwnershipPerson): OwnershipPerson[] {
    const ladder: OwnershipPerson[] = [teamLead];

    const managerLogin = this.directoryByLogin.get(teamLead.githubLogin.trim().toLowerCase())?.managerGithub;
    if (managerLogin) ladder.push(this.person(managerLogin));

    const seen = new Set([pic.githubLogin.trim().toLowerCase()]);
    return ladder.filter((person) => {
      const key = person.githubLogin.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Enriches a login from the directory. Absent fields stay absent. */
  private person(githubLogin: string): OwnershipPerson {
    const entry = this.directoryByLogin.get(githubLogin.trim().toLowerCase());
    return {
      githubLogin,
      ...(entry?.slackId ? { slackId: entry.slackId } : {}),
      ...(entry?.displayName ? { displayName: entry.displayName } : {}),
    };
  }

  // ---- Legacy one-dimensional resolution ----------------------------------

  resolveComponentKey(labels: string[], aiSuggestedComponent?: string): { component: string; matchedLabel?: string } {
    const labelSet = new Set(labels);
    for (const label of this.labelPriority) {
      if (labelSet.has(label) && this.config.labelMappings[label]) {
        return { component: this.config.labelMappings[label], matchedLabel: label };
      }
    }

    // Fall back to any other configured label mapping present on the issue,
    // in case a label outside the default priority list is present.
    for (const [label, component] of Object.entries(this.config.labelMappings)) {
      if (labelSet.has(label)) {
        return { component, matchedLabel: label };
      }
    }

    if (aiSuggestedComponent && this.components[aiSuggestedComponent]) {
      return { component: aiSuggestedComponent };
    }

    return { component: UNASSIGNED_COMPONENT };
  }

  /**
   * Never returns undefined. The `unassigned` fallback is itself optional in
   * a hand-written config, and callers dereference `.team`/`.channel`
   * directly — so a config missing that key used to crash resolution rather
   * than degrade. A synthesised fallback keeps routing working and makes the
   * gap visible in the team/channel names instead.
   */
  getComponentConfig(component: string): ComponentConfig {
    return (
      this.components[component] ??
      this.components[UNASSIGNED_COMPONENT] ?? {
        team: "Triage",
        channel: "bug-triage-general",
        owners: [],
      }
    );
  }

  /**
   * Candidate owners for a component: the config list when one is present,
   * otherwise the derived directory, matched on the component's team.
   *
   * Config wins when populated so an operator can still pin ownership for a
   * component by hand — but the empty-by-default config now means the
   * directory is the normal source.
   */
  private ownerPool(component: string): string[] {
    const componentConfig = this.getComponentConfig(component);
    if (componentConfig.owners.length > 0) return componentConfig.owners;
    if (!this.options.directory) return [];
    return directoryOwnersForTeam(this.options.directory, componentConfig.team);
  }

  /** Returns the next owner for a component using round-robin rotation. */
  nextOwner(component: string): string | undefined {
    const pool = this.ownerPool(component);
    if (pool.length === 0) {
      // No owner is the correct answer when ownership is genuinely unknown.
      // The placeholder this replaced returned a real person for every
      // component, which looked like ownership and was not.
      return undefined;
    }
    const currentIndex = this.roundRobinIndex.get(component) ?? 0;
    const owner = pool[currentIndex % pool.length];
    this.roundRobinIndex.set(component, currentIndex + 1);
    return owner;
  }

  resolve(labels: string[], aiSuggestedComponent?: string): OwnershipResolution {
    const { component, matchedLabel } = this.resolveComponentKey(labels, aiSuggestedComponent);
    const componentConfig = this.getComponentConfig(component);
    const owner = this.nextOwner(component);

    return {
      component,
      team: componentConfig.team,
      channel: componentConfig.channel,
      owners: this.ownerPool(component),
      owner,
      matchedLabel,
    };
  }

  listComponents(): string[] {
    return Object.keys(this.components);
  }

  getPriorityLabels(): string[] {
    return this.config.priorityLabels;
  }

  getStatusLabels(): { toDo: string; inProgress: string } {
    return this.config.statusLabels;
  }
}

/**
 * Projects the two-dimensional config onto the legacy `component` surface so
 * `resolve()`/`getComponentConfig()` callers keep working unchanged.
 *
 * Only platforms are projected, plus `unassigned`. Modules are deliberately
 * *not* given legacy component entries: a module spans both platforms, so
 * flattening one into a single `{team, channel}` would have to pick a
 * platform silently — exactly the collapse this restructure removes.
 */
function synthesiseComponents(config: OwnershipConfig): Record<string, ComponentConfig> {
  if (!config.platforms) return {};

  const components: Record<string, ComponentConfig> = {};
  for (const platform of PLATFORM_KEYS) {
    const platformConfig = config.platforms[platform];
    components[platform] = {
      team: platformConfig.team,
      channel: platformConfig.channel,
      description: `${platformConfig.team} platform (synthesised from platforms.${platform})`,
      // Empty by design: owners come from the directory, matched on `team`.
      owners: [],
    };
  }

  const fallbackChannel = config.platforms[config.defaultPlatform].channel;
  components[UNASSIGNED_COMPONENT] = {
    team: "Triage",
    channel: fallbackChannel,
    description: `Fallback when no component resolves; routed to the ${config.defaultPlatform} channel`,
    owners: [],
  };

  return components;
}

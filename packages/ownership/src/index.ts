export {
  componentConfigSchema,
  ownershipConfigSchema,
  ComponentConfig,
  OwnershipConfig,
  // ---- Two-dimensional ownership (module x platform) ----
  platformSchema,
  platformConfigSchema,
  modulePlatformOwnershipSchema,
  moduleConfigSchema,
  PLATFORM_KEYS,
  Platform,
  PlatformConfig,
  ModulePlatformOwnership,
  ModuleConfig,
} from "./ownership-config.schema";
export { loadOwnershipConfig, parseOwnershipConfig } from "./load-ownership-config";
export {
  OwnershipResolver,
  OwnershipResolution,
  OwnershipResolverOptions,
  ModuleOwnershipResolution,
  OwnershipPerson,
} from "./ownership-resolver";
export {
  quickFixAnnouncementSchema,
  quickFixAnalysisChannelSchema,
  quickFixAnalysisReplySchema,
  quickFixCategoryConfigSchema,
  quickFixMergeReviewersSchema,
  quickFixOwnersConfigSchema,
  QuickFixAnnouncement,
  QuickFixAnalysisChannel,
  QuickFixAnalysisReply,
  QuickFixCategoryConfig,
  QuickFixMergeReviewers,
  QuickFixOwnersConfig,
} from "./quick-fix-owners-config.schema";
export { loadQuickFixOwnersConfig, parseQuickFixOwnersConfig } from "./load-quick-fix-owners-config";
export { QuickFixOwnerResolver, type ShipAnnouncementTarget } from "./quick-fix-owner-resolver";
export { OWNERSHIP_RESOLVER_TOKEN, QUICK_FIX_OWNER_RESOLVER_TOKEN, PERSON_DIRECTORY_TOKEN } from "./tokens";

// ---- Person directory ----------------------
export { parseCodeowners, codeownersLogins, codeownersTeamHandles, isTeamHandle, CodeownersRule } from "./codeowners";
export {
  personOverrideSchema,
  peopleOverridesConfigSchema,
  PersonOverride,
  PeopleOverridesConfig,
} from "./people-overrides.schema";
export { loadPeopleOverrides, parsePeopleOverrides } from "./load-people-overrides";
export {
  buildPersonDirectory,
  directoryOwnersForTeam,
  PersonDirectoryEntry,
  CodeownersSource,
  SlackDirectoryEntry,
  BuildPersonDirectoryInput,
  BuildPersonDirectoryResult,
} from "./person-directory";
export {
  assertNoPlaceholderPeople,
  assertOwnershipConfigHasNoPlaceholders,
  isPlaceholderLogin,
  PlaceholderDataError,
  PlaceholderCheckOptions,
  DEFAULT_PLACEHOLDER_LOGINS,
} from "./person-directory-validation";

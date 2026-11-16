import { z } from "zod";

/**
 * `config/people-overrides.yaml` — the manual correction layer over derived
 * ownership.
 *
 * Two jobs:
 *   - map a GitHub login to a Slack identity where the two cannot be derived
 *     from each other (they usually cannot — GitHub logins and Slack IDs
 *     share no field);
 *   - carry `managerGithub`, the deferred manager edge. Nothing in
 *     this build reads it; the field exists so managers can be populated
 *     later without a migration.
 *
 * `people` defaults to empty because an empty overrides file is the expected
 * state at launch, not a misconfiguration.
 */
export const personOverrideSchema = z.object({
  /** Primary key of the directory. Required — an override with no login cannot be applied. */
  githubLogin: z.string().min(1),
  slackId: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  /** Deferred. Populated when known; consumed by nothing in this build. */
  managerGithub: z.string().min(1).optional(),
  teams: z.array(z.string().min(1)).default([]),
});

export const peopleOverridesConfigSchema = z.object({
  people: z.array(personOverrideSchema).default([]),
});

export type PersonOverride = z.infer<typeof personOverrideSchema>;
export type PeopleOverridesConfig = z.infer<typeof peopleOverridesConfigSchema>;

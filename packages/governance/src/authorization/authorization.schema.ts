import { z } from "zod";

export const roleSchema = z.object({
  description: z.string().optional(),
  inherits: z.array(z.string()).optional().default([]),
  permissions: z.array(z.string()),
});

export const userScopesSchema = z.object({
  teams: z.array(z.string()).optional().default([]),
  repositories: z.array(z.string()).optional().default([]),
});

export const userEntrySchema = z.object({
  name: z.string().optional(),
  roles: z.array(z.string()),
  scopes: userScopesSchema.optional(),
});

export const groupEntrySchema = z.object({
  slackUserGroupId: z.string(),
  roles: z.array(z.string()),
});

export const authorizationConfigSchema = z.object({
  version: z.number(),
  defaults: z.object({
    authenticatedRole: z.string().default("viewer"),
    unknownUserRole: z.enum(["viewer", "denied"]).default("denied"),
    /**
     * Who a refused person should ask for access, and a signal that the narrow
     * access list is deliberate rather than a bug.
     *
     * Optional on purpose. Unset, `grantersHint()` keeps deriving the granters
     * from every platform_admin in the file, which is the behaviour the hint
     * was built with so it could not drift as admins change. Set, it names one
     * contact — for when the derived list would send people to an admin who is
     * not the one fielding access requests.
     */
    accessContact: z.string().optional(),
  }),
  roles: z.record(z.string(), roleSchema),
  users: z.record(z.string(), userEntrySchema).optional().default({}),
  groups: z.record(z.string(), groupEntrySchema).optional().default({}),
});

export type AuthorizationConfig = z.infer<typeof authorizationConfigSchema>;
export type RoleDefinition = z.infer<typeof roleSchema>;
export type UserEntry = z.infer<typeof userEntrySchema>;
export type UserScopes = z.infer<typeof userScopesSchema>;

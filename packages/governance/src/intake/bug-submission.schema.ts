import { z } from "zod";

export const bugSubmissionSourceSchema = z.object({
  type: z.enum(["api", "github_intake", "canonical_repo_watcher"]),
  reporter: z.string().optional(),
  botName: z.string().optional(),
  sourceIssueUrl: z.string().url().optional(),
});

export const bugSubmissionEnvironmentSchema = z.object({
  browser: z.string().optional(),
  browserVersion: z.string().optional(),
  os: z.string().optional(),
  osVersion: z.string().optional(),
  appVersion: z.string().optional(),
  build: z.string().optional(),
  commit: z.string().optional(),
  url: z.string().optional(),
  device: z.string().optional(),
});

export const bugSubmissionAccountContextSchema = z.object({
  accountType: z.enum(["anonymous", "demo", "real"]).optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  currency: z.string().optional(),
  kycState: z.string().optional(),
  fundedState: z.string().optional(),
});

export const bugSubmissionEvidenceSchema = z.object({
  screenshots: z.array(z.string()).optional(),
  video: z.string().optional(),
  consoleLog: z.string().optional(),
  networkLog: z.string().optional(),
  traceId: z.string().optional(),
  attachments: z.array(z.string()).optional(),
});

export const bugSubmissionSchema = z.object({
  source: bugSubmissionSourceSchema,
  title: z.string().min(1).max(500),
  stepsToReproduce: z.array(z.string().min(1)).default([]),
  expectedBehaviour: z.string().min(1),
  actualBehaviour: z.string().min(1),
  environment: bugSubmissionEnvironmentSchema,
  accountContext: bugSubmissionAccountContextSchema.optional(),
  evidence: bugSubmissionEvidenceSchema.optional(),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type BugSubmission = z.infer<typeof bugSubmissionSchema>;

export const intakeResponseSchema = z.object({
  verdict: z.enum(["ACCEPTED", "DUPLICATE", "INVALID", "NEEDS_INFO"]),
  canonicalIssue: z
    .object({
      repository: z.string(),
      number: z.number(),
      url: z.string(),
      title: z.string(),
      state: z.string(),
      assignee: z.string().optional(),
      severity: z.string().optional(),
      priority: z.string().optional(),
      createdAt: z.string().optional(),
      lastActivityAt: z.string().optional(),
    })
    .optional(),
  reasonCode: z.string(),
  explanation: z.string(),
  missingFields: z.array(z.string()),
  similarIssues: z.array(
    z.object({
      number: z.number(),
      url: z.string(),
      similarity: z.number(),
    }),
  ),
  /**
   * Present only when the identified canonical issue was closed. Mirrors
   * ClosedIssueResolution — recorded even when the flag is off so the audit
   * trail shows what would have happened.
   */
  closedIssueResolution: z
    .object({
      action: z.enum(["REOPEN", "REGRESSION", "RESOLVE_CANONICAL", "NONE"]),
      executed: z.boolean(),
      blocked: z.boolean(),
      reason: z.string(),
      reopenedIssue: z.number().optional(),
      regressionIssue: z.number().optional(),
      ultimateCanonical: z.number().optional(),
      chain: z.array(z.number()).optional(),
    })
    .optional(),
  requestId: z.string(),
});

export type IntakeResponse = z.infer<typeof intakeResponseSchema>;

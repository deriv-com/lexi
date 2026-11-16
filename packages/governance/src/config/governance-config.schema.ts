import { z } from "zod";

export const intakePolicySchema = z.object({
  version: z.string().default("1.0.0"),
  rejectConfidenceThreshold: z.number().min(0).max(1).default(0.85),
  securityLabels: z.array(z.string()).default(["security", "lexi:security"]),
  reviewLabel: z.string().default("lexi:review-intake"),
});

export const duplicatePolicySchema = z.object({
  version: z.string().default("1.0.0"),
  highConfidenceThreshold: z.number().min(0).max(1).default(0.85),
  mediumConfidenceThreshold: z.number().min(0).max(1).default(0.6),
  reviewDedupLabel: z.string().default("lexi:review-dedup"),
  lexicalMinSimilarity: z.number().min(0).max(1).default(0.35),
  semanticTopK: z.number().int().positive().default(10),
  /**
   * Whether the calibrated 0-1 similarity is authoritative for adjudication.
   * Defaults to false so the legacy reciprocal-rank-fusion behaviour is
   * preserved until the shadow numbers have been reviewed. See
   * `config/duplicate-policy.yaml` for the full rationale.
   */
  calibratedSimilarityEnabled: z.boolean().default(false),
});

export const pendingClosureConfigSchema = z.object({
  enabled: z.boolean().default(true),
  gracePeriodDays: z.number().int().positive().default(7),
  minQualifyingAttempts: z.number().int().positive().default(2),
  pendingLabel: z.string().default("lexi:pending-closure"),
  notObservedLabel: z.string().default("lexi:not-observed"),
  holdLabels: z.array(z.string()).default(["lexi:hold", "keep-open"]),
  protectedLabels: z.array(z.string()).default(["security", "keep-open", "lexi:hold"]),
  protectedSeverities: z.array(z.string()).default(["s1", "s2"]),
  protectedPriorities: z.array(z.string()).default(["p0", "p1"]),
  minConfidence: z.number().min(0).max(1).default(0.85),
  humanActivityWindowDays: z.number().int().positive().default(14),
});

export const runBudgetsSchema = z.object({
  duplicateClosuresPerRun: z.number().int().positive().default(25),
  pendingClosureMarksPerRun: z.number().int().positive().default(20),
  actualClosuresPerRun: z.number().int().positive().default(20),
  reproductionSubmissionsPerRun: z.number().int().positive().default(100),
  quickFixPullRequestsPerRun: z.number().int().positive().default(3),
});

export const severityPriorityConfigSchema = z.object({
  version: z.string().default("1.0.0"),
  humanPriorityProtection: z.boolean().default(true),
  priorityOrder: z.array(z.enum(["P0", "P1", "P2", "P3", "P4"])).default(["P0", "P1", "P2", "P3", "P4"]),
  severityOrder: z.array(z.enum(["S1", "S2", "S3", "S4"])).default(["S1", "S2", "S3", "S4"]),
  rules: z.array(
    z.object({
      id: z.string(),
      when: z.record(z.string(), z.union([z.boolean(), z.string(), z.number()])),
      severity: z.enum(["S1", "S2", "S3", "S4"]),
      priority: z.enum(["P0", "P1", "P2", "P3", "P4"]),
      explanation: z.string(),
    }),
  ),
});

export const autofixPolicySchema = z.object({
  maxPriority: z.string().default("P3"),
  maxSeverity: z.string().default("S3"),
  maxFilesChanged: z.number().int().positive().default(3),
  maxLinesChanged: z.number().int().positive().default(80),
  forbiddenLabels: z.array(z.string()).default(["security", "lexi:hold"]),
  forbiddenComponents: z.array(z.string()).default(["payments", "platform"]),
  forbiddenPathPatterns: z.array(z.string()).default([
    "**/auth/**",
    "**/payment/**",
    "**/kyc/**",
    "**/migrations/**",
  ]),
  maxOpenPrsPerReviewer: z.number().int().positive().default(3),
  maxOpenPrsPerIssue: z.number().int().positive().default(1),
  staleReminderDays: z.number().int().positive().default(7),
  staleCloseDays: z.number().int().positive().default(14),
  autofixLabel: z.string().default("lexi:autofix"),
});

export const governanceConfigSchema = z.object({
  intakePolicy: intakePolicySchema,
  duplicatePolicy: duplicatePolicySchema,
  pendingClosure: pendingClosureConfigSchema,
  runBudgets: runBudgetsSchema,
  severityPriority: severityPriorityConfigSchema,
  autofixPolicy: autofixPolicySchema,
});

export type GovernanceConfig = z.infer<typeof governanceConfigSchema>;

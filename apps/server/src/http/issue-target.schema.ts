import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import type { IssueTarget } from "../ports/issue-workflow.port";

export const issueTargetSchema = z
  .object({
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be owner/name")
      .optional(),
    issueNumber: z.number().int().positive(),
  })
  .strict();

/** Validates a request body, turning a schema failure into a 400 that names every problem. */
export function parseIssueTarget(body: unknown): IssueTarget {
  const result = issueTargetSchema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      message: "Invalid request body",
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}

import { z } from "zod";
import { CLASSIFICATIONS } from "./types";

export const decisionSchema = z.object({
  classification: z.enum(CLASSIFICATIONS),
  component: z.string().min(1),
  team: z.string().min(1),
  owner: z.string().nullable().optional(),
  // Bounds are enforced by clamping downstream (in OpenAiProvider) rather
  // than by rejecting the response outright, since a slightly out-of-range
  // confidence score from the model is not a reason to fail the whole
  // classification.
  confidence: z.number(),
  labels: z.array(z.string()).default([]),
  summary: z.string().min(1),
  reasoning: z.string().min(1),
  nextAction: z.string().min(1),
});

export type DecisionSchemaType = z.infer<typeof decisionSchema>;

/** JSON schema handed to the OpenAI Responses API for structured output. */
export const decisionJsonSchema = {
  name: "bug_triage_decision",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      classification: { type: "string", enum: [...CLASSIFICATIONS] },
      component: { type: "string" },
      team: { type: "string" },
      // Nullable + always required: OpenAI's strict structured-output mode rejects the schema
      // itself (a bare 400, confirmed via live testing) unless every property is listed in
      // `required`, including ones that are logically optional -- those must be typed as
      // nullable instead of omitted from `required`. The model is expected to return `null` when
      // it has no owner opinion, which is why the Zod schema above accepts `owner: string | null`.
      owner: { type: ["string", "null"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      labels: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
      reasoning: { type: "string" },
      nextAction: { type: "string" },
    },
    required: [
      "classification",
      "component",
      "team",
      "owner",
      "confidence",
      "labels",
      "summary",
      "reasoning",
      "nextAction",
    ],
  },
} as const;

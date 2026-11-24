import type { IssueAnalysis, IssueAnalysisInput } from "./issue-analysis.types";

/**
 * Minimal LLM client interface. Same shape as OpenAiChatClient so the existing
 * client factory works, but keeps the governance package decoupled from the
 * full @lexi/ai surface.
 *
 * Chat Completions, not the Responses API: an OpenAI-compatible gateway can
 * reject `/v1/responses` with a bare 400 for non-OpenAI backends. See the
 * endpoint note in
 * `packages/ai/src/openai-client.types.ts`.
 */
export interface AnalysisLLMClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        temperature?: number;
        response_format?: {
          type: "json_schema";
          json_schema: {
            name: string;
            schema: Record<string, unknown>;
            strict?: boolean;
          };
        };
      }): Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;
    };
  };
}

export interface IssueAnalysisServiceConfig {
  model: string;
  promptVersion: string;
  temperature?: number;
}

export interface IssueAnalysisResult {
  analysis: IssueAnalysis;
  model: string;
  promptVersion: string;
  confidence: number;
  inputRevision: string;
  analysedAt: Date;
  /** Whether the result came from Claude or from the deterministic fallback */
  source: "llm" | "fallback";
}

const ISSUE_ANALYSIS_SYSTEM_PROMPT = `You are an engineering issue analyst. Your job is to extract structured hypotheses from a bug report.

You do NOT decide whether to close the issue. You do NOT decide the workflow.
You extract structured information to help downstream policy make decisions.

Analyse the issue and return a JSON object with these fields:

- bugClass: array of bug categories (e.g. "UI glitch", "payment failure", "auth issue")
- likelyComponent: most likely software component/module
- likelyRepositories: array of repository names where the bug likely lives
- evidenceQuality: "strong" | "medium" | "weak" — how well the report demonstrates the bug
- likelyFalsePositive: boolean — whether this might be expected behaviour, not a bug
- falsePositiveReasons: array of reasons it might be expected behaviour (empty if not likely)
- codeSearchTerms: array of terms to search in code/PRs for related changes
- suspectedFiles: array of suspected source file paths (can be partial paths)
- lifecycleStates: array of application states the bug passes through
- reproductionValue: "high" | "medium" | "low" — how valuable browser reproduction would be
- confidence: number 0.0-1.0 — your overall confidence in this analysis
- expectedBehaviourLikely: boolean — whether the reported "bug" might actually be intended
- reportCompleteness: "complete" | "partial" | "minimal" — how thorough the report is
- expectedBehaviour: string or null — what the reporter expects
- actualBehaviour: string or null — what actually happened
- errorStrings: array of error messages/codes found in the report
- affectedPlatform: "web" | "mobile" | "api" | "backend" | null
- possibleRootCause: string or null — hypothesis about what's wrong

Be conservative. If evidence is ambiguous, report it as such rather than guessing.`;

const ISSUE_ANALYSIS_JSON_SCHEMA = {
  name: "issue_analysis",
  schema: {
    type: "object",
    properties: {
      bugClass: { type: "array", items: { type: "string" } },
      likelyComponent: { type: ["string", "null"] },
      likelyRepositories: { type: "array", items: { type: "string" } },
      evidenceQuality: { type: "string", enum: ["strong", "medium", "weak"] },
      likelyFalsePositive: { type: "boolean" },
      falsePositiveReasons: { type: "array", items: { type: "string" } },
      codeSearchTerms: { type: "array", items: { type: "string" } },
      suspectedFiles: { type: "array", items: { type: "string" } },
      lifecycleStates: { type: "array", items: { type: "string" } },
      reproductionValue: { type: "string", enum: ["high", "medium", "low"] },
      confidence: { type: "number" },
      expectedBehaviourLikely: { type: "boolean" },
      reportCompleteness: { type: "string", enum: ["complete", "partial", "minimal"] },
      expectedBehaviour: { type: ["string", "null"] },
      actualBehaviour: { type: ["string", "null"] },
      errorStrings: { type: "array", items: { type: "string" } },
      affectedPlatform: { type: ["string", "null"] },
      possibleRootCause: { type: ["string", "null"] },
    },
    required: [
      "bugClass", "likelyComponent", "likelyRepositories", "evidenceQuality",
      "likelyFalsePositive", "falsePositiveReasons", "codeSearchTerms",
      "suspectedFiles", "lifecycleStates", "reproductionValue", "confidence",
      "expectedBehaviourLikely", "reportCompleteness", "expectedBehaviour",
      "actualBehaviour", "errorStrings", "affectedPlatform", "possibleRootCause",
    ],
    additionalProperties: false,
  },
};

/**
 * Issue analysis service. Uses an LLM to extract structured hypotheses.
 *
 * If the LLM call fails, falls back to a deterministic heuristic-based analysis
 * so the pipeline continues conservatively rather than blocking.
 */
export class IssueAnalysisService {
  constructor(
    private readonly client: AnalysisLLMClient,
    private readonly config: IssueAnalysisServiceConfig,
  ) {}

  async analyse(input: IssueAnalysisInput): Promise<IssueAnalysisResult> {
    const inputRevision = `${input.issueNumber}:${input.title.slice(0, 50)}:${new Date(input.createdAt).toISOString()}`;

    try {
      const userPrompt = this.buildUserPrompt(input);

      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: ISSUE_ANALYSIS_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        // Three separate things an OpenAI-compatible gateway may reject with the same
        // opaque "400 The request was invalid" when the backend is Claude —
        // which this service's is, per the comment above — are all avoided
        // here: a non-default `temperature`, `strict: true`, and the Responses
        // API endpoint itself. OpenAiProvider avoids the same three; this
        // service has its own call site, so it has to avoid them too.
        //
        // It mattered less visibly here only because the catch below degrades to
        // a heuristic analysis instead of surfacing an error, so the pipeline
        // kept producing plausible output with `source` quietly set to the
        // fallback. EVIDENCE_PIPELINE_LLM_ENABLED read as on while no LLM
        // analysis was reaching the model.
        //
        // Schema enforcement is unaffected: the parse and validation below
        // already reject malformed output.
        ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: ISSUE_ANALYSIS_JSON_SCHEMA.name,
            schema: ISSUE_ANALYSIS_JSON_SCHEMA.schema,
          },
        },
      });

      const rawText = response.choices?.[0]?.message?.content;
      if (!rawText) {
        return this.fallback(input, inputRevision, "LLM returned empty output");
      }

      const parsed = this.unwrapParametersEnvelope(JSON.parse(rawText));
      const analysis = this.validateAndNormalize(parsed);

      return {
        analysis,
        model: this.config.model,
        promptVersion: this.config.promptVersion,
        confidence: analysis.confidence,
        inputRevision,
        analysedAt: new Date(),
        source: "llm",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown LLM error";
      return this.fallback(input, inputRevision, message);
    }
  }

  /**
   * Deterministic fallback when Claude is unavailable.
   * Uses heuristics from labels, title, and body to produce a conservative analysis.
   */
  private fallback(input: IssueAnalysisInput, inputRevision: string, reason: string): IssueAnalysisResult {
    const analysis = deterministicAnalysis(input);
    return {
      analysis,
      model: "deterministic-fallback",
      promptVersion: this.config.promptVersion,
      confidence: analysis.confidence,
      inputRevision,
      analysedAt: new Date(),
      source: "fallback",
    };
  }

  private buildUserPrompt(input: IssueAnalysisInput): string {
    const parts = [
      `Issue #${input.issueNumber}`,
      `Title: ${input.title}`,
      `Labels: ${input.labels.join(", ") || "(none)"}`,
      `Author: ${input.authorLogin ?? "unknown"}`,
      `State: ${input.state}`,
      `Created: ${input.createdAt.toISOString()}`,
    ];
    if (input.body) {
      const truncated = input.body.length > 4000 ? input.body.slice(0, 4000) + "…" : input.body;
      parts.push(`\nBody:\n${truncated}`);
    } else {
      parts.push("\nBody: (empty)");
    }
    return parts.join("\n");
  }

  /**
   * The gateway implements `json_schema` structured output for the Claude
   * backend as a forced tool call, and non-deterministically returns the fields
   * wrapped in a `{"parameters": {...}}` envelope (a tool's arguments
   * conventionally live under that key) rather than flat.
   * ClaudeReproductionProvider already carries this unwrap on the same endpoint;
   * moving here inherits the same quirk, and without it a wrapped response
   * would silently degrade to the deterministic fallback.
   */
  private unwrapParametersEnvelope(value: unknown): Record<string, unknown> {
    if (
      typeof value === "object" &&
      value !== null &&
      "parameters" in value &&
      typeof (value as { parameters: unknown }).parameters === "object" &&
      (value as { parameters: unknown }).parameters !== null
    ) {
      return (value as { parameters: Record<string, unknown> }).parameters;
    }
    return value as Record<string, unknown>;
  }

  private validateAndNormalize(parsed: Record<string, unknown>): IssueAnalysis {
    // Clamp confidence to [0, 1]
    const rawConfidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
    const confidence = Math.max(0, Math.min(1, rawConfidence));

    return {
      bugClass: Array.isArray(parsed.bugClass) ? parsed.bugClass.filter((x): x is string => typeof x === "string") : [],
      likelyComponent: typeof parsed.likelyComponent === "string" ? parsed.likelyComponent : undefined,
      likelyRepositories: Array.isArray(parsed.likelyRepositories) ? parsed.likelyRepositories.filter((x): x is string => typeof x === "string") : [],
      evidenceQuality: isEvidenceQuality(parsed.evidenceQuality) ? parsed.evidenceQuality : "weak",
      likelyFalsePositive: parsed.likelyFalsePositive === true,
      falsePositiveReasons: Array.isArray(parsed.falsePositiveReasons) ? parsed.falsePositiveReasons.filter((x): x is string => typeof x === "string") : [],
      codeSearchTerms: Array.isArray(parsed.codeSearchTerms) ? parsed.codeSearchTerms.filter((x): x is string => typeof x === "string") : [],
      suspectedFiles: Array.isArray(parsed.suspectedFiles) ? parsed.suspectedFiles.filter((x): x is string => typeof x === "string") : [],
      lifecycleStates: Array.isArray(parsed.lifecycleStates) ? parsed.lifecycleStates.filter((x): x is string => typeof x === "string") : [],
      reproductionValue: isReproductionValue(parsed.reproductionValue) ? parsed.reproductionValue : "medium",
      confidence,
      expectedBehaviourLikely: parsed.expectedBehaviourLikely === true,
      reportCompleteness: isCompleteness(parsed.reportCompleteness) ? parsed.reportCompleteness : "partial",
      expectedBehaviour: typeof parsed.expectedBehaviour === "string" ? parsed.expectedBehaviour : undefined,
      actualBehaviour: typeof parsed.actualBehaviour === "string" ? parsed.actualBehaviour : undefined,
      errorStrings: Array.isArray(parsed.errorStrings) ? parsed.errorStrings.filter((x): x is string => typeof x === "string") : [],
      affectedPlatform: typeof parsed.affectedPlatform === "string" ? parsed.affectedPlatform : undefined,
      possibleRootCause: typeof parsed.possibleRootCause === "string" ? parsed.possibleRootCause : undefined,
    };
  }
}

// ---- Type guards ----

function isEvidenceQuality(v: unknown): v is "strong" | "medium" | "weak" {
  return v === "strong" || v === "medium" || v === "weak";
}

function isReproductionValue(v: unknown): v is "high" | "medium" | "low" {
  return v === "high" || v === "medium" || v === "low";
}

function isCompleteness(v: unknown): v is "complete" | "partial" | "minimal" {
  return v === "complete" || v === "partial" || v === "minimal";
}

// ---- Deterministic fallback ----

function hasOrderedKeywordsOnLine(
  text: string,
  pairs: ReadonlyArray<readonly [string, string]>,
): boolean {
  for (const line of text.toLowerCase().split(/\r?\n/)) {
    for (const [first, second] of pairs) {
      const idx = line.indexOf(first);
      if (idx !== -1 && line.indexOf(second, idx + first.length) !== -1) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Heuristic analysis when LLM is unavailable.
 * Uses title patterns, labels, and body length to produce a conservative result.
 */
function deterministicAnalysis(input: IssueAnalysisInput): IssueAnalysis {
  const titleLower = input.title.toLowerCase();
  const bodyLower = (input.body ?? "").toLowerCase();
  const combined = `${titleLower} ${bodyLower}`;

  // Bug class from title keywords
  const bugClass: string[] = [];
  if (/crash|error|exception|fail/i.test(titleLower)) bugClass.push("runtime error");
  if (/ui|layout|display|visual|css/i.test(titleLower)) bugClass.push("UI issue");
  if (/payment|deposit|withdrawal|cashier/i.test(titleLower)) bugClass.push("payment issue");
  if (/auth|login|session|token/i.test(titleLower)) bugClass.push("auth issue");
  if (/performance|slow|timeout|lag/i.test(titleLower)) bugClass.push("performance");
  if (bugClass.length === 0) bugClass.push("unclassified");

  // Component from labels
  const componentLabel = input.labels.find((l) => l.startsWith("domain:"));
  const likelyComponent = componentLabel ? componentLabel.replace("domain:", "") : undefined;

  // Evidence quality from body
  let evidenceQuality: "strong" | "medium" | "weak" = "weak";
  if (input.body && input.body.length > 500) evidenceQuality = "medium";
  if (
    input.body &&
    input.body.length > 1000 &&
    hasOrderedKeywordsOnLine(input.body, [
      ["steps", "reproduce"],
      ["expected", "actual"],
    ])
  ) {
    evidenceQuality = "strong";
  }

  // Report completeness
  let reportCompleteness: "complete" | "partial" | "minimal" = "minimal";
  if (input.body && input.body.length > 200) reportCompleteness = "partial";
  if (input.body && input.body.length > 800 && /steps|expected|actual|environment/i.test(input.body)) {
    reportCompleteness = "complete";
  }

  // Error strings
  const errorStrings: string[] = [];
  const errorMatch = combined.match(/(?:error|exception|TypeError|ReferenceError|SyntaxError)[:\s][^\n]{5,80}/gi);
  if (errorMatch) errorStrings.push(...errorMatch.slice(0, 5));

  // Platform detection
  let affectedPlatform: string | undefined;
  if (/\b(ios|android|mobile|app)\b/i.test(combined)) affectedPlatform = "mobile";
  else if (/\b(web|browser|chrome|firefox|safari)\b/i.test(combined)) affectedPlatform = "web";
  else if (/\b(api|endpoint|request|response)\b/i.test(combined)) affectedPlatform = "api";

  return {
    bugClass,
    likelyComponent,
    likelyRepositories: [],
    evidenceQuality,
    likelyFalsePositive: false, // Conservative: assume it's real
    falsePositiveReasons: [],
    codeSearchTerms: bugClass.filter((c) => c !== "unclassified"),
    suspectedFiles: [],
    lifecycleStates: [],
    reproductionValue: evidenceQuality === "weak" ? "high" : "medium",
    confidence: 0.3, // Low confidence for fallback
    expectedBehaviourLikely: false,
    reportCompleteness,
    errorStrings,
    affectedPlatform,
    possibleRootCause: undefined,
  };
}

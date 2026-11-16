/**
 * Production LLM duplicate adjudication provider.
 *
 * Calls an OpenAI-compatible endpoint (directly or via LiteLLM gateway)
 * to determine whether candidate issues are duplicates of a submission.
 *
 * Returns structured DUPLICATE / POSSIBLE_DUPLICATE / NOT_DUPLICATE verdicts
 * with confidence scores and reasoning that Lexi can explain to reporters.
 */

import type {
  DuplicateAdjudicationProvider,
  DuplicateCandidateDecision,
  DuplicateVerdict,
} from "./adjudication";

export interface LlmAdjudicationConfig {
  /** OpenAI-compatible API key. */
  apiKey: string;
  /** Base URL for the LLM endpoint. */
  baseUrl?: string;
  /** Model to use for adjudication. */
  model: string;
  /** Temperature (default 0.1 for consistency). */
  temperature?: number;
  /** Timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Maximum candidates to adjudicate in one call (default 10). */
  maxCandidatesPerCall?: number;
}

interface LlmAdjudicationResult {
  candidates: Array<{
    issueNumber: number;
    verdict: "DUPLICATE" | "POSSIBLE_DUPLICATE" | "NOT_DUPLICATE";
    confidence: number;
    reasoning: string;
    overlappingSignals: string[];
    differingSignals: string[];
  }>;
}

const ADJUDICATION_SYSTEM_PROMPT = `You are an expert bug triage analyst. Your job is to determine whether a newly submitted bug report is a duplicate of existing issues.

For each candidate issue, you must decide:
- DUPLICATE: The submission describes the same underlying bug. Same root cause, same user-facing symptom.
- POSSIBLE_DUPLICATE: Significant overlap but differences that could mean it's a distinct bug (different trigger, different environment, additional symptoms).
- NOT_DUPLICATE: Different bugs that happen to share some surface keywords.

Scoring rules:
- confidence 0.90-1.0: Very high certainty (exact same steps, same error, same component)
- confidence 0.70-0.89: High certainty (same component, similar symptoms, minor differences)
- confidence 0.50-0.69: Medium (overlapping area, but important unknowns)
- confidence 0.30-0.49: Low (some keyword overlap, probably different bugs)
- confidence 0.0-0.29: Very low (not related)

Be conservative: mark DUPLICATE only when you are genuinely confident it's the same bug.
Mark POSSIBLE_DUPLICATE when there's meaningful overlap but you cannot rule out it being distinct.

Provide concrete reasoning citing specific signals from both the submission and candidate.`;

/**
 * Production LLM-backed duplicate adjudication.
 */
export class LlmDuplicateAdjudicator implements DuplicateAdjudicationProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly maxCandidatesPerCall: number;

  constructor(config: LlmAdjudicationConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = config.model;
    this.temperature = config.temperature ?? 0.1;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxCandidatesPerCall = config.maxCandidatesPerCall ?? 10;
  }

  async adjudicate(
    submissionSummary: string,
    candidates: Array<{ issueNumber: number; title: string; body?: string | null; similarity: number }>,
  ): Promise<DuplicateCandidateDecision[]> {
    if (candidates.length === 0) return [];

    // Limit candidates passed to LLM to bounded context
    const bounded = candidates.slice(0, this.maxCandidatesPerCall);

    const userPrompt = this.buildUserPrompt(submissionSummary, bounded);

    const response = await this.callLlm(userPrompt);
    const parsed = this.parseResponse(response, bounded);

    return parsed;
  }

  private buildUserPrompt(
    submissionSummary: string,
    candidates: Array<{ issueNumber: number; title: string; body?: string | null; similarity: number }>,
  ): string {
    const candidateDescriptions = candidates
      .map(
        (c, i) =>
          `### Candidate ${i + 1} (Issue #${c.issueNumber}, lexical similarity: ${c.similarity.toFixed(2)})
Title: ${c.title}
Body: ${(c.body ?? "").slice(0, 1000)}`,
      )
      .join("\n\n");

    return `## New Bug Submission
${submissionSummary}

## Existing Candidate Issues
${candidateDescriptions}

## Instructions
For each candidate, provide your verdict. Respond with valid JSON matching this schema:
{
  "candidates": [
    {
      "issueNumber": <number>,
      "verdict": "DUPLICATE" | "POSSIBLE_DUPLICATE" | "NOT_DUPLICATE",
      "confidence": <number between 0 and 1>,
      "reasoning": "<2-3 sentences explaining your decision>",
      "overlappingSignals": ["<signal1>", "<signal2>"],
      "differingSignals": ["<signal1>", "<signal2>"]
    }
  ]
}`;
  }

  private async callLlm(userPrompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          messages: [
            { role: "system", content: ADJUDICATION_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`LLM adjudication API returned ${response.status}: ${body.slice(0, 200)}`);
      }

      const json = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };

      return json.choices[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseResponse(
    response: string,
    candidates: Array<{ issueNumber: number; title: string; body?: string | null; similarity: number }>,
  ): DuplicateCandidateDecision[] {
    try {
      const parsed = JSON.parse(response) as LlmAdjudicationResult;

      if (!parsed.candidates || !Array.isArray(parsed.candidates)) {
        // Fallback: return heuristic decisions based on similarity
        return this.fallbackDecisions(candidates);
      }

      return parsed.candidates.map((c) => {
        const verdict = this.normalizeVerdict(c.verdict);
        return {
          issueNumber: c.issueNumber,
          similarity: candidates.find((cand) => cand.issueNumber === c.issueNumber)?.similarity ?? 0,
          verdict,
          confidence: Math.min(1, Math.max(0, c.confidence)),
          reasoning: c.reasoning || "LLM provided no reasoning.",
          overlappingSignals: c.overlappingSignals ?? [],
          differingSignals: c.differingSignals ?? [],
        };
      });
    } catch {
      // JSON parse failure: fall back to heuristic
      return this.fallbackDecisions(candidates);
    }
  }

  private normalizeVerdict(v: string): DuplicateVerdict {
    const upper = v?.toUpperCase?.() ?? "";
    if (upper === "DUPLICATE") return "DUPLICATE";
    if (upper === "POSSIBLE_DUPLICATE") return "POSSIBLE_DUPLICATE";
    return "NOT_DUPLICATE";
  }

  private fallbackDecisions(
    candidates: Array<{ issueNumber: number; title: string; body?: string | null; similarity: number }>,
  ): DuplicateCandidateDecision[] {
    return candidates.map((c) => ({
      issueNumber: c.issueNumber,
      similarity: c.similarity,
      verdict: (c.similarity >= 0.75 ? "DUPLICATE" : c.similarity >= 0.5 ? "POSSIBLE_DUPLICATE" : "NOT_DUPLICATE") as DuplicateVerdict,
      confidence: c.similarity,
      reasoning: `LLM adjudication failed; falling back to heuristic (similarity: ${c.similarity.toFixed(2)}).`,
      overlappingSignals: [],
      differingSignals: [],
    }));
  }
}

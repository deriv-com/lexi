import { describe, it, expect, vi } from "vitest";
import { IssueAnalysisService, type AnalysisLLMClient } from "./issue-analysis.service";
import type { IssueAnalysisInput } from "./issue-analysis.types";

const sampleInput: IssueAnalysisInput = {
  issueNumber: 856,
  title: "Cashier withdrawal crash on iOS",
  body: "Steps to reproduce:\n1. Open cashier\n2. Select withdrawal\n3. Enter amount\n4. Submit\n\nExpected: success. Actual: app crashes with TypeError.\n\nEnvironment: iOS 17, Safari.",
  labels: ["bug", "domain:cashier", "priority:P1"],
  authorLogin: "bob",
  state: "open",
  createdAt: new Date("2026-07-15"),
};

function createMockClient(response: string): AnalysisLLMClient {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({ choices: [{ message: { content: response } }] })),
      },
    },
  };
}

function createFailingClient(error: string): AnalysisLLMClient {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => { throw new Error(error); }),
      },
    },
  };
}

const config = { model: "claude-sonnet-5", promptVersion: "v1.0" };

describe("IssueAnalysisService", () => {
  it("parses a well-formed LLM response", async () => {
    const llmResponse = JSON.stringify({
      bugClass: ["payment failure", "runtime error"],
      likelyComponent: "cashier",
      likelyRepositories: ["acme/web-app"],
      evidenceQuality: "strong",
      likelyFalsePositive: false,
      falsePositiveReasons: [],
      codeSearchTerms: ["withdrawal", "cashier", "TypeError"],
      suspectedFiles: ["src/cashier/withdrawal.ts"],
      lifecycleStates: ["deposit", "withdrawal"],
      reproductionValue: "high",
      confidence: 0.85,
      expectedBehaviourLikely: false,
      reportCompleteness: "complete",
      expectedBehaviour: "Withdrawal completes successfully",
      actualBehaviour: "App crashes with TypeError",
      errorStrings: ["TypeError: Cannot read property 'amount' of undefined"],
      affectedPlatform: "mobile",
      possibleRootCause: "Null reference when withdrawal form state is not initialized",
    });

    const service = new IssueAnalysisService(createMockClient(llmResponse), config);
    const result = await service.analyse(sampleInput);

    expect(result.source).toBe("llm");
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.promptVersion).toBe("v1.0");
    expect(result.analysis.bugClass).toContain("payment failure");
    expect(result.analysis.likelyComponent).toBe("cashier");
    expect(result.analysis.evidenceQuality).toBe("strong");
    expect(result.analysis.confidence).toBe(0.85);
    expect(result.analysis.reproductionValue).toBe("high");
    expect(result.analysis.errorStrings).toHaveLength(1);
    expect(result.analysis.affectedPlatform).toBe("mobile");
  });

  it("falls back gracefully when LLM fails", async () => {
    const service = new IssueAnalysisService(createFailingClient("Rate limit exceeded"), config);
    const result = await service.analyse(sampleInput);

    expect(result.source).toBe("fallback");
    expect(result.model).toBe("deterministic-fallback");
    expect(result.analysis.confidence).toBe(0.3);
    // Fallback still extracts what it can from title/labels
    expect(result.analysis.bugClass.length).toBeGreaterThan(0);
    // The sample body is ~175 chars; fallback threshold for "partial" is >200 chars
    expect(["minimal", "partial"]).toContain(result.analysis.reportCompleteness);
  });

  it("falls back when LLM returns empty output", async () => {
    const client: AnalysisLLMClient = {
      chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: "" } }] })) } },
    };
    const service = new IssueAnalysisService(client, config);
    const result = await service.analyse(sampleInput);

    expect(result.source).toBe("fallback");
  });

  it("falls back when LLM returns invalid JSON", async () => {
    const service = new IssueAnalysisService(createMockClient("not valid json {{{"), config);
    const result = await service.analyse(sampleInput);

    expect(result.source).toBe("fallback");
  });

  it("clamps confidence to [0, 1] range", async () => {
    const overconfident = JSON.stringify({
      bugClass: ["test"], likelyComponent: null, likelyRepositories: [],
      evidenceQuality: "medium", likelyFalsePositive: false, falsePositiveReasons: [],
      codeSearchTerms: [], suspectedFiles: [], lifecycleStates: [],
      reproductionValue: "medium", confidence: 1.5,
      expectedBehaviourLikely: false, reportCompleteness: "partial",
      expectedBehaviour: null, actualBehaviour: null, errorStrings: [],
      affectedPlatform: null, possibleRootCause: null,
    });

    const service = new IssueAnalysisService(createMockClient(overconfident), config);
    const result = await service.analyse(sampleInput);

    expect(result.analysis.confidence).toBe(1.0);
  });

  it("deterministic fallback extracts platform from body", async () => {
    const mobileInput: IssueAnalysisInput = {
      ...sampleInput,
      body: "App crashes on Android 14 when tapping the deposit button",
    };
    const service = new IssueAnalysisService(createFailingClient("down"), config);
    const result = await service.analyse(mobileInput);

    expect(result.analysis.affectedPlatform).toBe("mobile");
  });

  it("deterministic fallback detects error strings", async () => {
    const errorInput: IssueAnalysisInput = {
      ...sampleInput,
      body: "Getting this error: TypeError: Cannot read property of null\nHappens every time.",
    };
    const service = new IssueAnalysisService(createFailingClient("timeout"), config);
    const result = await service.analyse(errorInput);

    expect(result.analysis.errorStrings.length).toBeGreaterThan(0);
  });

  it("stores input revision for auditability", async () => {
    const llmResponse = JSON.stringify({
      bugClass: ["test"], likelyComponent: null, likelyRepositories: [],
      evidenceQuality: "weak", likelyFalsePositive: false, falsePositiveReasons: [],
      codeSearchTerms: [], suspectedFiles: [], lifecycleStates: [],
      reproductionValue: "low", confidence: 0.5,
      expectedBehaviourLikely: false, reportCompleteness: "minimal",
      expectedBehaviour: null, actualBehaviour: null, errorStrings: [],
      affectedPlatform: null, possibleRootCause: null,
    });
    const service = new IssueAnalysisService(createMockClient(llmResponse), config);
    const result = await service.analyse(sampleInput);

    expect(result.inputRevision).toContain("856");
    expect(result.inputRevision).toContain("Cashier withdrawal");
    expect(result.analysedAt).toBeInstanceOf(Date);
  });
});

describe("gateway compatibility", () => {
  // Some gateway backends reject both `strict` and a non-default temperature
  // with an opaque 400. Here that is worse than in the decision engine,
  // because the catch degrades to a heuristic analysis rather than surfacing
  // an error — so EVIDENCE_PIPELINE_LLM_ENABLED would read as on while no
  // analysis ever reached the model.
  function payloadFrom(client: AnalysisLLMClient): Record<string, unknown> {
    return (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
  }

  const validResponse = JSON.stringify({
    bugClass: "crash",
    likelyComponent: "cashier",
    likelyRepositories: ["web-app"],
    evidenceQuality: "high",
    likelyFalsePositive: false,
    falsePositiveReasons: [],
    codeSearchTerms: ["withdrawal"],
    suspectedFiles: [],
    lifecycleStates: ["authenticated"],
    reproductionValue: "high",
    confidence: 0.8,
    expectedBehaviourLikely: true,
    reportCompleteness: "complete",
    expectedBehaviour: "success",
    actualBehaviour: "crash",
    errorStrings: ["TypeError"],
    affectedPlatform: "ios",
    possibleRootCause: "null deref",
  });

  it("sends neither strict nor temperature by default", async () => {
    const client = createMockClient(validResponse);
    const service = new IssueAnalysisService(client, { model: "claude-sonnet-5", promptVersion: "v1" });

    await service.analyse(sampleInput);

    const payload = payloadFrom(client);
    expect(payload).not.toHaveProperty("temperature");
    const format = payload.response_format as { type: string; json_schema: Record<string, unknown> };
    expect(format.json_schema).not.toHaveProperty("strict");
    // The schema is still sent — validation moved to us, it did not vanish.
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.schema).toBeDefined();
  });

  // The endpoint is the third possible rejection: a gateway can 400
  // `/v1/responses` for a non-OpenAI backend.
  it("calls chat.completions, never the Responses API", async () => {
    const client = createMockClient(validResponse);
    const service = new IssueAnalysisService(client, { model: "claude-sonnet-5", promptVersion: "v1" });

    await service.analyse(sampleInput);

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(client).not.toHaveProperty("responses");
    const payload = payloadFrom(client);
    expect(payload).not.toHaveProperty("input");
    expect(payload).not.toHaveProperty("text");
    expect(payload.messages).toBeDefined();
  });

  // A wrapped response used to be indistinguishable from an LLM failure: it
  // would fail validation and degrade to the deterministic fallback.
  it("unwraps a {parameters:{...}} envelope instead of falling back", async () => {
    const client = createMockClient(JSON.stringify({ parameters: JSON.parse(validResponse) }));
    const service = new IssueAnalysisService(client, { model: "claude-sonnet-5", promptVersion: "v1" });

    const result = await service.analyse(sampleInput);

    expect(result.source).toBe("llm");
    expect(result.analysis.likelyComponent).toBe("cashier");
  });

  it("still sends temperature when one is explicitly configured", async () => {
    const client = createMockClient(validResponse);
    const service = new IssueAnalysisService(client, { model: "claude-sonnet-5", promptVersion: "v1", temperature: 0.4 });

    await service.analyse(sampleInput);

    expect(payloadFrom(client).temperature).toBe(0.4);
  });
});

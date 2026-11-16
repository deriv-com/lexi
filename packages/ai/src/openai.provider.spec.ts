import { describe, it, expect, vi } from "vitest";
import { PinoLoggerService } from "@lexi/logger";
import { OpenAiProvider } from "./openai.provider";
import { OpenAiChatClient } from "./openai-client.types";
import { AiDecisionInput } from "./types";

const sampleInput: AiDecisionInput = {
  issue: {
    number: 101,
    title: "Deposit button unresponsive on mobile web",
    body: "Tapping deposit does nothing on iOS Safari.",
    url: "https://github.com/acme-internal/issues/issues/101",
    authorLogin: "qa-engineer",
    labels: ["bug", "domain:web", "priority:P2"],
  },
  reproduction: {
    status: "COMPLETED",
    resultSummary: "Reproduced: button click handler throws TypeError",
    resultDetails: { attempts: 1 },
    logsUrl: "https://logs.example.com/101",
  },
};

function makeClient(outputText: string): OpenAiChatClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content: outputText } }] }),
      },
    },
  };
}

function payloadFrom(client: OpenAiChatClient): Record<string, unknown> {
  return (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
}

const validDecision = {
  classification: "VERIFIED",
  component: "web",
  team: "Web",
  confidence: 0.9,
  labels: ["bug"],
  summary: "s",
  reasoning: "r",
  nextAction: "n",
};

describe("OpenAiProvider", () => {
  it("parses and validates a well-formed decision response", async () => {
    const decisionJson = JSON.stringify({
      classification: "VERIFIED",
      component: "web",
      team: "Web",
      owner: "alice-web",
      confidence: 0.92,
      labels: ["bug", "domain:web", "priority:P2", "status:to_do"],
      summary: "Deposit button is broken on iOS Safari.",
      reasoning: "Reproduction bot confirmed a TypeError is thrown on click.",
      nextAction: "Assign to Web team for a fix.",
    });
    const provider = new OpenAiProvider(makeClient(decisionJson), { model: "gpt-4.1-mini" }, new PinoLoggerService({ level: "silent" }));
    const decision = await provider.generateDecision(sampleInput);
    expect(decision.classification).toBe("VERIFIED");
    expect(decision.component).toBe("web");
    expect(decision.confidence).toBe(0.92);
  });

  it("clamps out-of-range confidence into [0, 1]", async () => {
    const decisionJson = JSON.stringify({
      classification: "VERIFIED",
      component: "web",
      team: "Web",
      confidence: 1.4,
      labels: [],
      summary: "s",
      reasoning: "r",
      nextAction: "n",
    });
    const provider = new OpenAiProvider(makeClient(decisionJson), { model: "gpt-4.1-mini" }, new PinoLoggerService({ level: "silent" }));
    const decision = await provider.generateDecision(sampleInput);
    expect(decision.confidence).toBe(1);
  });

  it("throws when the model output is not valid JSON", async () => {
    const provider = new OpenAiProvider(makeClient("not json"), { model: "gpt-4.1-mini" }, new PinoLoggerService({ level: "silent" }));
    await expect(provider.generateDecision(sampleInput)).rejects.toThrow(/could not be parsed/);
  });

  it("throws when the model output fails schema validation", async () => {
    const decisionJson = JSON.stringify({ classification: "NOT_A_REAL_CLASSIFICATION" });
    const provider = new OpenAiProvider(makeClient(decisionJson), { model: "gpt-4.1-mini" }, new PinoLoggerService({ level: "silent" }));
    await expect(provider.generateDecision(sampleInput)).rejects.toThrow(/failed validation/);
  });

  it("throws when the response carries no message content", async () => {
    const client: OpenAiChatClient = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [] }) } },
    };
    const provider = new OpenAiProvider(client, { model: "gpt-4.1-mini" }, new PinoLoggerService({ level: "silent" }));
    await expect(provider.generateDecision(sampleInput)).rejects.toThrow(/did not contain any message content/);
  });

  describe("temperature", () => {
    const decisionJson = JSON.stringify(validDecision);

    it("does not send a temperature field when none is configured", async () => {
      const client = makeClient(decisionJson);
      const provider = new OpenAiProvider(client, { model: "gpt-4.1-mini" }, new PinoLoggerService({ level: "silent" }));
      await provider.generateDecision(sampleInput);

      expect(payloadFrom(client)).not.toHaveProperty("temperature");
    });

    it("sends the configured temperature when explicitly set", async () => {
      const client = makeClient(decisionJson);
      const provider = new OpenAiProvider(
        client,
        { model: "gpt-4.1-mini", temperature: 0.5 },
        new PinoLoggerService({ level: "silent" }),
      );
      await provider.generateDecision(sampleInput);

      expect(payloadFrom(client).temperature).toBe(0.5);
    });
  });
});

describe("gateway compatibility", () => {
  // An OpenAI-compatible gateway can reject the Responses API
  // (`/v1/responses`) with a bare 400 for non-OpenAI backends. If the provider
  // used it, every decision call would fail and surface as 0-confidence
  // NEEDS_MANUAL_INVESTIGATION notices that read like considered verdicts.
  // Chat Completions is the endpoint such gateways support across backends.
  it("calls chat.completions, never the Responses API", async () => {
    const client = makeClient(JSON.stringify(validDecision));
    const provider = new OpenAiProvider(client, { model: "claude-sonnet-5" }, new PinoLoggerService({ level: "silent" }));

    await provider.generateDecision(sampleInput);

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(client).not.toHaveProperty("responses");
    const payload = payloadFrom(client);
    // The Responses-API request shape must not leak through either.
    expect(payload).not.toHaveProperty("input");
    expect(payload).not.toHaveProperty("text");
    expect(payload.messages).toBeDefined();
  });

  // `strict: true` is an OpenAI-specific guarantee that non-OpenAI backends
  // behind a gateway can also reject with a bare 400.
  it("does not send strict on the structured-output format", async () => {
    const client = makeClient(JSON.stringify(validDecision));
    const provider = new OpenAiProvider(client, { model: "claude-sonnet-5" }, new PinoLoggerService({ level: "silent" }));

    await provider.generateDecision(sampleInput);

    const format = (payloadFrom(client).response_format as {
      type: string;
      json_schema: Record<string, unknown>;
    });
    expect(format.json_schema).not.toHaveProperty("strict");
    // The schema itself must still be sent — validation moved to us, it did not vanish.
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.schema).toBeDefined();
  });

  it("omits temperature unless one is configured", async () => {
    const client = makeClient(JSON.stringify(validDecision));
    const provider = new OpenAiProvider(client, { model: "claude-sonnet-5" }, new PinoLoggerService({ level: "silent" }));

    await provider.generateDecision(sampleInput);

    expect(payloadFrom(client)).not.toHaveProperty("temperature");
  });

  // The gateway implements structured output as a forced tool call for Claude
  // and non-deterministically wraps the payload in a `{"parameters": {...}}`
  // envelope. ClaudeReproductionProvider already unwraps this on the same
  // endpoint; the decision engine inherits the quirk by moving here.
  it("unwraps a {parameters:{...}} envelope before validation", async () => {
    const client = makeClient(JSON.stringify({ parameters: validDecision }));
    const provider = new OpenAiProvider(client, { model: "claude-sonnet-5" }, new PinoLoggerService({ level: "silent" }));

    const decision = await provider.generateDecision(sampleInput);

    expect(decision.classification).toBe("VERIFIED");
    expect(decision.confidence).toBe(0.9);
  });

  it("still accepts a flat (unwrapped) payload", async () => {
    const client = makeClient(JSON.stringify(validDecision));
    const provider = new OpenAiProvider(client, { model: "claude-sonnet-5" }, new PinoLoggerService({ level: "silent" }));

    const decision = await provider.generateDecision(sampleInput);

    expect(decision.classification).toBe("VERIFIED");
  });
});

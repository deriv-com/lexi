import { PinoLoggerService } from "@lexi/logger";
import { createPiiMasker } from "@lexi/privacy";
import { describe, expect, it, vi } from "vitest";
import { createOpenAiClient } from "./openai-client.factory";
import type { OpenAiChatClient, OpenAiChatCompletionCreateParams } from "./openai-client.types";
import { OpenAiProvider } from "./openai.provider";
import { withPiiMasking } from "./pii-masking-chat-client";

const sdkCreate = vi.hoisted(() =>
  vi.fn(async (_params: OpenAiChatCompletionCreateParams) => ({ choices: [{ message: { content: "{}" } }] })),
);
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: sdkCreate } };
  },
}));

const decision = JSON.stringify({
  classification: "VERIFIED",
  component: "web",
  team: "Web",
  confidence: 0.9,
  labels: ["bug"],
  summary: "s",
  reasoning: "r",
  nextAction: "n",
});

function fakeClient(): OpenAiChatClient & { sent: OpenAiChatCompletionCreateParams[] } {
  const sent: OpenAiChatCompletionCreateParams[] = [];
  return {
    sent,
    chat: {
      completions: {
        create: vi.fn(async (params: OpenAiChatCompletionCreateParams) => {
          sent.push(params);
          return { choices: [{ message: { content: decision } }] };
        }),
      },
    },
  };
}

describe("decision engine PII masking", () => {
  it("masks the issue, comments and evidence before the prompt is sent", async () => {
    const raw = fakeClient();
    const onMasked = vi.fn();
    const provider = new OpenAiProvider(
      withPiiMasking(raw, { masker: createPiiMasker(), onMasked }),
      { model: "decision-model" },
      new PinoLoggerService({ level: "silent" }),
    );

    await provider.generateDecision({
      issue: {
        number: 4321,
        title: "Deposit fails for alice@example.com",
        body: "Card 4111 1111 1111 1111 declined; call me on +44 20 7946 0958. Logged in from 203.0.113.7.",
        url: "https://github.com/acme/issues/issues/4321",
        authorLogin: "alice-acme",
        labels: ["bug"],
      },
      reproduction: {
        status: "COMPLETED",
        resultSummary: "Refund to GB82 WEST 1234 5698 7654 32 failed",
        logsUrl: "https://logs.example.com/4321",
      },
      existingComments: ["Same for bob@example.com"],
    });

    const params = raw.sent[0];
    const prompt = params.messages.map((m) => m.content).join("\n");
    for (const secret of ["alice@example.com", "bob@example.com", "4111 1111 1111 1111", "+44 20 7946 0958", "203.0.113.7", "GB82 WEST"]) {
      expect(prompt).not.toContain(secret);
    }
    for (const placeholder of ["[email]", "[card]", "[phone]", "[ip]", "[iban]"]) expect(prompt).toContain(placeholder);
    // What the model needs to reason about the issue survives.
    expect(prompt).toContain("alice-acme");
    expect(prompt).toContain("https://github.com/acme/issues/issues/4321");
    expect(prompt).toContain("4321");
    expect(params.model).toBe("decision-model");
    expect(params.response_format?.json_schema.name).toBeTruthy();
    expect(onMasked).toHaveBeenCalledWith(expect.objectContaining({ email: 2, card: 1, phone: 1, ip: 1, iban: 1 }));
  });

  it("returns the client unchanged when masking is off", () => {
    const raw = fakeClient();
    expect(withPiiMasking(raw, false)).toBe(raw);
    expect(withPiiMasking(raw)).not.toBe(raw);
  });

  it("is on by default in createOpenAiClient, and off only when asked", async () => {
    const send = (client: OpenAiChatClient) =>
      client.chat.completions.create({ model: "m", messages: [{ role: "user", content: "from alice@example.com" }] });

    await send(createOpenAiClient({ apiKey: "k", baseURL: "https://gateway.test/v1" }));
    await send(createOpenAiClient({ apiKey: "k", baseURL: "https://gateway.test/v1", piiMasking: false }));

    expect(sdkCreate.mock.calls[0][0].messages[0].content).toBe("from [email]");
    expect(sdkCreate.mock.calls[1][0].messages[0].content).toBe("from alice@example.com");
  });
});

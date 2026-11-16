import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ProgrammeController } from "./programme.controller";
import { PROGRAMME_HTTP_DEPS_TOKEN, type ProgrammeHttpDeps } from "./programme-http.deps";
import { ProgrammeBriefTokenGuard, ProgrammeEvidenceTokenGuard } from "./programme-token.guard";

/**
 * The brief endpoint hands a build agent its instructions, so an auth mistake
 * here is an instruction-injection channel. Every guard branch is asserted,
 * in order: enablement, token CONFIGURED (fail closed), token match, lookup.
 */

const BRIEF_TOKEN = "test-brief-token";
const EVIDENCE_TOKEN = "test-evidence-token";

function deps(overrides: Partial<ProgrammeHttpDeps> = {}): ProgrammeHttpDeps {
  return {
    programmeEnabled: true,
    briefToken: BRIEF_TOKEN,
    evidenceEnabled: true,
    evidenceToken: EVIDENCE_TOKEN,
    build: {
      briefForAttempt: vi.fn(async (id: string) =>
        id === "attempt-1"
          ? ({ briefVersion: 1, buildTaskId: "t1", acceptanceCriteria: [{ id: "AC-aaaa1111", text: "x" }] } as never)
          : null,
      ),
      apiReferenceDocument: vi.fn(async (index: number) => (index === 0 ? ({ title: "Ref", markdown: "# Ref" } as never) : null)),
    },
    store: {
      getDesignContext: vi.fn(async (id: string) => (id === "dc-1" ? ({ id: "dc-1", states: [] } as never) : null)),
      getApiContract: vi.fn(async (id: string) => (id === "api-1" ? ({ id: "api-1", operations: [] } as never) : null)),
    },
    evidence: {
      ingest: vi.fn(async (input: unknown, options) => {
        const body = input as { attemptId?: string; phase?: string; repository?: string };
        if (!body.phase) return { accepted: false, attemptId: body.attemptId ?? "", phase: "checks", reason: "phase must be one of red, green, refactor, checks" } as const;
        if (!(await options.isKnownAttempt(body.attemptId ?? ""))) {
          return { accepted: false, attemptId: body.attemptId ?? "", phase: "green", reason: "unknown attempt" } as const;
        }
        const expected = await options.repositoryOfAttempt?.(body.attemptId ?? "");
        if (expected && body.repository !== expected) {
          return { accepted: false, attemptId: body.attemptId ?? "", phase: "green", reason: "repository does not match the attempt" } as const;
        }
        return { accepted: true, attemptId: body.attemptId ?? "", phase: "green", evidenceId: "ev-1" } as const;
      }),
    },
    isKnownAttempt: async (id) => id === "attempt-1",
    repositoryOfAttempt: async (id) => (id === "attempt-1" ? "acme/web-app" : null),
    logger: { log: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

let app: INestApplication | undefined;

async function start(value: ProgrammeHttpDeps): Promise<string> {
  @Module({
    controllers: [ProgrammeController],
    providers: [{ provide: PROGRAMME_HTTP_DEPS_TOKEN, useValue: value }, ProgrammeBriefTokenGuard, ProgrammeEvidenceTokenGuard],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  return app.getUrl();
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function get(base: string, path: string, token?: string) {
  const response = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined };
}

async function post(base: string, path: string, body: unknown, token?: string) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined };
}

describe("ProgrammeController brief auth", () => {
  it("refuses while PROGRAMME_ENABLED is off, before looking at the token", async () => {
    const value = deps({ programmeEnabled: false });
    const base = await start(value);
    expect((await get(base, "/api/programme/briefs/attempt-1", BRIEF_TOKEN)).status).toBe(403);
    expect(value.build!.briefForAttempt).not.toHaveBeenCalled();
  });

  it("refuses everything when the token is UNSET: a misconfiguration, never auth-disabled", async () => {
    const value = deps({ briefToken: "" });
    const base = await start(value);
    for (const token of [undefined, "", "anything"]) {
      const result = await get(base, "/api/programme/briefs/attempt-1", token);
      expect(result.status).toBe(403);
      expect(String(result.body?.message)).toContain("PROGRAMME_BRIEF_TOKEN");
    }
    expect(value.build!.briefForAttempt).not.toHaveBeenCalled();
  });

  it("401s a missing, wrong or evidence-channel bearer", async () => {
    const value = deps();
    const base = await start(value);
    for (const token of [undefined, "wrong", EVIDENCE_TOKEN, `${BRIEF_TOKEN}x`]) {
      expect((await get(base, "/api/programme/briefs/attempt-1", token)).status).toBe(401);
    }
    expect(value.build!.briefForAttempt).not.toHaveBeenCalled();
  });

  it("guards every read route the same way", async () => {
    const base = await start(deps());
    for (const path of [
      "/api/programme/briefs/attempt-1",
      "/api/programme/design-context/dc-1",
      "/api/programme/api-contract/api-1",
      "/api/programme/api-references/0/abc1234",
    ]) {
      expect((await get(base, path)).status, path).toBe(401);
      expect((await get(base, path, BRIEF_TOKEN)).status, path).toBe(200);
    }
  });
});

describe("ProgrammeController brief routes", () => {
  it("serves a known attempt's brief and 404s an unknown one", async () => {
    const value = deps();
    const base = await start(value);
    const ok = await get(base, "/api/programme/briefs/attempt-1", BRIEF_TOKEN);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ buildTaskId: "t1" });
    expect((await get(base, "/api/programme/briefs/nope", BRIEF_TOKEN)).status).toBe(404);
    // The log names the shape only.
    expect(value.logger!.log).toHaveBeenCalledWith(expect.stringContaining("1 criteria"), "ProgrammeController");
  });

  it("404s unknown documents and malformed reference coordinates without calling the service", async () => {
    const value = deps();
    const base = await start(value);
    expect((await get(base, "/api/programme/design-context/dc-x", BRIEF_TOKEN)).status).toBe(404);
    expect((await get(base, "/api/programme/api-contract/api-x", BRIEF_TOKEN)).status).toBe(404);
    expect((await get(base, "/api/programme/api-references/1/abc1234", BRIEF_TOKEN)).status).toBe(404);
    const calls = (value.build!.apiReferenceDocument as ReturnType<typeof vi.fn>).mock.calls.length;
    for (const path of ["/api/programme/api-references/x/abc1234", "/api/programme/api-references/123/abc1234", "/api/programme/api-references/0/not-a-sha"]) {
      expect((await get(base, path, BRIEF_TOKEN)).status, path).toBe(404);
    }
    expect((value.build!.apiReferenceDocument as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it("501s a route whose dependency is not wired", async () => {
    const base = await start(deps({ build: null, store: null }));
    expect((await get(base, "/api/programme/briefs/attempt-1", BRIEF_TOKEN)).status).toBe(501);
    expect((await get(base, "/api/programme/design-context/dc-1", BRIEF_TOKEN)).status).toBe(501);
  });
});

describe("ProgrammeController evidence ingest", () => {
  const bundle = { attemptId: "attempt-1", phase: "green", repository: "acme/web-app" };

  it("fails closed: disabled, unset token, wrong token and brief token are all refused", async () => {
    for (const [overrides, token, status] of [
      [{ evidenceEnabled: false }, EVIDENCE_TOKEN, 403],
      [{ evidenceToken: "" }, EVIDENCE_TOKEN, 403],
      [{}, "wrong", 401],
      [{}, BRIEF_TOKEN, 401],
      [{}, undefined, 401],
    ] as const) {
      const value = deps(overrides);
      const base = await start(value);
      expect((await post(base, "/api/evidence", bundle, token)).status).toBe(status);
      expect(value.evidence!.ingest).not.toHaveBeenCalled();
      await app?.close();
      app = undefined;
    }
  });

  it("stores a bundle for a known attempt and returns the receipt", async () => {
    const base = await start(deps());
    const result = await post(base, "/api/evidence", bundle, EVIDENCE_TOKEN);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ accepted: true, evidenceId: "ev-1" });
  });

  it("404s an unknown attempt and 400s a malformed bundle", async () => {
    const base = await start(deps());
    expect((await post(base, "/api/evidence", { ...bundle, attemptId: "nope" }, EVIDENCE_TOKEN)).status).toBe(404);
    const malformed = await post(base, "/api/evidence", { attemptId: "attempt-1" }, EVIDENCE_TOKEN);
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ accepted: false });
  });

  it("403s evidence that names another repository than its attempt, or none", async () => {
    const base = await start(deps());
    const other = await post(base, "/api/evidence", { ...bundle, repository: "acme/other-app" }, EVIDENCE_TOKEN);
    expect(other.status).toBe(403);
    expect(other.body).toMatchObject({ accepted: false, reason: "repository does not match the attempt" });
    const { repository: _omitted, ...unnamed } = bundle;
    expect((await post(base, "/api/evidence", unnamed, EVIDENCE_TOKEN)).status).toBe(403);
  });
});

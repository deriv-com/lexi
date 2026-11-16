import "reflect-metadata";
import { describe, it, expect, afterEach } from "vitest";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ActionsController } from "./actions.controller";
import { BearerTokenGuard } from "./bearer-token.guard";
import { CONFIG_TOKEN, ISSUE_WORKFLOW_PORT_TOKEN } from "../tokens";
import type { IssueTarget, IssueWorkflowPort } from "../ports/issue-workflow.port";
import { NotWiredError, UnknownRepositoryError } from "../wiring/errors";

const TOKEN = "test-process-token";

class RecordingPort implements IssueWorkflowPort {
  readonly calls: Array<[string, IssueTarget]> = [];
  async process(target: IssueTarget) {
    this.calls.push(["process", target]);
    return { status: "processing", issueNumber: target.issueNumber };
  }
  async reprocess(target: IssueTarget) {
    this.calls.push(["reprocess", target]);
    return { status: "reprocessing" };
  }
  async retest(target: IssueTarget) {
    this.calls.push(["retest", target]);
    return undefined;
  }
}

let app: INestApplication | undefined;

async function start(token: string, port: IssueWorkflowPort): Promise<string> {
  @Module({
    controllers: [ActionsController],
    providers: [
      { provide: CONFIG_TOKEN, useValue: { PROCESS_API_TOKEN: token } },
      { provide: ISSUE_WORKFLOW_PORT_TOKEN, useValue: port },
      BearerTokenGuard,
    ],
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

async function post(base: string, path: string, body: unknown, token?: string) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

describe("POST /process and friends", () => {
  it("refuses everything when PROCESS_API_TOKEN is unset", async () => {
    const port = new RecordingPort();
    const base = await start("", port);
    expect((await post(base, "/process", { issueNumber: 1 }, "anything")).status).toBe(403);
    expect((await post(base, "/process", { issueNumber: 1 })).status).toBe(403);
    expect(port.calls).toEqual([]);
  });

  it("returns 401 for a missing or wrong token", async () => {
    const port = new RecordingPort();
    const base = await start(TOKEN, port);
    expect((await post(base, "/process", { issueNumber: 1 })).status).toBe(401);
    expect((await post(base, "/reprocess", { issueNumber: 1 }, "wrong")).status).toBe(401);
    expect(port.calls).toEqual([]);
  });

  it("calls the workflow port with the validated body when the token is right", async () => {
    const port = new RecordingPort();
    const base = await start(TOKEN, port);

    const processed = await post(base, "/process", { repository: "acme/web", issueNumber: 12 }, TOKEN);
    expect(processed).toEqual({ status: 200, body: { status: "processing", issueNumber: 12 } });
    expect((await post(base, "/reprocess", { issueNumber: 3 }, TOKEN)).status).toBe(200);
    expect(await post(base, "/retest", { issueNumber: 4 }, TOKEN)).toEqual({ status: 200, body: { ok: true } });

    expect(port.calls).toEqual([
      ["process", { repository: "acme/web", issueNumber: 12 }],
      ["reprocess", { issueNumber: 3 }],
      ["retest", { issueNumber: 4 }],
    ]);
  });

  it("rejects an invalid body with 400 before the port sees it", async () => {
    const port = new RecordingPort();
    const base = await start(TOKEN, port);
    for (const body of [{}, { issueNumber: 0 }, { issueNumber: "12" }, { issueNumber: 1, repository: "no-slash" }, { issueNumber: 1, extra: true }]) {
      expect((await post(base, "/process", body, TOKEN)).status).toBe(400);
    }
    expect(port.calls).toEqual([]);
  });

  it("answers 501 while the workflow engine is not wired", async () => {
    const fail = async (): Promise<never> => {
      throw new NotWiredError("The workflow engine");
    };
    const base = await start(TOKEN, { process: fail, reprocess: fail, retest: fail });
    const response = await post(base, "/process", { issueNumber: 1 }, TOKEN);
    expect(response.status).toBe(501);
  });

  it("answers 400 for a repository the deployment does not manage", async () => {
    const fail = async (): Promise<never> => {
      throw new UnknownRepositoryError("someone/else");
    };
    const base = await start(TOKEN, { process: fail, reprocess: fail, retest: fail });
    const response = await post(base, "/process", { repository: "someone/else", issueNumber: 1 }, TOKEN);
    expect(response.status).toBe(400);
  });
});

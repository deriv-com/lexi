import { BadRequestException, Body, Controller, HttpCode, Inject, NotImplementedException, Post, UseGuards } from "@nestjs/common";
import { ISSUE_WORKFLOW_PORT_TOKEN } from "../tokens";
import type { IssueTarget, IssueWorkflowPort } from "../ports/issue-workflow.port";
import { NotWiredError, UnknownRepositoryError } from "../wiring/errors";
import { BearerTokenGuard } from "./bearer-token.guard";
import { parseIssueTarget } from "./issue-target.schema";

/**
 * Issue actions for schedulers and operators. Every route needs the bearer
 * token, and every body is validated before the workflow engine sees it.
 */
@Controller()
@UseGuards(BearerTokenGuard)
export class ActionsController {
  constructor(@Inject(ISSUE_WORKFLOW_PORT_TOKEN) private readonly workflows: IssueWorkflowPort) {}

  @Post("process")
  @HttpCode(200)
  process(@Body() body: unknown): Promise<unknown> {
    return this.call((target) => this.workflows.process(target), body);
  }

  @Post("reprocess")
  @HttpCode(200)
  reprocess(@Body() body: unknown): Promise<unknown> {
    return this.call((target) => this.workflows.reprocess(target), body);
  }

  @Post("retest")
  @HttpCode(200)
  retest(@Body() body: unknown): Promise<unknown> {
    return this.call((target) => this.workflows.retest(target), body);
  }

  private async call(action: (target: IssueTarget) => Promise<unknown>, body: unknown): Promise<unknown> {
    const target = parseIssueTarget(body);
    try {
      return (await action(target)) ?? { ok: true };
    } catch (error) {
      if (error instanceof NotWiredError) throw new NotImplementedException(error.message);
      if (error instanceof UnknownRepositoryError) throw new BadRequestException(error.message);
      throw error;
    }
  }
}

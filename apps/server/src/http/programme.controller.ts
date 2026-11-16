import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  NotImplementedException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { RunEvidenceReceipt } from "@lexi/contracts";
import { REPOSITORY_MISMATCH } from "@lexi/programme";
import { PROGRAMME_HTTP_DEPS_TOKEN, type ProgrammeHttpDeps } from "./programme-http.deps";
import { ProgrammeBriefTokenGuard, ProgrammeEvidenceTokenGuard } from "./programme-token.guard";

const CONTEXT = "ProgrammeController";

/**
 * What a dispatched build runner talks to.
 *
 *   GET  /api/programme/briefs/:attemptId          → BuildTaskBrief
 *   GET  /api/programme/design-context/:id         → DesignContextDocument
 *   GET  /api/programme/api-contract/:id           → ApiContractDocument
 *   GET  /api/programme/api-references/:i/:sha     → ApiReferenceDocument
 *   POST /api/evidence                             → RunEvidenceReceipt
 *
 * The reads take `PROGRAMME_BRIEF_TOKEN`, the write takes
 * `EVIDENCE_WEBHOOK_TOKEN`; both fail closed when unset. Evidence must also
 * name the repository its attempt was dispatched to (403 otherwise). The app module
 * always registers it; with the programme off, every route refuses.
 */
@Controller("api")
export class ProgrammeController {
  constructor(@Inject(PROGRAMME_HTTP_DEPS_TOKEN) private readonly deps: ProgrammeHttpDeps) {}

  @Get("programme/briefs/:attemptId")
  @UseGuards(ProgrammeBriefTokenGuard)
  async getBrief(@Param("attemptId") attemptId: string): Promise<unknown> {
    const build = this.requireBuild();
    const brief = await build.briefForAttempt(attemptId.trim());
    if (!brief) throw new NotFoundException("Unknown attempt, or not a programme build attempt.");
    // The shape, never the content.
    this.deps.logger?.log(
      `Brief served for attempt ${attemptId}: task ${brief.buildTaskId}, ${brief.acceptanceCriteria.length} criteria`,
      CONTEXT,
    );
    return brief;
  }

  @Get("programme/design-context/:id")
  @UseGuards(ProgrammeBriefTokenGuard)
  async getDesignContext(@Param("id") id: string): Promise<unknown> {
    const document = await this.requireStore().getDesignContext(id.trim());
    if (!document) throw new NotFoundException("Unknown design context document.");
    return document;
  }

  @Get("programme/api-contract/:id")
  @UseGuards(ProgrammeBriefTokenGuard)
  async getApiContract(@Param("id") id: string): Promise<unknown> {
    const document = await this.requireStore().getApiContract(id.trim());
    if (!document) throw new NotFoundException("Unknown API contract document.");
    return document;
  }

  @Get("programme/api-references/:index/:sha")
  @UseGuards(ProgrammeBriefTokenGuard)
  async getApiReference(@Param("index") index: string, @Param("sha") sha: string): Promise<unknown> {
    const build = this.requireBuild();
    const position = /^\d{1,2}$/.test(index.trim()) ? Number(index.trim()) : -1;
    const blobSha = sha.trim().toLowerCase();
    const document =
      position >= 0 && /^[0-9a-f]{7,64}$/.test(blobSha) ? await build.apiReferenceDocument(position, blobSha) : null;
    if (!document) throw new NotFoundException("Unknown API reference document (index not in policy, or blob unreadable).");
    return document;
  }

  @Post("evidence")
  @HttpCode(200)
  @UseGuards(ProgrammeEvidenceTokenGuard)
  async ingestEvidence(@Body() body: unknown): Promise<RunEvidenceReceipt> {
    if (!this.deps.evidence) throw new NotImplementedException("Evidence ingest is not wired on this deployment.");
    const receipt = await this.deps.evidence.ingest(body, {
      isKnownAttempt: (id) => this.deps.isKnownAttempt(id),
      repositoryOfAttempt: (id) => this.deps.repositoryOfAttempt(id),
    });
    if (!receipt.accepted) {
      this.deps.logger?.warn(`Evidence refused for attempt ${receipt.attemptId || "?"}: ${receipt.reason ?? "refused"}`, CONTEXT);
      if (receipt.reason === "unknown attempt") throw new NotFoundException(receipt);
      if (receipt.reason === REPOSITORY_MISMATCH) throw new ForbiddenException(receipt);
      throw new BadRequestException(receipt);
    }
    this.deps.logger?.log(
      `Evidence ${receipt.deduplicated ? "already held" : "stored"} for attempt ${receipt.attemptId}: phase ${receipt.phase}`,
      CONTEXT,
    );
    return receipt;
  }

  private requireBuild(): NonNullable<ProgrammeHttpDeps["build"]> {
    if (!this.deps.build) throw new NotImplementedException("The programme build service is not wired on this deployment.");
    return this.deps.build;
  }

  private requireStore(): NonNullable<ProgrammeHttpDeps["store"]> {
    if (!this.deps.store) throw new NotImplementedException("The programme store is not wired on this deployment.");
    return this.deps.store;
  }
}

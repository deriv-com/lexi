import { describe, expect, it } from "vitest";
import type { ProgrammeBuildService } from "./programme-build.service";
import type { HardeningConclusionPort } from "../programme-milestone-review";
import type { ProgrammeToolInvoker } from "../programme-tool-module";
import type { ProgrammeEvidencePort } from "./ports";
import type { ProgrammeSpecReader, ProgrammeStore } from "../programme-store";
import type { PrismaProgrammeSpecReader, PrismaProgrammeStore } from "../prisma/programme-store.prisma";
import type { PrismaRunEvidenceStore } from "../prisma/run-evidence.prisma";

/**
 * The composition root plugs these pieces into each other's ports. A type
 * drift between them would surface only at wiring time in the server, so the
 * fits are asserted here, where the pieces live.
 */
type Fits<A, B> = [A] extends [B] ? true : false;

describe("the programme pieces fit each other's ports", () => {
  it("compiles every fit the composition root relies on", () => {
    const fits: Array<true> = [
      true satisfies Fits<ProgrammeBuildService, HardeningConclusionPort>,
      true satisfies Fits<ProgrammeBuildService, ProgrammeToolInvoker>,
      true satisfies Fits<PrismaProgrammeStore, ProgrammeStore>,
      true satisfies Fits<PrismaProgrammeSpecReader, ProgrammeSpecReader>,
      true satisfies Fits<PrismaRunEvidenceStore, ProgrammeEvidencePort>,
    ];
    expect(fits.every(Boolean)).toBe(true);
  });
});

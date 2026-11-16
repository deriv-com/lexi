import type { BuildTaskBrief } from "@lexi/contracts";

/**
 * Pure brief assembly. The orchestrator's dispatch
 * service gathers the parts (attempt row, spec ref, design-context document,
 * dependency SHAs) and this function composes the wire document the runner
 * fetches from `GET /api/programme/briefs/:attemptId` — deterministic, so a
 * re-fetch mid-run sees byte-identical instructions.
 */

export interface BuildBriefArgs {
  attemptId: string;
  buildTaskId: string;
  programmeKey: string;
  milestone: { id: string; ordinal: number; title: string };
  spec: BuildTaskBrief["spec"];
  acceptanceCriteria: Array<{ id: string; text: string }>;
  programmeCriteria?: BuildTaskBrief["programmeCriteria"];
  designContext?: BuildTaskBrief["designContext"];
  componentCatalogue?: BuildTaskBrief["componentCatalogue"];
  apiContract?: BuildTaskBrief["apiContract"];
  apiReferences?: BuildTaskBrief["apiReferences"];
  parityInventory?: BuildTaskBrief["parityInventory"];
  /** The existing implementation to port from; absent = nothing to reuse. */
  uiSource?: BuildTaskBrief["uiSource"];
  baseBranch?: string;
  technicalSpec?: BuildTaskBrief["technicalSpec"];
  featureSpecs?: BuildTaskBrief["featureSpecs"];
  trackingIssue?: BuildTaskBrief["trackingIssue"];
  priorLearnings?: string;
  buildLogPath?: string;
  model?: string;
  effort?: BuildTaskBrief["effort"];
  attempt: number;
  taskKind: string;
  fileManifestHints?: string[];
  dependencies?: BuildTaskBrief["dependencies"];
  constraints: BuildTaskBrief["constraints"];
  trustedInstruction: string;
  untrustedContext?: string;
}

export class InvalidBuildBriefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBuildBriefError";
  }
}

export function buildTaskBrief(args: BuildBriefArgs): BuildTaskBrief {
  if (!args.attemptId) throw new InvalidBuildBriefError("attemptId is required");
  if (!args.buildTaskId) throw new InvalidBuildBriefError("buildTaskId is required");
  if (!Number.isInteger(args.attempt) || args.attempt < 1) {
    throw new InvalidBuildBriefError("attempt must be a positive integer");
  }
  if (!args.trustedInstruction.trim()) {
    throw new InvalidBuildBriefError("trustedInstruction must not be empty");
  }
  if (args.acceptanceCriteria.length === 0) {
    // A build task with no criteria has nothing the runner can prove red
    // then green, so the evidence loop would be vacuous by construction.
    throw new InvalidBuildBriefError("a build brief needs at least one acceptance criterion");
  }
  // Prompt quarantine as structure: the trusted instruction is
  // template-composed by Lexi, and reporter/issue prose lives only in
  // untrustedContext. A brief where one contains the other has already mixed
  // the channels, so it is refused here rather than trusted downstream.
  if (
    args.untrustedContext &&
    (args.trustedInstruction.includes(args.untrustedContext) ||
      args.untrustedContext.includes(args.trustedInstruction))
  ) {
    throw new InvalidBuildBriefError(
      "trustedInstruction and untrustedContext overlap — the quarantine split has been violated",
    );
  }

  return {
    briefVersion: 1,
    attemptId: args.attemptId,
    buildTaskId: args.buildTaskId,
    programmeKey: args.programmeKey,
    milestone: args.milestone,
    spec: args.spec,
    acceptanceCriteria: args.acceptanceCriteria,
    ...(args.programmeCriteria && args.programmeCriteria.criteria.length > 0
      ? { programmeCriteria: args.programmeCriteria }
      : {}),
    ...(args.designContext ? { designContext: args.designContext } : {}),
    ...(args.componentCatalogue ? { componentCatalogue: args.componentCatalogue } : {}),
    ...(args.apiContract ? { apiContract: args.apiContract } : {}),
    ...(args.apiReferences && args.apiReferences.length > 0 ? { apiReferences: args.apiReferences } : {}),
    ...(args.parityInventory ? { parityInventory: args.parityInventory } : {}),
    ...(args.baseBranch ? { baseBranch: args.baseBranch } : {}),
    ...(args.technicalSpec ? { technicalSpec: args.technicalSpec } : {}),
    ...(args.featureSpecs ? { featureSpecs: args.featureSpecs } : {}),
    ...(args.trackingIssue ? { trackingIssue: args.trackingIssue } : {}),
    ...(args.priorLearnings?.trim() ? { priorLearnings: args.priorLearnings.trim() } : {}),
    ...(args.buildLogPath ? { buildLogPath: args.buildLogPath } : {}),
    ...(args.uiSource ? { uiSource: args.uiSource } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    attempt: args.attempt,
    taskKind: args.taskKind,
    fileManifestHints: args.fileManifestHints ?? [],
    dependencies: args.dependencies ?? [],
    constraints: args.constraints,
    trustedInstruction: args.trustedInstruction,
    ...(args.untrustedContext ? { untrustedContext: args.untrustedContext } : {}),
  };
}

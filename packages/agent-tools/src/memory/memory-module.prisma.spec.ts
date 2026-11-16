import { describe, expect, it, vi } from "vitest";
import { createEngineeringMemoryBundle, type EngineeringMemoryPrisma } from "@lexi/governance";
import {
  createInMemoryMemoryPrisma,
  createPrismaMemoryFacade,
  memoryPolicySchema,
  type GovernanceMemoryPort,
} from "@lexi/memory";
import { createMemoryToolModule, type MemoryToolsPort } from "./memory-module";
import { ctx, text, toolOf } from "../testing/fixtures";

/**
 * The memory tools over the real facade and its database-backed stores, with
 * a fake Prisma client in place of the database. The tool-level specs stub
 * the port; this one proves the production wiring — the factory's output as
 * the tools' port — keeps personal memory with the person who stated it.
 */

const policy = memoryPolicySchema.parse({
  version: "test",
  enabled: true,
  visibility: { orgKinds: ["decision", "fact"], userKinds: ["preference"] },
});

const alice = ctx;
const bob = { ...ctx, actorId: "U0TEST02" };

function wire() {
  const fake = createInMemoryMemoryPrisma();
  // Typed as the port on purpose: this line fails to compile if the factory's
  // return type ever stops satisfying what the tools need.
  const memory: MemoryToolsPort = createPrismaMemoryFacade(fake.client, { policy });
  return { fake, module: createMemoryToolModule({ memory }) };
}

describe("memory tools on the Prisma-backed facade", () => {
  it("offers both forget tools, because the facade implements them", () => {
    const names = wire().module.tools.map((tool) => tool.definition.name);
    expect(names).toEqual(expect.arrayContaining(["forget_about_me", "forget_team_convention"]));
  });

  it("recalls a preference for the person who stated it and for nobody else", async () => {
    const { fake, module } = wire();

    await toolOf(module, "remember_preference").invoke({ preference: "Summaries should lead with the decision" }, alice);
    expect(fake.episodes[0]).toMatchObject({ scope: "user", subjectUserId: alice.actorId, kind: "preference" });

    const recall = toolOf(module, "recall_memory");
    const own = text(await recall.invoke({ query: "summaries decision", scope: "personal" }, alice));
    const other = text(await recall.invoke({ query: "summaries decision", scope: "personal" }, bob));
    const team = text(await recall.invoke({ query: "summaries decision", scope: "team" }, bob));

    expect(own).toContain("Summaries should lead with the decision");
    expect(other).toContain("Nothing personal is recorded");
    expect(team).not.toContain("Summaries should lead with the decision");
  });

  it("shares a team convention with everyone and lets it be withdrawn", async () => {
    const { module } = wire();

    await toolOf(module, "remember_team_convention").invoke({ convention: "Release notes go in #releases", scope_note: "acme/web" }, alice);
    const recalled = text(await toolOf(module, "recall_memory").invoke({ query: "release notes", scope: "team" }, bob));
    expect(recalled).toContain("Release notes go in #releases");

    const removed = text(await toolOf(module, "forget_team_convention").invoke({ contains: "release notes" }, bob));
    expect(removed).toBe("Removed 1 team convention(s) for everyone.");
  });

  it("forget_about_me removes only the caller's own preferences", async () => {
    const { fake, module } = wire();
    await toolOf(module, "remember_preference").invoke({ preference: "Use metric units" }, alice);
    await toolOf(module, "remember_preference").invoke({ preference: "Use metric units too" }, bob);

    const result = text(await toolOf(module, "forget_about_me").invoke({}, bob));

    expect(result).toBe("Removed 1 stated preference(s) for this person.");
    expect(fake.episodes.map((row) => row.subjectUserId)).toEqual([alice.actorId]);
  });

  it("folds the engineering memory bundle into recall through the governance slot", async () => {
    const empty = { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) };
    const governancePrisma = {
      knowledgeNode: empty,
      knowledgeEdge: empty,
      issueMemory: empty,
      feedbackCorrection: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
      userPreference: {
        ...empty,
        findUnique: vi.fn(async () => ({ slackId: alice.actorId, detailLevel: "standard", timezone: "Europe/Lisbon", role: "engineer" })),
      },
    } as unknown as EngineeringMemoryPrisma;

    // Typed as the facade's port: the bundle's retrieval must plug in unadapted.
    const governance: GovernanceMemoryPort = createEngineeringMemoryBundle(governancePrisma, "acme/web").retrieval;
    const memory = createPrismaMemoryFacade(createInMemoryMemoryPrisma().client, { policy, governance });

    const result = text(await toolOf(createMemoryToolModule({ memory }), "recall_memory").invoke({ query: "my settings", scope: "personal" }, alice));
    expect(result).toContain("timezone: Europe/Lisbon");
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadMemoryPolicy } from "../load-memory-policy";
import { memoryPolicySchema } from "../memory-policy.schema";
import { createPrismaMemoryFacade, MEMORY_POLICY_FILE, resolveMemoryPolicy } from "./create-prisma-memory-facade";
import { createInMemoryMemoryPrisma } from "./in-memory-prisma-client";

/**
 * The factory end to end: a facade built on the Prisma stores, over a fake
 * client, so remember → recall goes through every real layer — scope
 * classification, the store adapters and the filters they send — with no
 * database anywhere.
 */

const ALICE = "U0TEST01";
const BOB = "U0TEST02";
const THREAD = "C0TEST01:1700000000.000100";
const BUDGET = { maxTokens: 2000 };

/** The example organisation's policy, as the server would load it. */
function examplePolicy() {
  return loadMemoryPolicy(join(process.env.GOVERNANCE_CONFIG_DIR as string, MEMORY_POLICY_FILE));
}

function build() {
  const fake = createInMemoryMemoryPrisma();
  const memory = createPrismaMemoryFacade(fake.client, { policy: examplePolicy() });
  return { fake, memory };
}

describe("createPrismaMemoryFacade", () => {
  it("round-trips a team convention: remembered by one person, recalled by another", async () => {
    const { fake, memory } = build();

    await memory.remember({
      scope: "org",
      kind: "decision",
      content: "Hotfix branches are named hotfix/<ticket>",
      provenance: { tool: "remember_team_convention", actor: ALICE },
    });

    expect(fake.episodes).toHaveLength(1);
    const pack = await memory.recall({ query: "how are hotfix branches named", threadKey: THREAD, subjectUserId: BOB }, BUDGET);

    expect(pack.episodes.map((episode) => episode.content)).toEqual(["Hotfix branches are named hotfix/<ticket>"]);
    expect(pack.rendered).toContain("hotfix/<ticket>");
  });

  it("keys personal memory to the subject user and shows it to nobody else", async () => {
    const { fake, memory } = build();

    await memory.remember({
      scope: "user",
      subjectUserId: ALICE,
      kind: "preference",
      content: "Alice wants answers as bullet points",
      provenance: { tool: "remember_preference", actor: ALICE },
    });

    expect(fake.episodes[0]).toMatchObject({ scope: "user", subjectUserId: ALICE });

    const own = await memory.recall({ query: "answers bullet points", scope: "user", subjectUserId: ALICE }, BUDGET);
    expect(own.episodes.map((episode) => episode.content)).toEqual(["Alice wants answers as bullet points"]);

    const bobsPersonal = await memory.recall({ query: "answers bullet points", scope: "user", subjectUserId: BOB }, BUDGET);
    const bobsTeam = await memory.recall({ query: "answers bullet points", subjectUserId: BOB }, BUDGET);
    const anonymousTeam = await memory.recall({ query: "answers bullet points" }, BUDGET);

    for (const pack of [bobsPersonal, bobsTeam, anonymousTeam]) {
      expect(pack.episodes).toEqual([]);
      expect(pack.rendered).not.toContain("bullet points");
    }
  });

  it("stores a preference at user scope even when the caller asked for org", async () => {
    const { fake, memory } = build();

    await memory.remember({ scope: "org", subjectUserId: ALICE, kind: "preference", content: "Alice prefers UTC timestamps" });

    expect(fake.episodes[0]).toMatchObject({ scope: "user", subjectUserId: ALICE });
    const team = await memory.recall({ query: "UTC timestamps" }, BUDGET);
    expect(team.episodes).toEqual([]);
  });

  it("refuses a personal memory with no owner rather than storing it unowned", async () => {
    const { fake, memory } = build();
    await expect(memory.remember({ scope: "user", kind: "preference", content: "orphaned" })).rejects.toThrow(/subjectUserId/);
    expect(fake.episodes).toHaveLength(0);
  });

  it("forgets only the caller's own preferences", async () => {
    const { fake, memory } = build();
    await memory.remember({ scope: "user", subjectUserId: ALICE, kind: "preference", content: "Alice: short replies" });
    await memory.remember({ scope: "user", subjectUserId: BOB, kind: "preference", content: "Bob: short replies" });

    expect(await memory.forgetOwnPreferences(BOB, "short")).toBe(1);

    expect(fake.episodes.map((row) => row.subjectUserId)).toEqual([ALICE]);
    const alice = await memory.recall({ query: "short replies", scope: "user", subjectUserId: ALICE }, BUDGET);
    expect(alice.episodes).toHaveLength(1);
  });

  it("forgets team conventions without touching derived decisions or anyone's preferences", async () => {
    const { fake, memory } = build();
    await memory.remember({
      scope: "org",
      kind: "decision",
      content: "Deploys freeze on Fridays",
      provenance: { tool: "remember_team_convention", actor: ALICE },
    });
    await memory.remember({ scope: "org", kind: "decision", content: "Deploys freeze approved for the holiday", provenance: { tool: "approve_change" } });
    await memory.remember({ scope: "user", subjectUserId: BOB, kind: "preference", content: "Bob: remind me about deploys freeze" });

    expect(await memory.forgetTeamConventions("freeze")).toBe(1);
    expect(fake.episodes.map((row) => row.content).sort()).toEqual([
      "Bob: remind me about deploys freeze",
      "Deploys freeze approved for the holiday",
    ]);
  });

  it("persists working memory through the thread-state store", async () => {
    const { fake, memory } = build();

    const write = await memory.recordTurnState(THREAD, {
      turnId: "turn-1",
      actorUserId: ALICE,
      summary: "asked: what is blocking acme/web — did: listed two open reviews",
      openQuestions: ["who owns the flaky test?"],
    });

    expect(write).toMatchObject({ persisted: true, concurrencySafe: true });
    expect(fake.threads.has(THREAD)).toBe(true);

    const pack = await memory.recall({ query: "blocking", threadKey: THREAD }, BUDGET);
    expect(pack.digests.map((digest) => digest.turnId)).toEqual(["turn-1"]);
    expect(pack.rendered).toContain("who owns the flaky test?");
  });

  it("does nothing while the policy switches memory off", async () => {
    const fake = createInMemoryMemoryPrisma();
    const memory = createPrismaMemoryFacade(fake.client, { policy: memoryPolicySchema.parse({ version: "off" }) });

    await memory.remember({ scope: "org", kind: "fact", content: "never stored" });
    const pack = await memory.recall({ query: "stored" }, BUDGET);

    expect(fake.calls).toHaveLength(0);
    expect(pack.rendered).toBe("");
  });

  it("loads memory-policy.yaml from the configured directory and says whether memory is on", () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    const memory = createPrismaMemoryFacade(createInMemoryMemoryPrisma().client, {
      configDir: process.env.GOVERNANCE_CONFIG_DIR,
      logger,
    });

    expect(memory).toBeDefined();
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/^Memory enabled \(policy 1\.0\.0/), "MemoryFacade");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("resolveMemoryPolicy", () => {
  it("falls back to the switched-off defaults when no policy file exists", () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    const policy = resolveMemoryPolicy(mkdtempSync(join(tmpdir(), "memory-policy-")), logger);

    expect(policy.enabled).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("memory stays switched off"), "MemoryFacade");
  });

  it("throws on an invalid policy file instead of running with different budgets", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-policy-"));
    writeFileSync(join(dir, MEMORY_POLICY_FILE), 'version: "1"\nenabled: true\nbudgets:\n  maxMemoryToken: 10\n');

    expect(() => resolveMemoryPolicy(dir)).toThrow(/Invalid memory policy/);
  });

  it("reads GOVERNANCE_CONFIG_DIR when no directory is given", () => {
    expect(resolveMemoryPolicy().version).toBe(examplePolicy().version);
  });
});

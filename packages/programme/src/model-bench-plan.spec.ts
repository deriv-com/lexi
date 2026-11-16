import { describe, expect, it } from "vitest";
import { benchArmOf, benchModelSlug, isBenchTask, planModelBench, withoutBenchTasks } from "./model-bench-plan";

const SOURCE = {
  id: "web:m1:screen-auth-login",
  programmeId: "prog-1",
  milestoneId: "web:m1",
  title: "(auth)/login",
  dependsOn: ["web:shared:scaffold", "web:shared:data-layer"],
  codeRepoKey: "acme_web",
  acceptanceCriterionIds: ["AC-1", "AC-2"],
  designContextNodeIds: ["1:2"],
  metadata: { kind: "screen", screenStates: ["(auth)/login"], dispatchedAt: "2026-09-20T00:00:00Z", headSha: "abc" },
};
const NOW = new Date("2026-09-24T09:00:00Z");

describe("planModelBench", () => {
  it("copies the source once per model, pinned, with its own history cleared", () => {
    const plan = planModelBench({ source: SOURCE, models: ["gpt-6-luna", "claude-opus-5-5"], runId: "2609240900", startedBy: "U1", now: NOW });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.arms.map((arm) => arm.id)).toEqual([
      "web:m1:screen-auth-login:bench-2609240900-gpt-6-luna",
      "web:m1:screen-auth-login:bench-2609240900-claude-opus-5-5",
    ]);
    const arm = plan.arms[0]!;
    expect(arm).toMatchObject({
      status: "PENDING",
      attempts: 0,
      dependsOn: SOURCE.dependsOn,
      acceptanceCriterionIds: SOURCE.acceptanceCriterionIds,
      title: "[bench gpt-6-luna] (auth)/login",
    });
    expect(arm.metadata).toMatchObject({ kind: "screen", screenStates: ["(auth)/login"] });
    expect(arm.metadata).not.toHaveProperty("dispatchedAt");
    expect(arm.metadata).not.toHaveProperty("headSha");
    expect(benchArmOf(arm)).toMatchObject({ model: "gpt-6-luna", runId: "2609240900", sourceTaskId: SOURCE.id });
  });

  it("de-duplicates models and refuses two that share a branch slug", () => {
    const dup = planModelBench({ source: SOURCE, models: ["kimi-k3", " kimi-k3 "], runId: "r1", startedBy: "U1", now: NOW });
    expect(dup.ok && dup.arms.length).toBe(1);
    const clash = planModelBench({ source: SOURCE, models: ["glm-5.3", "glm_5_3"], runId: "r1", startedBy: "U1", now: NOW });
    expect(clash).toMatchObject({ ok: false });
  });

  it("refuses non-screen tasks, bench arms, empty and oversized model lists", () => {
    const base = { runId: "r1", startedBy: "U1", now: NOW };
    expect(planModelBench({ ...base, source: { ...SOURCE, metadata: { kind: "scaffold" } }, models: ["a"] }).ok).toBe(false);
    const arm = planModelBench({ ...base, source: SOURCE, models: ["a"] });
    expect(arm.ok).toBe(true);
    if (arm.ok) expect(planModelBench({ ...base, source: arm.arms[0]!, models: ["b"] }).ok).toBe(false);
    expect(planModelBench({ ...base, source: SOURCE, models: [] }).ok).toBe(false);
    expect(planModelBench({ ...base, source: SOURCE, models: Array.from({ length: 13 }, (_, i) => `m${i}`) }).ok).toBe(false);
  });

  it("stamps a run's effort on every arm and refuses one the CLI does not have", () => {
    const plan = planModelBench({ source: SOURCE, models: ["claude-sonnet-5-5"], runId: "r1", startedBy: "U1", now: NOW, effort: "high" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.arms[0]!.title).toBe("[bench claude-sonnet-5-5 @ high] (auth)/login");
    expect(benchArmOf(plan.arms[0]!)).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
    const bad = planModelBench({ source: SOURCE, models: ["a"], runId: "r1", startedBy: "U1", now: NOW, effort: "--turbo" });
    expect(bad).toMatchObject({ ok: false });
    const none = planModelBench({ source: SOURCE, models: ["a"], runId: "r1", startedBy: "U1", now: NOW });
    expect(none.ok && benchArmOf(none.arms[0]!)).not.toHaveProperty("effort");
  });

  it("drops an effort on a stored row that is not a CLI level, rather than trusting it", () => {
    const arm = { id: "x", metadata: { bench: { runId: "r1", model: "m", sourceTaskId: "s", startedBy: "U1", startedAt: "t", effort: "high; rm" } } };
    expect(benchArmOf(arm)).not.toHaveProperty("effort");
    expect(benchArmOf(arm)).toMatchObject({ model: "m" });
  });

  it("pins a run's base on every arm and drops a stored base that is not a ref name", () => {
    const plan = planModelBench({ source: SOURCE, models: ["a"], runId: "r1", startedBy: "U1", now: NOW, baseRef: "bench/login-base" });
    expect(plan.ok && benchArmOf(plan.arms[0]!)).toMatchObject({ baseRef: "bench/login-base" });
    expect(planModelBench({ source: SOURCE, models: ["a"], runId: "r1", startedBy: "U1", now: NOW, baseRef: "a b" }).ok).toBe(false);
    const stored = { id: "x", metadata: { bench: { runId: "r1", model: "m", sourceTaskId: "s", startedBy: "U1", startedAt: "t", baseRef: "-x;rm" } } };
    expect(benchArmOf(stored)).not.toHaveProperty("baseRef");
  });

  it("slugs model names into branch-safe segments", () => {
    expect(benchModelSlug("deepseek-v4.1-flash")).toBe("deepseek-v4-1-flash");
    expect(benchModelSlug("Gemini 3.8 Flash")).toBe("gemini-3-8-flash");
  });

  it("isBenchTask / withoutBenchTasks separate arms from the programme's own tasks", () => {
    const plan = planModelBench({ source: SOURCE, models: ["a"], runId: "r1", startedBy: "U1", now: NOW });
    const arms = plan.ok ? plan.arms : [];
    expect(isBenchTask(SOURCE)).toBe(false);
    expect(isBenchTask(arms[0]!)).toBe(true);
    expect(withoutBenchTasks([SOURCE, ...arms])).toEqual([SOURCE]);
  });
});

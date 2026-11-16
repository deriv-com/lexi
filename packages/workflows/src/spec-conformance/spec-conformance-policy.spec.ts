import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildJudgeInput,
  hashSpecBody,
  isSpecConformanceEnabled,
  normaliseJudgement,
  rollUpVerdict,
} from "./spec-conformance-policy";
import type { ConformancePoint } from "./spec-conformance.types";

const satisfied = (requirement: string): ConformancePoint => ({
  requirement,
  status: "satisfied",
});
const diverged = (requirement: string): ConformancePoint => ({
  requirement,
  status: "diverged",
  evidence: ["PR#1"],
});
const extra = (requirement: string): ConformancePoint => ({
  requirement,
  status: "extra",
  evidence: ["PR#1"],
});
const missing = (requirement: string): ConformancePoint => ({
  requirement,
  status: "missing",
  evidence: ["not in changed files / tests"],
});
const indeterminate = (requirement: string): ConformancePoint => ({
  requirement,
  status: "indeterminate",
});

// ---------------------------------------------------------------------------
// Feature flag — config AND env, either half kills it
// ---------------------------------------------------------------------------

describe("isSpecConformanceEnabled", () => {
  it("is on only when the policy file and the env flag agree", () => {
    expect(isSpecConformanceEnabled({ policyEnabled: true, envEnabled: true })).toBe(true);
  });

  it("is off when the env flag alone is false", () => {
    expect(isSpecConformanceEnabled({ policyEnabled: true, envEnabled: false })).toBe(false);
  });

  it("is off when the policy file alone is false", () => {
    expect(isSpecConformanceEnabled({ policyEnabled: false, envEnabled: true })).toBe(false);
  });

  it("is off when both are false", () => {
    expect(isSpecConformanceEnabled({ policyEnabled: false, envEnabled: false })).toBe(false);
  });
});

describe("spec conformance flag wiring", () => {
  const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

  it("declares the config half in feature-policy.yaml", () => {
    // Asserts the key EXISTS and is a boolean, not which way it currently
    // points. This originally required `false`, which made enabling the feature
    // — the thing the flag is for — look like a regression. A test that encodes
    // the deployment's posture as a precondition stops testing anything the
    // moment the deployment legitimately moves; the same correction was already
    // made to other posture-dependent fixtures for the same reason.
    const configDir = process.env.GOVERNANCE_CONFIG_DIR ?? join(REPO_ROOT, "examples", "config");
    const yaml = readFileSync(join(configDir, "feature-policy.yaml"), "utf8");
    expect(yaml).toMatch(/^\s*specConformanceEnabled:\s*(?:true|false)\s*$/m);
  });

  it("declares the env half in env.schema.ts, defaulting off", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "packages", "config", "src", "env.schema.ts"),
      "utf8",
    );
    expect(schema).toMatch(/SPEC_CONFORMANCE_ENABLED:[\s\S]{0,120}?\.default\("false"\)/);
  });
});

// ---------------------------------------------------------------------------
// Hashing — what makes a post-approval redraft detectable
// ---------------------------------------------------------------------------

describe("hashSpecBody", () => {
  it("is sha256-hex of the normalised body", () => {
    // Already normalised (no trailing whitespace), so the raw digest is the
    // digest. The normalisation itself is pinned by the two cases below.
    const body = "## Problem\nUsers cannot withdraw.";
    expect(hashSpecBody(body)).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
  });

  it("is stable across calls", () => {
    expect(hashSpecBody("same")).toBe(hashSpecBody("same"));
  });

  it("changes when a single character of the body changes", () => {
    expect(hashSpecBody("three steps")).not.toBe(hashSpecBody("two steps"));
  });

  it("ignores trailing-whitespace-only differences (line endings, final newline)", () => {
    // A redraft is a change of MEANING. Re-saving a file with CRLF endings is
    // not one, and flagging it would train readers to ignore the signal that
    // exists to catch real redrafts.
    expect(hashSpecBody("a\r\nb\n")).toBe(hashSpecBody("a\nb"));
  });

  it("does NOT ignore an interior change disguised by whitespace", () => {
    expect(hashSpecBody("step one\nstep two\nstep three")).not.toBe(
      hashSpecBody("step one\nstep two"),
    );
  });
});

// ---------------------------------------------------------------------------
// Judge input — the isolation allowlist, enforced by projection
// ---------------------------------------------------------------------------

describe("buildJudgeInput", () => {
  it("carries only the approved spec body and the projected artefact", () => {
    const input = buildJudgeInput("SPEC BODY", {
      pullRequests: ["#12"],
      changedFiles: ["src/a.ts"],
      diffSummary: "+1 -0",
      testNames: ["covers a"],
    });

    expect(Object.keys(input).sort()).toEqual(["approvedSpecBody", "artefact"]);
    expect(Object.keys(input.artefact).sort()).toEqual([
      "changedFiles",
      "diffSummary",
      "pullRequests",
      "testNames",
    ]);
  });

  it("drops any extra field smuggled onto the artefact", () => {
    // The realistic leak: a caller passes the object it already had, which
    // happens to carry the builder's session. Projection, not spread, is what
    // stops that — and it must hold for fields this build has never seen.
    const contaminated = {
      pullRequests: ["#12"],
      changedFiles: ["src/a.ts"],
      diffSummary: "+1 -0",
      builderSessionId: "sess_123",
      recalledMemory: ["the builder assumed two steps"],
      dispatchConversation: [{ role: "user", content: "just do the two-step flow" }],
    } as never;

    const input = buildJudgeInput("SPEC BODY", contaminated);
    const serialised = JSON.stringify(input);

    expect(serialised).not.toContain("builderSessionId");
    expect(serialised).not.toContain("sess_123");
    expect(serialised).not.toContain("recalledMemory");
    expect(serialised).not.toContain("the builder assumed two steps");
    expect(serialised).not.toContain("dispatchConversation");
    expect(serialised).not.toContain("just do the two-step flow");
  });

  it("returns a frozen input so a caller cannot append context after construction", () => {
    const input = buildJudgeInput("SPEC BODY", {
      pullRequests: [],
      changedFiles: [],
      diffSummary: "",
    });

    expect(Object.isFrozen(input)).toBe(true);
    expect(() => {
      (input as unknown as Record<string, unknown>).builderSession = "sess_9";
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Normalisation — model proposes, deterministic policy disposes
// ---------------------------------------------------------------------------

describe("normaliseJudgement", () => {
  it("keeps well-formed points", () => {
    const points = normaliseJudgement({
      points: [
        { requirement: "Three-step flow", status: "satisfied" },
        { requirement: "Confirm screen", status: "diverged", evidence: ["PR#3"] },
        { requirement: "Offline cache", status: "extra", evidence: ["src/cache.ts"] },
        {
          requirement: "Receipt shows the reference id",
          status: "missing",
          evidence: ["not in changed files / tests"],
        },
      ],
    });

    expect(points).toHaveLength(4);
    expect(points[0].status).toBe("satisfied");
    expect(points[1].status).toBe("diverged");
    expect(points[2].status).toBe("extra");
    expect(points[3].status).toBe("missing");
  });

  it("maps an unrecognised status to indeterminate rather than dropping the point", () => {
    const points = normaliseJudgement({
      points: [{ requirement: "Three-step flow", status: "probably fine" }],
    });

    expect(points).toHaveLength(1);
    expect(points[0].status).toBe("indeterminate");
  });

  it("maps a missing status to indeterminate", () => {
    const points = normaliseJudgement({ points: [{ requirement: "Three-step flow" }] });
    expect(points[0].status).toBe("indeterminate");
  });

  it("downgrades a diverged point with no evidence to indeterminate", () => {
    // The contract says evidence is never empty for `diverged`. An unevidenced
    // drift claim is an assertion the report cannot support, so policy refuses
    // to promote it — and refuses downward, never to `satisfied`.
    const points = normaliseJudgement({
      points: [{ requirement: "Confirm screen", status: "diverged", evidence: [] }],
    });

    expect(points[0].status).toBe("indeterminate");
  });

  it("downgrades an unevidenced extra point to indeterminate", () => {
    const points = normaliseJudgement({
      points: [{ requirement: "Offline cache of last receipt", status: "extra", evidence: [] }],
    });
    expect(points[0].status).toBe("indeterminate");
  });

  it("downgrades an unevidenced missing point to indeterminate", () => {
    const points = normaliseJudgement({
      points: [{ requirement: "Receipt shows the reference id", status: "missing" }],
    });
    expect(points[0].status).toBe("indeterminate");
  });

  it("keeps extra and missing when they carry evidence", () => {
    const points = normaliseJudgement({
      points: [
        { requirement: "Offline cache", status: "extra", evidence: ["src/cache.ts"] },
        {
          requirement: "Confirm screen",
          status: "missing",
          evidence: ["not in changed files / tests"],
        },
      ],
    });
    expect(points.map((p) => p.status)).toEqual(["extra", "missing"]);
  });

  it("drops a point with no requirement text", () => {
    const points = normaliseJudgement({ points: [{ status: "satisfied" }] });
    expect(points).toEqual([]);
  });

  it("returns no points for null, undefined, or a missing points array", () => {
    expect(normaliseJudgement(null)).toEqual([]);
    expect(normaliseJudgement(undefined)).toEqual([]);
    expect(normaliseJudgement({})).toEqual([]);
  });

  it("returns no points when the model returns a non-array in points", () => {
    expect(normaliseJudgement({ points: "all good" } as never)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Roll-up — pure, and it fails toward indeterminate
// ---------------------------------------------------------------------------

describe("rollUpVerdict", () => {
  const base = { hasProvenance: true, specUnchangedSinceApproval: true };

  it("is unverifiable when there is no provenance, whatever the points say", () => {
    // The load-bearing case. A work item with no linked approved spec must not
    // roll up to a pass — that would turn an audit hole into a green tick.
    expect(
      rollUpVerdict({
        hasProvenance: false,
        specUnchangedSinceApproval: true,
        points: [satisfied("a"), satisfied("b")],
      }),
    ).toBe("unverifiable");
  });

  it("is unverifiable without provenance even when points are empty", () => {
    expect(
      rollUpVerdict({ hasProvenance: false, specUnchangedSinceApproval: true, points: [] }),
    ).toBe("unverifiable");
  });

  it("conforms when every point is satisfied", () => {
    expect(rollUpVerdict({ ...base, points: [satisfied("a"), satisfied("b")] })).toBe("conforms");
  });

  it("drifts when any point diverged", () => {
    expect(rollUpVerdict({ ...base, points: [satisfied("a"), diverged("b")] })).toBe("drifted");
  });

  it("drifts when any point is extra (behaviour with no requirement)", () => {
    expect(rollUpVerdict({ ...base, points: [satisfied("a"), extra("b")] })).toBe("drifted");
  });

  it("drifts when any point is missing (required, not in the artefact)", () => {
    expect(rollUpVerdict({ ...base, points: [satisfied("a"), missing("b")] })).toBe("drifted");
  });

  it("prefers drifted over indeterminate when both are present", () => {
    expect(
      rollUpVerdict({ ...base, points: [diverged("a"), indeterminate("b"), satisfied("c")] }),
    ).toBe("drifted");
  });

  it("prefers drifted when extra or missing sit beside indeterminate points", () => {
    expect(rollUpVerdict({ ...base, points: [extra("a"), indeterminate("b")] })).toBe("drifted");
    expect(rollUpVerdict({ ...base, points: [missing("a"), indeterminate("b")] })).toBe("drifted");
  });

  it("is indeterminate when a point is indeterminate and none diverged", () => {
    expect(rollUpVerdict({ ...base, points: [satisfied("a"), indeterminate("b")] })).toBe(
      "indeterminate",
    );
  });

  it("is indeterminate when there are no points at all", () => {
    // Nothing compared is not the same as nothing wrong.
    expect(rollUpVerdict({ ...base, points: [] })).toBe("indeterminate");
  });

  it("degrades conforms to indeterminate when the spec moved after approval", () => {
    // The comparison was against the approved text, but the spec no longer
    // says that. Reporting a clean pass would assert conformance to a document
    // that no longer exists.
    expect(
      rollUpVerdict({
        hasProvenance: true,
        specUnchangedSinceApproval: false,
        points: [satisfied("a")],
      }),
    ).toBe("indeterminate");
  });

  it("keeps drifted when the spec moved after approval", () => {
    // Drift found against the approved text is still drift; a redraft does not
    // absolve it.
    expect(
      rollUpVerdict({
        hasProvenance: true,
        specUnchangedSinceApproval: false,
        points: [diverged("a")],
      }),
    ).toBe("drifted");
  });

  it("keeps drifted for extra and missing when the spec moved after approval", () => {
    expect(
      rollUpVerdict({
        hasProvenance: true,
        specUnchangedSinceApproval: false,
        points: [extra("a")],
      }),
    ).toBe("drifted");
    expect(
      rollUpVerdict({
        hasProvenance: true,
        specUnchangedSinceApproval: false,
        points: [missing("a")],
      }),
    ).toBe("drifted");
  });

  it("is pure — the same input yields the same verdict and mutates nothing", () => {
    const points = [satisfied("a"), diverged("b")];
    const snapshot = JSON.stringify(points);

    expect(rollUpVerdict({ ...base, points })).toBe(rollUpVerdict({ ...base, points }));
    expect(JSON.stringify(points)).toBe(snapshot);
  });

  it("never returns conforms for any input that is not all-satisfied-with-provenance", () => {
    const cases = [
      { hasProvenance: false, specUnchangedSinceApproval: true, points: [satisfied("a")] },
      { hasProvenance: true, specUnchangedSinceApproval: false, points: [satisfied("a")] },
      { hasProvenance: true, specUnchangedSinceApproval: true, points: [] },
      { hasProvenance: true, specUnchangedSinceApproval: true, points: [indeterminate("a")] },
      { hasProvenance: true, specUnchangedSinceApproval: true, points: [diverged("a")] },
      { hasProvenance: true, specUnchangedSinceApproval: true, points: [extra("a")] },
      { hasProvenance: true, specUnchangedSinceApproval: true, points: [missing("a")] },
    ];

    for (const input of cases) {
      expect(rollUpVerdict(input)).not.toBe("conforms");
    }
  });
});

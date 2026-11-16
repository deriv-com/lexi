import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";

import { SpecConformanceService } from "./spec-conformance.service";
import { renderConformanceReport, resolveConformanceDestination } from "./spec-conformance-report";
import type {
  BuiltArtefact,
  RawConformanceJudgement,
  SpecConformanceJudge,
  SpecProvenance,
} from "./spec-conformance.types";

const GOVERNANCE_CHANNEL = "C0TEST01"; // config/escalation-policy.yaml governance.channelId

const APPROVED_BODY = [
  "## Scope",
  "Withdrawal must be a three-step flow: amount, confirm, receipt.",
  "## Acceptance criteria",
  "A confirm screen appears before submission.",
].join("\n");

const sha = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

const PROVENANCE: SpecProvenance = {
  specId: "spec_9001",
  revision: 3,
  contentHash: sha(APPROVED_BODY),
  approvedAt: "2026-08-15T09:00:00.000Z",
  approvedBy: "U0TEST01",
};

const ARTEFACT: BuiltArtefact = {
  pullRequests: ["acme/app#412"],
  changedFiles: ["src/withdrawal/amount.tsx", "src/withdrawal/receipt.tsx"],
  diffSummary: "two-step withdrawal: amount then receipt",
  testNames: ["amount screen renders", "receipt screen renders"],
};

function judgeReturning(raw: RawConformanceJudgement): SpecConformanceJudge & { calls: number } {
  const judge = {
    calls: 0,
    async compare() {
      judge.calls += 1;
      return raw;
    },
  };
  return judge;
}

function makeService(overrides: {
  provenance?: SpecProvenance | null;
  body?: string | null;
  judge?: SpecConformanceJudge;
  enabled?: boolean;
  revisionSeen?: (specId: string, revision: number) => void;
} = {}) {
  const judge =
    overrides.judge ??
    judgeReturning({
      points: [
        { requirement: "Three-step flow", status: "satisfied" },
        { requirement: "Confirm screen before submission", status: "satisfied" },
      ],
    });

  return new SpecConformanceService({
    provenance: {
      async loadSpecProvenance() {
        return overrides.provenance === undefined ? PROVENANCE : overrides.provenance;
      },
    },
    specRevisions: {
      async loadApprovedSpecBody(specId, revision) {
        overrides.revisionSeen?.(specId, revision);
        return overrides.body === undefined ? APPROVED_BODY : overrides.body;
      },
    },
    judge,
    options: {
      enabled: overrides.enabled ?? true,
      governanceChannelId: GOVERNANCE_CHANNEL,
    },
  });
}

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

describe("SpecConformanceService — flag", () => {
  it("is a no-op returning null while disabled", async () => {
    const judge = judgeReturning({ points: [] });
    const service = makeService({ enabled: false, judge });

    expect(await service.verify("wi_1", ARTEFACT)).toBeNull();
    expect(judge.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Missing provenance — the audit hole must never read as a pass
// ---------------------------------------------------------------------------

describe("SpecConformanceService — missing provenance", () => {
  it("reports unverifiable, never conforms", async () => {
    const report = await makeService({ provenance: null }).verify("wi_1", ARTEFACT);

    expect(report).not.toBeNull();
    expect(report!.verdict).toBe("unverifiable");
    expect(report!.source).toBe("unverifiable");
    expect(report!.provenance).toBeUndefined();
  });

  it("does NOT spend a model call to conclude there was nothing to compare against", async () => {
    // Day one, nearly every work item lands here: provenance is only written
    // for dispatches after the write half ships. Paying for a judgement per
    // item to learn "no spec was linked" is spend with no possible finding.
    const judge = judgeReturning({ points: [] });
    await makeService({ provenance: null, judge }).verify("wi_1", ARTEFACT);

    expect(judge.calls).toBe(0);
  });

  it("does not even attempt to load a spec body", async () => {
    const revisionSeen = vi.fn();
    await makeService({ provenance: null, revisionSeen }).verify("wi_1", ARTEFACT);

    expect(revisionSeen).not.toHaveBeenCalled();
  });

  it("carries no points, so nothing reads as a checked-and-passed requirement", async () => {
    const report = await makeService({ provenance: null }).verify("wi_1", ARTEFACT);
    expect(report!.points).toEqual([]);
  });

  it("says the spec is unlinked rather than unchanged", async () => {
    const report = await makeService({ provenance: null }).verify("wi_1", ARTEFACT);
    expect(report!.specUnchangedSinceApproval).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The approved revision, not the current one
// ---------------------------------------------------------------------------

describe("SpecConformanceService — approved revision", () => {
  it("loads the spec at the revision named in provenance", async () => {
    const revisionSeen = vi.fn();
    await makeService({ revisionSeen }).verify("wi_1", ARTEFACT);

    expect(revisionSeen).toHaveBeenCalledWith("spec_9001", 3);
  });

  it("hands the judge the approved body", async () => {
    let seen = "";
    const judge: SpecConformanceJudge = {
      async compare(input) {
        seen = input.approvedSpecBody;
        return { points: [{ requirement: "Three-step flow", status: "satisfied" }] };
      },
    };

    await makeService({ judge }).verify("wi_1", ARTEFACT);
    expect(seen).toBe(APPROVED_BODY);
  });
});

// ---------------------------------------------------------------------------
// The spec has not moved
// ---------------------------------------------------------------------------

describe("SpecConformanceService — contentHash", () => {
  it("sets specUnchangedSinceApproval true when the body still hashes to provenance", async () => {
    const report = await makeService().verify("wi_1", ARTEFACT);
    expect(report!.specUnchangedSinceApproval).toBe(true);
    expect(report!.verdict).toBe("conforms");
  });

  it("sets it false when the spec was redrafted after it authorised the work", async () => {
    const report = await makeService({ body: `${APPROVED_BODY}\nNow a two-step flow.` }).verify(
      "wi_1",
      ARTEFACT,
    );

    expect(report!.specUnchangedSinceApproval).toBe(false);
  });

  it("reports the redraft as a finding in its own right", async () => {
    const report = await makeService({ body: `${APPROVED_BODY}\nNow a two-step flow.` }).verify(
      "wi_1",
      ARTEFACT,
    );

    const redraft = report!.points.find((p) => /redraft|changed since approval/i.test(p.requirement));
    expect(redraft, "a redraft must appear as a reported point").toBeDefined();
    expect(redraft!.status).toBe("indeterminate");
  });

  it("does not report a clean pass when the spec moved", async () => {
    const report = await makeService({ body: `${APPROVED_BODY}\nNow a two-step flow.` }).verify(
      "wi_1",
      ARTEFACT,
    );

    expect(report!.verdict).not.toBe("conforms");
  });

  it("is indeterminate, not unverifiable, when the approved body cannot be loaded", async () => {
    // Provenance exists — the audit trail is intact. It is the comparison that
    // failed, and those are different findings for whoever reads the report.
    const report = await makeService({ body: null }).verify("wi_1", ARTEFACT);

    expect(report!.verdict).toBe("indeterminate");
    expect(report!.source).toBe("spec_provenance");
    expect(report!.provenance).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

describe("SpecConformanceService — drift", () => {
  it("reports drifted when the build diverges from the approved spec", async () => {
    const judge = judgeReturning({
      points: [
        {
          requirement: "Withdrawal must be a three-step flow",
          status: "diverged",
          observed: "two screens only: amount, receipt",
          evidence: ["acme/app#412"],
        },
      ],
    });

    const report = await makeService({ judge }).verify("wi_1", ARTEFACT);
    expect(report!.verdict).toBe("drifted");
    expect(report!.points[0].evidence).toContain("acme/app#412");
  });

  it("reports drifted when the artefact has extra behaviour no requirement asks for", async () => {
    const judge = judgeReturning({
      points: [
        {
          requirement: "Offline cache of the last receipt",
          status: "extra",
          observed: "src/cache.ts stores the last receipt locally",
          evidence: ["src/cache.ts"],
        },
      ],
    });

    const report = await makeService({ judge }).verify("wi_1", ARTEFACT);
    expect(report!.verdict).toBe("drifted");
    expect(report!.points[0].status).toBe("extra");
  });

  it("reports drifted when a required behaviour is missing from the artefact", async () => {
    const judge = judgeReturning({
      points: [
        {
          requirement: "A confirm screen appears before submission",
          status: "missing",
          evidence: ["not in changed files / tests"],
        },
      ],
    });

    const report = await makeService({ judge }).verify("wi_1", ARTEFACT);
    expect(report!.verdict).toBe("drifted");
    expect(report!.points[0].status).toBe("missing");
  });

  it("is indeterminate when the judge output cannot be parsed", async () => {
    const judge: SpecConformanceJudge = {
      async compare() {
        return { points: "the flow looks right to me" } as never;
      },
    };

    const report = await makeService({ judge }).verify("wi_1", ARTEFACT);
    expect(report!.verdict).toBe("indeterminate");
  });

  it("is indeterminate — not a pass — when the judge throws", async () => {
    const judge: SpecConformanceJudge = {
      async compare() {
        throw new Error("gateway 400");
      },
    };

    const report = await makeService({ judge }).verify("wi_1", ARTEFACT);
    expect(report!.verdict).toBe("indeterminate");
  });

  it("does not throw out of verify() when a port fails", async () => {
    const service = new SpecConformanceService({
      provenance: {
        async loadSpecProvenance() {
          throw new Error("db down");
        },
      },
      specRevisions: { async loadApprovedSpecBody() { return APPROVED_BODY; } },
      judge: judgeReturning({ points: [] }),
      options: { enabled: true, governanceChannelId: GOVERNANCE_CHANNEL },
    });

    const report = await service.verify("wi_1", ARTEFACT);
    expect(report!.verdict).toBe("indeterminate");
  });
});

// ---------------------------------------------------------------------------
// Reports, never blocks
// ---------------------------------------------------------------------------

describe("SpecConformanceService — reports, never blocks", () => {
  it("returns only a report — no allow/block/gate field on the result", async () => {
    const judge = judgeReturning({
      points: [
        {
          requirement: "Three-step flow",
          status: "diverged",
          evidence: ["acme/app#412"],
        },
      ],
    });

    const report = await makeService({ judge }).verify("wi_1", ARTEFACT);
    const keys = Object.keys(report!);

    expect(keys.sort()).toEqual(
      [
        "points",
        "provenance",
        "source",
        "specUnchangedSinceApproval",
        "summary",
        "verdict",
        "workItemId",
      ].sort(),
    );
    for (const forbidden of ["allowed", "blocked", "blocking", "gate", "fail", "merge"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("exposes no method other than verify()", async () => {
    const methods = Object.getOwnPropertyNames(SpecConformanceService.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods).toEqual(["verify"]);
  });

  it("drift and conformance take the same code path — only the report differs", async () => {
    const drifting = judgeReturning({
      points: [{ requirement: "r", status: "diverged", evidence: ["PR#1"] }],
    });
    const conforming = judgeReturning({ points: [{ requirement: "r", status: "satisfied" }] });

    const drifted = await makeService({ judge: drifting }).verify("wi_1", ARTEFACT);
    const conforms = await makeService({ judge: conforming }).verify("wi_1", ARTEFACT);

    expect(drifted!.verdict).toBe("drifted");
    expect(conforms!.verdict).toBe("conforms");
    expect(Object.keys(drifted!).sort()).toEqual(Object.keys(conforms!).sort());
  });
});

// ---------------------------------------------------------------------------
// Destination — governance output, never a team channel
// ---------------------------------------------------------------------------

describe("resolveConformanceDestination", () => {
  it("defaults to the governance channel from config", () => {
    const destination = resolveConformanceDestination({
      governanceChannelId: GOVERNANCE_CHANNEL,
    });

    expect(destination.kind).toBe("governance_channel");
    expect(destination.channelId).toBe(GOVERNANCE_CHANNEL);
  });

  it("prefers the spec thread when the work has one", () => {
    const destination = resolveConformanceDestination({
      governanceChannelId: GOVERNANCE_CHANNEL,
      specThreadTs: "1755300000.000100",
    });

    expect(destination.kind).toBe("spec_thread");
    expect(destination.threadTs).toBe("1755300000.000100");
  });

  it("never resolves to a platform team channel", () => {
    // The progress check had exactly this shape and would have pinged named
    // people across two team channels on its first sweep. Drift reports are
    // governance output; the blast radius is constrained by construction.
    for (const specThreadTs of [undefined, "1755300000.000100"]) {
      const destination = resolveConformanceDestination({
        governanceChannelId: GOVERNANCE_CHANNEL,
        specThreadTs,
      });
      expect(["spec_thread", "governance_channel"]).toContain(destination.kind);
    }
  });
});

// ---------------------------------------------------------------------------
// Rendering — unverifiable must not read like drift, and nobody gets @-mentioned
// ---------------------------------------------------------------------------

describe("renderConformanceReport", () => {
  it("renders unverifiable as an unlinked spec, not as a divergence", async () => {
    const report = await makeService({ provenance: null }).verify("wi_1", ARTEFACT);
    const text = renderConformanceReport(report!);

    expect(text).toMatch(/no approved spec/i);
    expect(text).not.toMatch(/diverge/i);
  });

  it("renders drifted as a divergence from what was approved", async () => {
    const judge = judgeReturning({
      points: [
        {
          requirement: "Withdrawal must be a three-step flow",
          status: "diverged",
          observed: "two screens only",
          evidence: ["acme/app#412"],
        },
      ],
    });

    const text = renderConformanceReport((await makeService({ judge }).verify("wi_1", ARTEFACT))!);

    expect(text).toMatch(/diverge/i);
    expect(text).not.toMatch(/no approved spec/i);
  });

  it("never renders the two verdicts alike", async () => {
    const unverifiable = renderConformanceReport(
      (await makeService({ provenance: null }).verify("wi_1", ARTEFACT))!,
    );
    const drifted = renderConformanceReport(
      (await makeService({
        judge: judgeReturning({
          points: [{ requirement: "r", status: "diverged", evidence: ["PR#1"] }],
        }),
      }).verify("wi_1", ARTEFACT))!,
    );

    expect(unverifiable).not.toBe(drifted);
  });

  it("does not read as a failure when unverifiable", async () => {
    // Day-one output is almost entirely unverifiable. If that reads as a red
    // mark, the signal is noise before anyone has a chance to act on it.
    const text = renderConformanceReport(
      (await makeService({ provenance: null }).verify("wi_1", ARTEFACT))!,
    );

    expect(text).not.toMatch(/fail|violation|error|blocked/i);
  });

  it("@-mentions nobody", async () => {
    const judge = judgeReturning({
      points: [{ requirement: "r", status: "diverged", evidence: ["acme/app#412"] }],
    });
    const text = renderConformanceReport((await makeService({ judge }).verify("wi_1", ARTEFACT))!);

    expect(text).not.toMatch(/<@[A-Z0-9]+>/);
    expect(text).not.toMatch(/<!(channel|here|subteam)/);
    expect(text).not.toMatch(/@\w/);
  });

  it("states that it is a report and does not block", async () => {
    const text = renderConformanceReport(
      (await makeService({
        judge: judgeReturning({
          points: [{ requirement: "r", status: "diverged", evidence: ["PR#1"] }],
        }),
      }).verify("wi_1", ARTEFACT))!,
    );

    expect(text).toMatch(/does not block|report only|nothing is blocked/i);
  });
});

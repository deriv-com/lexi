import { describe, expect, it } from "vitest";
import {
  claimedEvidenceRepository,
  parseRunEvidenceBundle,
  PrismaRunEvidenceStore,
  REPOSITORY_MISMATCH,
  runEvidenceBundleKey,
} from "./run-evidence.prisma";
import { schemaFakeClient } from "./schema-fake.test-support";

const known = { isKnownAttempt: async (id: string) => id === "attempt-1" };
const NOW = new Date("2026-02-01T00:00:00.000Z");

function store() {
  const client = schemaFakeClient("RunEvidenceRecord");
  return { client, evidence: new PrismaRunEvidenceStore(client, () => NOW) };
}

const BUNDLE = {
  attemptId: "attempt-1",
  phase: "green",
  workflowRunId: 12345,
  commitSha: "abc123",
  checks: [{ name: "unit", status: "passed", durationMs: 42 }],
  failingTests: [],
  artifacts: [{ type: "report", uri: "https://example.com/report.xml", label: "junit" }],
  reportedAt: "2026-01-31T23:59:00.000Z",
};

describe("parseRunEvidenceBundle", () => {
  it("accepts a well-formed bundle and normalises a numeric run id", () => {
    const parsed = parseRunEvidenceBundle(BUNDLE);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.bundle.workflowRunId).toBe("12345");
  });

  it.each([
    [null, "JSON object"],
    [{ phase: "green" }, "attemptId"],
    [{ attemptId: "a", phase: "done" }, "phase"],
    [{ attemptId: "a", phase: "red", checks: [{ name: "x", status: "ok" }] }, "check"],
    [{ attemptId: "a", phase: "red", failingTests: [{ testName: "t" }] }, "failureOutput"],
    [{ attemptId: "a", phase: "red", artifacts: [{ type: "binary", uri: "u" }] }, "artifact"],
    [{ attemptId: "a", phase: "red", reportedAt: "yesterday" }, "ISO 8601"],
  ])("refuses %j", (input, reason) => {
    const parsed = parseRunEvidenceBundle(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reason);
  });

  it("truncates long free text instead of refusing it", () => {
    const parsed = parseRunEvidenceBundle({
      attemptId: "a",
      phase: "red",
      failingTests: [{ testName: "t", failureOutput: "x".repeat(20_000) }],
    });
    expect(parsed.ok && parsed.bundle.failingTests?.[0]?.failureOutput.length).toBe(8_000);
  });
});

describe("PrismaRunEvidenceStore", () => {
  it("stores a bundle and reads it back in the shape the engine folds", async () => {
    const { evidence } = store();
    const receipt = await evidence.ingest(BUNDLE, known);
    expect(receipt).toMatchObject({ accepted: true, attemptId: "attempt-1", phase: "green" });
    expect(receipt.deduplicated).toBeUndefined();

    const rows = await evidence.listByAttempt("attempt-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: receipt.evidenceId,
      phase: "green",
      workflowRunId: "12345",
      commitSha: "abc123",
      checks: [{ name: "unit", status: "passed", durationMs: 42 }],
      reportedAt: new Date("2026-01-31T23:59:00.000Z"),
      receivedAt: NOW,
    });
  });

  it("de-duplicates the same bundle arriving twice, whatever the field order", async () => {
    const { evidence, client } = store();
    const first = await evidence.ingest(BUNDLE, known);
    const reordered = Object.fromEntries(Object.entries(BUNDLE).reverse());
    const second = await evidence.ingest(reordered, known);
    expect(second).toMatchObject({ accepted: true, deduplicated: true, evidenceId: first.evidenceId });
    expect(client.runEvidenceRecord!.rows).toHaveLength(1);
  });

  it("treats a lost insert race as a duplicate", async () => {
    const { evidence, client } = store();
    const parsed = parseRunEvidenceBundle(BUNDLE);
    if (!parsed.ok) throw new Error("fixture");
    const delegate = client.runEvidenceRecord!;
    const realFind = delegate.findUnique.bind(delegate);
    let calls = 0;
    // The first read misses; another arrival inserts before our create.
    delegate.findUnique = async (args) => {
      calls += 1;
      if (calls === 1) {
        await delegate.create({ data: { bundleKey: runEvidenceBundleKey(parsed.bundle), attemptId: "attempt-1", phase: "green" } });
        return null;
      }
      return realFind(args);
    };
    expect(await evidence.ingest(BUNDLE, known)).toMatchObject({ accepted: true, deduplicated: true });
  });

  it("refuses an unknown attempt and a malformed bundle without writing", async () => {
    const { evidence, client } = store();
    expect(await evidence.ingest({ ...BUNDLE, attemptId: "nope" }, known)).toMatchObject({
      accepted: false,
      reason: "unknown attempt",
    });
    expect(await evidence.ingest({ attemptId: "attempt-1", phase: "nope" }, known)).toMatchObject({ accepted: false });
    expect(client.runEvidenceRecord!.rows).toHaveLength(0);
  });
});

describe("evidence is bound to the attempt's repository", () => {
  const bound = {
    ...known,
    repositoryOfAttempt: async (id: string) => (id === "attempt-1" ? "Acme/Web-App" : null),
  };

  it("accepts a bundle naming the attempt's repository, case-insensitively", async () => {
    const { evidence } = store();
    expect(await evidence.ingest({ ...BUNDLE, repository: "acme/web-app" }, bound)).toMatchObject({ accepted: true });
  });

  it("refuses a bundle naming another repository, a malformed one, or none, without writing", async () => {
    const { evidence, client } = store();
    for (const repository of ["acme/other-app", "acme/web-app/extra", " ", undefined]) {
      const body = repository === undefined ? BUNDLE : { ...BUNDLE, repository };
      expect(await evidence.ingest(body, bound)).toMatchObject({ accepted: false, reason: REPOSITORY_MISMATCH });
    }
    expect(client.runEvidenceRecord!.rows).toHaveLength(0);
  });

  it("does not check the repository when the attempt records none or no lookup is given", async () => {
    const { evidence } = store();
    const none = { ...known, repositoryOfAttempt: async () => null };
    expect(await evidence.ingest(BUNDLE, none)).toMatchObject({ accepted: true });
    expect(await evidence.ingest({ ...BUNDLE, phase: "red" }, known)).toMatchObject({ accepted: true });
  });

  it("keeps the repository out of the content key, so a re-delivery still de-duplicates", async () => {
    const { evidence } = store();
    const first = await evidence.ingest(BUNDLE, known);
    const second = await evidence.ingest({ ...BUNDLE, repository: "acme/web-app" }, bound);
    expect(second).toMatchObject({ accepted: true, deduplicated: true, evidenceId: first.evidenceId });
  });

  it("reads only a well-formed owner/name claim", () => {
    expect(claimedEvidenceRepository({ repository: " acme/web-app " })).toBe("acme/web-app");
    expect(claimedEvidenceRepository({ repository: "https://github.com/acme/web-app" })).toBeUndefined();
    expect(claimedEvidenceRepository({ repository: 42 })).toBeUndefined();
    expect(claimedEvidenceRepository(null)).toBeUndefined();
  });
});

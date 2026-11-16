import { describe, expect, it } from "vitest";
import { NoopReproductionProvider } from "./noop-reproduction-provider";

const request = {
  issueId: "issue-1",
  issueNumber: 42,
  title: "Checkout button does nothing",
  body: null,
  url: "https://github.com/acme/issues/issues/42",
  labels: ["bug"],
};

describe("NoopReproductionProvider", () => {
  it("completes a submission without claiming a reproduction", async () => {
    const provider = new NoopReproductionProvider();
    const { externalId, status } = await provider.submitIssue(request);
    expect(status).toBe("COMPLETED");
    expect(await provider.getStatus(externalId)).toBe("COMPLETED");

    const result = await provider.getResult(externalId);
    expect(result?.reproduced).toBe(false);
    expect(result?.details.reproductionAttempted).toBe(false);
    expect(result?.summary).toContain("#42");
  });

  it("gives every submission its own id", async () => {
    const provider = new NoopReproductionProvider();
    const a = await provider.submitIssue(request);
    const b = await provider.submitIssue(request);
    expect(a.externalId).not.toBe(b.externalId);
  });

  it("reports an unknown or cancelled id as failed with no result", async () => {
    const provider = new NoopReproductionProvider();
    const { externalId } = await provider.submitIssue(request);
    await provider.cancel(externalId);
    expect(await provider.getStatus(externalId)).toBe("FAILED");
    expect(await provider.getResult(externalId)).toBeNull();
  });
});

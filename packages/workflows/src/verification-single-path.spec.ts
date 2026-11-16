/**
 * Guard test: WorkflowOrchestrator must NOT directly call legacy evaluateAutoClose.
 *
 * Completion bar: the orchestrator's auto-close decisions must flow
 * through the canonical VerificationResult → evaluateVerificationAutoClose path.
 * This test will fail if someone re-introduces a direct legacy call.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Verification single-path guard", () => {
  const orchestratorSource = readFileSync(
    resolve(__dirname, "./workflow-orchestrator.ts"),
    "utf8",
  );

  it("WorkflowOrchestrator does NOT call policyEngine.evaluateAutoClose (legacy path)", () => {
    // The orchestrator should use evaluateVerificationAutoClose (canonical) exclusively.
    // policyEngine.evaluateAutoClose is the legacy path that consumes raw resultDetails.
    const legacyCalls = orchestratorSource.match(/policyEngine\.evaluateAutoClose\s*\(/g) ?? [];
    expect(legacyCalls.length).toBe(0);
  });

  it("WorkflowOrchestrator does NOT import evaluateAutoClose from auto-close-policy", () => {
    // Direct import of the legacy function is not allowed.
    const legacyImport = orchestratorSource.match(/from\s+["']\.\/auto-close-policy["']/g) ?? [];
    expect(legacyImport.length).toBe(0);
  });

  it("WorkflowOrchestrator imports evaluateVerificationAutoClose (canonical path)", () => {
    const canonicalImport = orchestratorSource.match(/evaluateVerificationAutoClose/g) ?? [];
    expect(canonicalImport.length).toBeGreaterThanOrEqual(1);
  });

  it("WorkflowOrchestrator imports mapReproductionResultToVerification (adapter mapping)", () => {
    const adapterImport = orchestratorSource.match(/mapReproductionResultToVerification/g) ?? [];
    expect(adapterImport.length).toBeGreaterThanOrEqual(1);
  });
});

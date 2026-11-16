/**
 * Capability matrix rendering, against a small fixture snapshot. The drift
 * gate over the real document lives in `@lexi/agent-tools`, beside the tool
 * modules the snapshot is built from.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  capabilityProblems,
  classifiedActions,
  loadGrantablePermissions,
  renderCapabilityMatrix,
  type CapabilitySnapshot,
} from "./capability-matrix";

function snapshot(overrides: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot {
  return {
    modules: [
      {
        name: "github-read",
        intentClasses: [],
        tools: [
          { name: "read_issue", mutating: false },
          { name: "read_pull_request", mutating: false },
        ],
      },
      {
        name: "github-write",
        intentClasses: ["github"],
        tools: [
          { name: "merge_pull_request", mutating: true, requiredPermission: "pr.merge" },
          { name: "comment_on_issue", mutating: true, requiredPermission: "issue.comment" },
        ],
      },
    ],
    actionClasses: classifiedActions(),
    grantablePermissions: ["issue.comment", "pr.merge"],
    authorizationSource: "examples/config/authorization.yaml",
    ...overrides,
  };
}

describe("renderCapabilityMatrix", () => {
  it("lists every tool with its permission, changing tools apart from the rest", () => {
    const doc = renderCapabilityMatrix(snapshot());
    expect(doc).toContain("**2 modules, 4 tools: 2 change something outside the agent, 2 do not.**");
    expect(doc).toContain("| `merge_pull_request` | `github-write` | `pr.merge` |");
    expect(doc).toContain("| `read_issue` | `github-read` | — |");
    expect(doc.indexOf("comment_on_issue")).toBeLessThan(doc.indexOf("merge_pull_request"));
    expect(doc).toContain("| `github-read` | every request | 2 | 0 |");
    expect(doc).toContain("| `github-write` | `github` | 2 | 2 |");
  });

  it("says it is generated and how to regenerate it", () => {
    const doc = renderCapabilityMatrix(snapshot());
    expect(doc.toLowerCase()).toContain("do not edit by hand");
    expect(doc).toContain("npm run docs:capability-matrix");
  });

  it("is deterministic", () => {
    expect(renderCapabilityMatrix(snapshot())).toBe(renderCapabilityMatrix(snapshot()));
  });

  it("carries the live action classifications", () => {
    const byAction = new Map(classifiedActions().map((a) => [a.action, a.actionClass]));
    expect(byAction.get("spec.approve")).toBe("human_gated");
    expect(byAction.get("spec.create")).toBe("constructive");
    expect(byAction.get("merge")).toBe("prohibited");
    expect(renderCapabilityMatrix(snapshot())).toContain("| `merge` | prohibited |");
  });
});

describe("capabilityProblems", () => {
  it("is empty for a consistent snapshot", () => {
    expect(capabilityProblems(snapshot())).toEqual([]);
  });

  it("reports a permission no role can hold", () => {
    // The tool would be offered to the model while every call to it is denied.
    expect(capabilityProblems(snapshot({ grantablePermissions: ["issue.comment"] }))).toEqual([
      "merge_pull_request needs pr.merge, which no role in examples/config/authorization.yaml grants",
    ]);
  });

  it("reports a mutating tool without a permission and a duplicated name", () => {
    const broken = snapshot();
    broken.modules[1].tools.push({ name: "close_issue", mutating: true });
    broken.modules[1].tools.push({ name: "read_issue", mutating: false });
    expect(capabilityProblems(broken)).toEqual([
      "close_issue changes things but declares no permission",
      "read_issue is declared by both github-read and github-write",
    ]);
  });
});

describe("loadGrantablePermissions", () => {
  it("collects every permission the example roles can hold, inheritance included", () => {
    const permissions = loadGrantablePermissions(path.resolve(__dirname, "../../../../examples/config/authorization.yaml"));
    expect(permissions.length).toBeGreaterThan(5);
    expect(permissions).toEqual([...permissions].sort());
  });
});

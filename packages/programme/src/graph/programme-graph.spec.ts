import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  applyProgrammeGraphSection,
  PROGRAMME_GRAPH_BEGIN_MARKER,
  renderProgrammeGraphSection,
} from "./programme-graph";

const DOC_PATH = join(__dirname, "../../PROGRAMME_LIFECYCLE.md");

describe("PROGRAMME_LIFECYCLE.md drift", () => {
  it("is in sync with the live state machines", () => {
    const markdown = readFileSync(DOC_PATH, "utf8");
    const result = applyProgrammeGraphSection(markdown);
    expect(result.inSync, `${result.reason ?? "drift detected"} — run \`npm run graph:programme -w @lexi/programme\` to regenerate.`).toBe(true);
  });

  it("reports missing markers instead of appending blindly", () => {
    const result = applyProgrammeGraphSection("# Docs with no markers\n");
    expect(result.inSync).toBe(false);
    expect(result.updatedContent).toBeUndefined();
  });

  it("detects a hand-edited diagram as drift", () => {
    const markdown = readFileSync(DOC_PATH, "utf8");
    const tampered = markdown.replace("PROPOSED --> SEEDED", "PROPOSED --> COMPLETE");
    expect(applyProgrammeGraphSection(tampered).inSync).toBe(false);
  });

  it("renders all three machines in one section", () => {
    const section = renderProgrammeGraphSection();
    expect(section.startsWith(PROGRAMME_GRAPH_BEGIN_MARKER)).toBe(true);
    expect(section).toContain("### Programme");
    expect(section).toContain("### Milestone");
    expect(section).toContain("### Build task");
  });
});

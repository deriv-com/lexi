import { describe, it, expect } from "vitest";
import { COVERAGE_DIMENSIONS } from "./coverage-dimensions";
import { FEATURE_INTAKE_FIELDS, featureFieldSchemaFor } from "./feature-intake-fields";

/**
 * The field descriptors the generalized intake loop uses for FEATURE work.
 *
 * A bug's required fields are reproduction-shaped (steps, expected, actual); a
 * feature's are the nine coverage dimensions. Forcing a feature through the
 * bug schema is what made every non-bug request either get rejected for
 * missing repro steps or get a fabricated one — which then destroys the
 * ability to tell a verified bug fix from an unverified feature afterwards.
 */

describe("feature intake fields", () => {
  it("has one field per coverage dimension", () => {
    expect(FEATURE_INTAKE_FIELDS.map((f) => f.field)).toEqual([...COVERAGE_DIMENSIONS]);
  });

  it("ships a coaching question and a default for every field", () => {
    for (const field of FEATURE_INTAKE_FIELDS) {
      expect(field.question.length).toBeGreaterThan(0);
      expect(field.defaultAnswer.length).toBeGreaterThan(0);
    }
  });

  it("marks the mandatory dimensions required", () => {
    const schema = featureFieldSchemaFor({
      mandatoryDimensions: ["problem", "scope"],
      deferrableDimensions: [],
    });

    expect(schema.filter((f) => f.required).map((f) => f.field)).toEqual(["problem", "scope"]);
  });

  it("marks a deferrable dimension as deferrable", () => {
    const schema = featureFieldSchemaFor({
      mandatoryDimensions: [...COVERAGE_DIMENSIONS],
      deferrableDimensions: ["risks"],
    });

    expect(schema.find((f) => f.field === "risks")?.deferrable).toBe(true);
    expect(schema.find((f) => f.field === "problem")?.deferrable).toBe(false);
  });

  it("keeps a non-mandatory dimension in the schema as optional", () => {
    // Still worth asking if there is room in a batch — just not blocking.
    const schema = featureFieldSchemaFor({ mandatoryDimensions: ["problem"], deferrableDimensions: [] });

    expect(schema).toHaveLength(COVERAGE_DIMENSIONS.length);
    expect(schema.find((f) => f.field === "rollout")?.required).toBe(false);
  });
});

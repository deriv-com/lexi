import type { ToolDefinition } from "@lexi/agent";

/** Builds a tool definition with a closed object schema. */
export function defineTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition {
  return {
    name,
    description,
    input_schema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
  };
}

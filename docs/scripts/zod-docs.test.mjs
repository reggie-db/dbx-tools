import { expect, test } from "bun:test";
import { z } from "zod";

import {
  injectSchemaSection,
  jsonSchemaFieldLines,
  schemaDocsMarkdown,
  schemaNameFromInferType,
  zodDescribeFromExpression,
} from "./zod-docs.mjs";
import ts from "typescript";

test("reads describe from a Zod call chain", () => {
  const source = ts.createSourceFile(
    "example.ts",
    'const schema = z.string().optional().describe("The name.");',
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const statement = source.statements[0];
  expect(ts.isVariableStatement(statement)).toBe(true);
  const initializer = statement.declarationList.declarations[0]?.initializer;
  expect(zodDescribeFromExpression(ts, initializer)).toBe("The name.");
});

test("resolves z.infer typeof aliases", () => {
  const source = ts.createSourceFile(
    "example.ts",
    "export type Example = z.infer<typeof ExampleSchema>;",
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const statement = source.statements[0];
  expect(ts.isTypeAliasDeclaration(statement)).toBe(true);
  expect(schemaNameFromInferType(ts, statement.type)).toBe("ExampleSchema");
});

test("renders JSON Schema field descriptions", () => {
  const schema = z
    .object({
      name: z.string().describe("The invoke id."),
      family: z.string().optional().describe("Detected family."),
    })
    .describe("Normalized endpoint.");
  const markdown = schemaDocsMarkdown(schema, "ServingEndpointSummarySchema");
  expect(markdown).toContain("## ServingEndpointSummary fields");
  expect(markdown).toContain("Normalized endpoint.");
  expect(jsonSchemaFieldLines(z.toJSONSchema(schema))).toEqual([
    "- `name`: The invoke id.",
    "- `family` (optional): Detected family.",
  ]);
  expect(injectSchemaSection("# Type Alias: Example\n", markdown)).toContain(
    "## ServingEndpointSummary fields",
  );
});

import type { AgentToolDefinition } from "@databricks/appkit/beta";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";

const JsonObjectSchema = z
  .record(z.string(), z.unknown())
  .describe("A JSON object embedded in the Graphiti OpenAPI document.");

const OpenApiMediaTypeSchema = z
  .object({
    schema: JsonObjectSchema.describe("The request JSON Schema for this media type."),
  })
  .describe("One OpenAPI request media type.");

const OpenApiRequestBodySchema = z
  .object({
    content: z
      .record(z.string(), OpenApiMediaTypeSchema)
      .describe("Request media types keyed by content type."),
  })
  .describe("An OpenAPI request body.");

const OpenApiOperationSchema = z
  .object({
    operationId: z.string().describe("The stable operation identifier."),
    summary: z.string().optional().describe("The short operation summary."),
    description: z.string().optional().describe("The full operation description."),
    requestBody: OpenApiRequestBodySchema.optional().describe(
      "The optional operation request body.",
    ),
  })
  .describe("The OpenAPI fields required to publish an AppKit tool.");

const OpenApiPathSchema = z
  .object({
    post: OpenApiOperationSchema.optional().describe("The POST operation for this path."),
  })
  .describe("One OpenAPI path item.");

const GraphitiOpenApiSchema = z
  .object({
    paths: z
      .record(z.string(), OpenApiPathSchema)
      .describe("OpenAPI path items keyed by their URL path."),
    components: z
      .object({
        schemas: z
          .record(z.string(), JsonObjectSchema)
          .describe("Reusable OpenAPI schemas keyed by component name."),
      })
      .describe("Reusable OpenAPI components."),
  })
  .describe("The Graphiti OpenAPI document used for AppKit tool registration.");

type GraphitiOpenApi = z.infer<typeof GraphitiOpenApiSchema>;

/** One direct Graphiti HTTP operation and its AppKit tool definition. */
export interface GraphitiToolContract {
  /** AppKit tool metadata derived from OpenAPI. */
  definition: AgentToolDefinition;
  /** Loopback HTTP path exposed by the Python runtime. */
  path: string;
}

/** Parse the Python-owned OpenAPI document into direct AppKit tool contracts. */
export function graphitiToolContracts(
  source: string,
  toolNames: readonly string[],
  hiddenArguments: ReadonlySet<string>,
): Record<string, GraphitiToolContract> {
  const document = GraphitiOpenApiSchema.parse(JSON.parse(source));
  const contracts = Object.fromEntries(
    toolNames.map((name) => [name, toolContract(document, name, hiddenArguments)]),
  );
  return contracts;
}

function toolContract(
  document: GraphitiOpenApi,
  name: string,
  hiddenArguments: ReadonlySet<string>,
): GraphitiToolContract {
  const match = Object.entries(document.paths).find(([, path]) => path.post?.operationId === name);
  if (!match?.[1].post) throw new Error(`Graphiti OpenAPI is missing tool operation: ${name}`);
  const [path, operation] = [match[0], match[1].post];
  const requestSchema = operation.requestBody?.content["application/json"]?.schema;
  if (!requestSchema) throw new Error(`Graphiti OpenAPI tool has no JSON request schema: ${name}`);
  const description = operation.description?.trim() || operation.summary?.trim();
  if (!description) throw new Error(`Graphiti OpenAPI tool has no description: ${name}`);
  const parameters = hideArguments(
    resolveReferences(document, requestSchema) as JSONSchema7,
    hiddenArguments,
  );
  return {
    path,
    definition: {
      name,
      description,
      parameters,
    },
  };
}

function resolveReferences(
  document: GraphitiOpenApi,
  value: unknown,
  active: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveReferences(document, item, active));
  if (!isRecord(value)) return value;
  const reference = typeof value.$ref === "string" ? value.$ref : undefined;
  if (reference) {
    if (active.has(reference)) throw new Error(`Cyclic Graphiti OpenAPI reference: ${reference}`);
    const target = referenceTarget(document, reference);
    const next = new Set(active).add(reference);
    const { $ref: _ignored, ...siblings } = value;
    return {
      ...(resolveReferences(document, target, next) as Record<string, unknown>),
      ...(resolveReferences(document, siblings, next) as Record<string, unknown>),
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, resolveReferences(document, child, active)]),
  );
}

function referenceTarget(document: GraphitiOpenApi, reference: string): unknown {
  if (!reference.startsWith("#/")) {
    throw new Error(`Unsupported Graphiti OpenAPI reference: ${reference}`);
  }
  let current: unknown = document;
  for (const rawSegment of reference.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) || !(segment in current)) {
      throw new Error(`Unresolved Graphiti OpenAPI reference: ${reference}`);
    }
    current = current[segment];
  }
  return current;
}

function hideArguments(schema: JSONSchema7, hiddenArguments: ReadonlySet<string>): JSONSchema7 {
  const { properties: sourceProperties, required: sourceRequired, ...rest } = schema;
  const properties = isRecord(sourceProperties) ? { ...sourceProperties } : undefined;
  if (properties) {
    for (const name of hiddenArguments) delete properties[name];
  }
  const required = sourceRequired?.filter((name) => !hiddenArguments.has(name));
  return {
    ...rest,
    ...(properties ? { properties } : {}),
    ...(required?.length ? { required } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

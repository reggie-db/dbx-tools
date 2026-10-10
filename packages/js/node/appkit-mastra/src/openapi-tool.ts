/**
 * OpenAPI operation loading and JSON Schema extraction.
 *
 * @module
 */
import { readFile } from "node:fs/promises";
import { object } from "@dbx-tools/shared-core";
import { urlBuilder, type UrlBuilder } from "@dbx-tools/shared-core/net";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "TRACE"] as const;

const JsonObjectSchema = z
  .record(z.string(), z.unknown())
  .describe("A JSON object embedded in an OpenAPI document.");

const OpenApiMediaTypeSchema = z
  .object({
    schema: JsonObjectSchema.describe("The JSON Schema for this media type."),
  })
  .describe("One OpenAPI media type.");

const OpenApiRequestBodySchema = z
  .object({
    content: z
      .record(z.string(), OpenApiMediaTypeSchema)
      .describe("Request media types keyed by content type."),
  })
  .describe("An OpenAPI request body.");

const OpenApiResponseSchema = z
  .object({
    content: z
      .record(z.string(), OpenApiMediaTypeSchema)
      .optional()
      .describe("Response media types keyed by content type."),
  })
  .describe("One OpenAPI response.");

const OpenApiOperationSchema = z
  .object({
    operationId: z.string().describe("The stable operation identifier."),
    summary: z.string().optional().describe("The short operation summary."),
    description: z.string().optional().describe("The full operation description."),
    requestBody: OpenApiRequestBodySchema.optional().describe(
      "The optional operation request body.",
    ),
    responses: z
      .record(z.string(), OpenApiResponseSchema)
      .describe("Operation responses keyed by HTTP status."),
  })
  .describe("The OpenAPI fields required to define a tool.");

const OpenApiPathSchema = z
  .object({
    get: OpenApiOperationSchema.optional(),
    post: OpenApiOperationSchema.optional(),
    put: OpenApiOperationSchema.optional(),
    patch: OpenApiOperationSchema.optional(),
    delete: OpenApiOperationSchema.optional(),
    options: OpenApiOperationSchema.optional(),
    head: OpenApiOperationSchema.optional(),
    trace: OpenApiOperationSchema.optional(),
  })
  .describe("Operations available at one OpenAPI path.");

const OpenApiDocumentSchema = z
  .object({
    paths: z
      .record(z.string(), OpenApiPathSchema)
      .refine((paths) => Object.keys(paths).length > 0, "OpenAPI paths must not be empty")
      .describe("OpenAPI path items keyed by URL path."),
    components: JsonObjectSchema.optional().describe("Reusable OpenAPI components."),
    servers: z
      .array(
        z.object({
          url: z.string().describe("Server base URL."),
        }),
      )
      .optional()
      .describe("OpenAPI server definitions."),
  })
  .describe("An OpenAPI document used to define HTTP tools.");

type OpenApiDocument = z.infer<typeof OpenApiDocumentSchema>;
type OpenApiOperation = z.infer<typeof OpenApiOperationSchema>;

/** HTTP method supported by an {@link OpenApiTool}. */
export type OpenApiHttpMethod = (typeof HTTP_METHODS)[number];

/** One executable HTTP operation derived from an OpenAPI document. */
export interface OpenApiTool {
  /** Stable operation identifier. */
  id: string;
  /** Model-facing operation description. */
  description: string;
  /** Resolved operation URL, or the OpenAPI path for a local document without a server URL. */
  url: string;
  /** HTTP method used by the operation. */
  method: OpenApiHttpMethod;
  /** JSON Schema describing operation input. */
  inputSchema: JSONSchema7;
  /** JSON Schema describing a successful operation result. */
  outputSchema: JSONSchema7;
}

/** Request options used while loading an OpenAPI document. */
export interface OpenApiToolsOptions {
  /** Cancels an HTTP request or file read. */
  signal?: AbortSignal;
  /** Headers sent when `source` is an HTTP(S) URL. */
  headers?: RequestInit["headers"];
}

/** Load an HTTP(S) URL or local file and return its OpenAPI operations as tool schemas. */
export async function openApiTools(
  source: string,
  options: OpenApiToolsOptions = {},
): Promise<OpenApiTool[]> {
  const sourceUrl = httpUrl(source);
  const document = OpenApiDocumentSchema.parse(
    sourceUrl
      ? await fetchDocument(sourceUrl, options)
      : await readDocument(source, options.signal),
  );
  return Object.entries(document.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = item[method.toLowerCase() as Lowercase<OpenApiHttpMethod>];
      return operation ? [operationTool(document, sourceUrl, path, method, operation)] : [];
    }),
  );
}

function httpUrl(source: string): UrlBuilder | undefined {
  const value = source.trim();
  if (!value.startsWith("http://") && !value.startsWith("https://")) return undefined;
  const url = urlBuilder(value);
  return url?.scheme === "http" || url?.scheme === "https" ? url : undefined;
}

async function fetchDocument(url: URL, options: OpenApiToolsOptions): Promise<unknown> {
  const response = await fetch(url, {
    signal: options.signal,
    headers: options.headers,
  });
  if (!response.ok) {
    throw new Error(`OpenAPI request failed with HTTP ${response.status}: ${url}`);
  }
  return response.json();
}

async function readDocument(path: string, signal?: AbortSignal): Promise<unknown> {
  return JSON.parse(await readFile(path, { encoding: "utf8", signal }));
}

function operationTool(
  document: OpenApiDocument,
  sourceUrl: URL | undefined,
  path: string,
  method: OpenApiHttpMethod,
  operation: OpenApiOperation,
): OpenApiTool {
  const requestSchema = jsonSchema(operation.requestBody?.content) ?? { type: "object" };
  const responseSchema = successfulResponseSchema(operation);
  return {
    id: operation.operationId,
    description:
      operation.description?.trim() || operation.summary?.trim() || operation.operationId,
    url: operationUrl(document, sourceUrl, path),
    method,
    inputSchema: resolveReferences(document, requestSchema) as JSONSchema7,
    outputSchema: resolveReferences(document, responseSchema) as JSONSchema7,
  };
}

function successfulResponseSchema(operation: OpenApiOperation): Record<string, unknown> {
  for (const [status, response] of Object.entries(operation.responses)) {
    const schema = jsonSchema(response.content);
    if (/^2(?:\d{2}|XX)$/i.test(status) && schema) return schema;
  }
  return {};
}

function jsonSchema(
  content: Record<string, z.infer<typeof OpenApiMediaTypeSchema>> | undefined,
): Record<string, unknown> | undefined {
  const mediaType = Object.entries(content ?? {}).find(([type]) =>
    /^application\/(?:[^+;]+\+)?json(?:;|$)/i.test(type),
  );
  return mediaType?.[1].schema;
}

function operationUrl(document: OpenApiDocument, sourceUrl: URL | undefined, path: string): string {
  const server = document.servers?.[0]?.url;
  if (server) {
    const base = sourceUrl ? urlBuilder(new URL(server, sourceUrl)) : httpUrl(server);
    return base
      ? base.withPathAppend(path).toString()
      : `${server.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  }
  return sourceUrl ? (urlBuilder(sourceUrl)?.withPathReplace(path).toString() ?? path) : path;
}

function resolveReferences(
  document: OpenApiDocument,
  value: unknown,
  active: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveReferences(document, item, active));
  if (!object.isRecord(value)) return value;
  const reference = typeof value.$ref === "string" ? value.$ref : undefined;
  if (reference) {
    if (active.has(reference)) throw new Error(`Cyclic OpenAPI reference: ${reference}`);
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

function referenceTarget(document: OpenApiDocument, reference: string): unknown {
  if (!reference.startsWith("#/")) throw new Error(`Unsupported OpenAPI reference: ${reference}`);
  let current: unknown = document;
  for (const rawSegment of reference.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!object.isRecord(current) || !(segment in current)) {
      throw new Error(`Unresolved OpenAPI reference: ${reference}`);
    }
    current = current[segment];
  }
  return current;
}

if (import.meta.main) {
  const source = process.argv[2];
  if (!source) throw new Error("Usage: bun openapi-tool.ts <openapi-url-or-file>");
  console.log(JSON.stringify(await openApiTools(source), null, 2));
}

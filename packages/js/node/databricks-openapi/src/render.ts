import {
  DatabricksOpenapiError,
  type DatabricksApiIr,
  type DatabricksOperation,
  type OperationParameter,
  type WireComponent,
  type WireSchema,
} from "./types.ts";

const METHOD_ORDER = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

function canonicalSchemaName(name: string): string {
  return name.replace(/^(?:unmarshal|marshal)/, "").replace(/Schema$/, "");
}

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, T>;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return sortedRecord(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, stableValue(item)]),
  );
}

function parameterSchema(parameter: OperationParameter): WireSchema {
  return parameter.schema;
}

function renderParameter(parameter: OperationParameter): Record<string, unknown> {
  return {
    name: parameter.wireName,
    in: parameter.location,
    required: parameter.location === "path" ? true : parameter.required,
    ...(parameter.description ? { description: parameter.description } : {}),
    schema: parameterSchema(parameter),
    ...(parameter.resourcePattern
      ? { "x-databricks-resource-pattern": parameter.resourcePattern }
      : {}),
    "x-databricks-sdk-name": parameter.sdkName,
  };
}

function cloneSchema(schema: WireSchema): WireSchema {
  return structuredClone(schema);
}

function requestSchema(operation: DatabricksOperation, component: WireComponent): WireSchema {
  const schema = cloneSchema(component.schema);
  const properties = schema.properties as Record<string, WireSchema> | undefined;
  if (!properties) return schema;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  let modified = false;
  for (const parameter of operation.parameters) {
    const sourcePath = operation.body?.sourcePath;
    if (sourcePath && !parameter.sdkName.startsWith(`${sourcePath}.`)) continue;
    const sdkName = sourcePath ? parameter.sdkName.slice(sourcePath.length + 1) : parameter.sdkName;
    const wireName =
      component.sdkToWire[sdkName] ?? sdkName.split(".").at(-1) ?? parameter.wireName;
    modified ||= Object.hasOwn(properties, wireName);
    delete properties[wireName];
    required.delete(wireName);
  }
  if (operation.body?.sourcePath && !modified) {
    return { $ref: `#/components/schemas/${component.name}` };
  }
  if (required.size > 0) schema.required = [...required].sort();
  else delete schema.required;
  return schema;
}

function renderRequestBody(
  ir: DatabricksApiIr,
  operation: DatabricksOperation,
): Record<string, unknown> | undefined {
  if (!operation.body) return undefined;
  const component = ir.schemas.get(canonicalSchemaName(operation.body.schemaName));
  if (!component) {
    throw new DatabricksOpenapiError(
      `${operation.operationId} request schema ${operation.body.schemaName} was not extracted`,
    );
  }
  return {
    required: operation.body.required,
    content: {
      [operation.body.mediaType]: {
        schema: requestSchema(operation, component),
      },
    },
  };
}

function renderResponse(
  ir: DatabricksApiIr,
  operation: DatabricksOperation,
): Record<string, unknown> {
  const response = operation.response;
  const status = response.status ?? (response.kind === "none" ? "204" : "200");
  if (response.kind === "none") {
    return { [status]: { description: "Operation completed successfully." } };
  }
  if (response.kind === "raw") {
    if (!response.mediaType || !response.rawSchema) {
      throw new DatabricksOpenapiError(
        `${operation.operationId} raw response is missing an override`,
      );
    }
    return {
      [status]: {
        description: "Operation completed successfully.",
        content: {
          [response.mediaType]: {
            schema: response.rawSchema,
          },
        },
      },
    };
  }
  if (response.inlineSchema) {
    return {
      [status]: {
        description: "Operation completed successfully.",
        content: {
          [response.mediaType ?? "application/json"]: {
            schema: cloneSchema(response.inlineSchema),
          },
        },
      },
    };
  }
  const componentName = response.schemaName ? canonicalSchemaName(response.schemaName) : undefined;
  if (!componentName || !ir.schemas.has(componentName)) {
    throw new DatabricksOpenapiError(
      `${operation.operationId} response schema ${response.schemaName ?? "<missing>"} was not extracted`,
    );
  }
  return {
    [status]: {
      description: "Operation completed successfully.",
      content: {
        [response.mediaType ?? "application/json"]: {
          schema: { $ref: `#/components/schemas/${componentName}` },
        },
      },
    },
  };
}

function renderOperation(
  ir: DatabricksApiIr,
  operation: DatabricksOperation,
): Record<string, unknown> {
  const parameters = [...operation.parameters]
    .sort((left, right) => {
      const byLocation = left.location.localeCompare(right.location);
      return byLocation || left.wireName.localeCompare(right.wireName);
    })
    .map(renderParameter);
  const requestBody = renderRequestBody(ir, operation);
  return {
    tags: [ir.service.name],
    operationId: operation.operationId,
    ...(operation.description ? { description: operation.description } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: renderResponse(ir, operation),
    "x-databricks-api-scope": operation.scope,
    ...(operation.override ? { "x-databricks-override": operation.override } : {}),
  };
}

function renderPaths(ir: DatabricksApiIr): Record<string, unknown> {
  const paths = new Map<string, Record<string, unknown>>();
  for (const operation of ir.operations) {
    const method = operation.httpMethod.toLowerCase();
    const path = paths.get(operation.path) ?? {};
    if (path[method]) {
      throw new DatabricksOpenapiError(
        `Duplicate ${operation.httpMethod} operation at ${operation.path}`,
      );
    }
    path[method] = renderOperation(ir, operation);
    paths.set(operation.path, path);
  }
  return sortedRecord(
    [...paths.entries()].map(([path, methods]) => [
      path,
      Object.fromEntries(
        Object.entries(methods).sort(
          ([left], [right]) => METHOD_ORDER.indexOf(left) - METHOD_ORDER.indexOf(right),
        ),
      ),
    ]),
  );
}

function renderComponents(ir: DatabricksApiIr): Record<string, WireSchema> {
  return sortedRecord(
    [...ir.schemas.entries()].map(([name, component]) => [name, component.schema]),
  );
}

function title(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** Render deterministic OpenAPI 3.0.3 with SDK and CLI provenance. */
export function renderOpenapi(ir: DatabricksApiIr): Record<string, unknown> {
  const inventory = ir.operations
    .map((operation) => ({
      operationId: operation.operationId,
      method: operation.httpMethod,
      path: operation.path,
      source: `${operation.location.file}:${operation.location.line}`,
    }))
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
  const warnings = ir.diagnostics
    .filter((diagnostic) => diagnostic.severity === "warning")
    .map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.location
        ? {
            source: `${diagnostic.location.file}:${diagnostic.location.line}:${diagnostic.location.column}`,
          }
        : {}),
    }))
    .sort((left, right) =>
      `${left.code}:${left.source ?? ""}:${left.message}`.localeCompare(
        `${right.code}:${right.source ?? ""}:${right.message}`,
      ),
    );

  return stableValue({
    openapi: "3.0.3",
    info: {
      title: `${title(ir.service.name)} API`,
      version: ir.source.packageVersion,
    },
    servers: [
      {
        url: "https://{host}",
        description: "Databricks API host",
        variables: {
          host: {
            default: "example.cloud.databricks.com",
            description: "Workspace, account, or data-plane host",
          },
        },
      },
    ],
    security: [{ bearerAuth: [] }],
    tags: [{ name: ir.service.name }],
    paths: renderPaths(ir),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
      schemas: renderComponents(ir),
    },
    "x-databricks-sdk-package": ir.source.packageName,
    "x-databricks-sdk-version": ir.source.packageVersion,
    "x-databricks-operation-inventory": inventory,
    ...(warnings.length > 0 ? { "x-databricks-diagnostics": warnings } : {}),
  }) as Record<string, unknown>;
}

/** Serialize a rendered document with stable indentation and final newline. */
export function stringifyOpenapi(document: Record<string, unknown>): string {
  return `${JSON.stringify(stableValue(document), null, 2)}\n`;
}

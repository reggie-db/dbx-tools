import {
  DatabricksOpenapiError,
  type DatabricksApiIr,
  type DatabricksOperation,
  type ExtractionDiagnostic,
  type OperationOverride,
  type OverrideDocument,
  type WireSchema,
} from "./types.ts";

function rawSchema(kind: OperationOverride["rawResponse"]): WireSchema | undefined {
  if (kind === "string") return { type: "string" };
  if (kind === "binary") return { type: "string", format: "binary" };
  if (kind === "object") return { type: "object", additionalProperties: true };
  return undefined;
}

function applyOverride(operation: DatabricksOperation, override: OperationOverride): void {
  if (override.status) operation.response.status = override.status;
  if (override.requestMediaType && operation.body) {
    operation.body.mediaType = override.requestMediaType;
  }
  if (override.responseMediaType) operation.response.mediaType = override.responseMediaType;
  if (override.rawResponse) operation.response.rawSchema = rawSchema(override.rawResponse);
  operation.override = { reason: override.reason, source: override.source };
}

/** Apply narrow corrections and require complete raw response contracts. */
export function applyOverrides(
  irs: DatabricksApiIr[],
  overrides: OverrideDocument,
  strict = true,
): void {
  const operations = new Map(
    irs.flatMap((ir) => ir.operations.map((operation) => [operation.operationId, operation])),
  );
  const diagnostics: ExtractionDiagnostic[] = [];

  for (const [operationId, override] of Object.entries(overrides.operations)) {
    const operation = operations.get(operationId);
    if (!operation) {
      diagnostics.push({
        code: "STALE_OVERRIDE",
        message: `Override ${operationId} matches no extracted operation`,
        severity: "error",
      });
      continue;
    }
    applyOverride(operation, override);
  }

  for (const operation of operations.values()) {
    if (
      operation.response.kind === "raw" &&
      (!operation.response.status || !operation.response.mediaType || !operation.response.rawSchema)
    ) {
      diagnostics.push({
        code: "RAW_RESPONSE_OVERRIDE_REQUIRED",
        message: `${operation.operationId} requires status, responseMediaType, and rawResponse overrides`,
        severity: "error",
        location: operation.location,
      });
    }
  }

  for (const ir of irs) ir.diagnostics.push(...diagnostics);
  if (strict && diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new DatabricksOpenapiError("Strict OpenAPI override application failed", diagnostics);
  }
}

/** A source position retained from a generated SDK module. */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** A deterministic extraction or override diagnostic. */
export interface ExtractionDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning";
  location?: SourceLocation;
}

/** JSON Schema subset emitted by the generator. */
export type WireSchema = Record<string, unknown>;

/** A reusable wire component and its SDK-to-wire field map. */
export interface WireComponent {
  name: string;
  schema: WireSchema;
  sdkToWire: Record<string, string>;
  sourceSchema: string;
  location: SourceLocation;
}

/** An HTTP request parameter extracted from SDK syntax. */
export interface OperationParameter {
  sdkName: string;
  wireName: string;
  location: "path" | "query";
  required: boolean;
  schema: WireSchema;
  description?: string;
  resourcePattern?: string;
}

/** A marshalled request body extracted from SDK syntax. */
export interface OperationBody {
  sourcePath: string;
  schemaName: string;
  required: boolean;
  mediaType: string;
}

/** A parsed or raw response extracted from SDK syntax. */
export interface OperationResponse {
  kind: "json" | "none" | "raw";
  schemaName?: string;
  status?: string;
  mediaType?: string;
  inlineSchema?: WireSchema;
  rawSchema?: WireSchema;
}

/** One direct SDK buildHttpRequest call. */
export interface DatabricksOperation {
  operationId: string;
  clientClass: string;
  methodName: string;
  description?: string;
  httpMethod: string;
  sdkPath: string;
  path: string;
  parameters: OperationParameter[];
  body?: OperationBody;
  response: OperationResponse;
  scope: "workspace" | "account" | "data-plane";
  override?: {
    reason: string;
    source: string;
  };
  location: SourceLocation;
}

/** Source provenance for one modular Databricks SDK input. */
export interface DatabricksApiSource {
  packageName: string;
  packageVersion: string;
  sdkEntrypoint: string;
}

/** Source-neutral representation of one generated API document. */
export interface DatabricksApiIr {
  source: DatabricksApiSource;
  service: {
    name: string;
    clientClass: string;
    scope: "workspace" | "account" | "data-plane";
  };
  operations: DatabricksOperation[];
  schemas: Map<string, WireComponent>;
  diagnostics: ExtractionDiagnostic[];
}

/** One configured modular SDK source. */
export interface DatabricksSdkInput {
  package: string;
  output: string;
  expectedOperations?: number;
}

/** Package-level generator configuration. Relative paths use the package root. */
export interface DatabricksOpenapiConfig {
  inputs: DatabricksSdkInput[];
  overrides?: string;
  rustOutputDirectory: string;
  rustClientPath: string;
  strict: boolean;
}

/** A resolved SDK package and its generated v1 modules. */
export interface ResolvedSdkInput {
  input: DatabricksSdkInput;
  packageRoot: string;
  packageVersion: string;
  apiVersion: string;
  entrypoint: string;
  clientPath: string;
  modelPath: string;
  modelDeclarationPath: string;
}

/** Allowed correction for one stable SDK operation identity. */
export interface OperationOverride {
  reason: string;
  source: string;
  status?: string;
  requestMediaType?: string;
  responseMediaType?: string;
  rawResponse?: "string" | "binary" | "object";
}

/** Versioned, narrow override document. */
export interface OverrideDocument {
  version: 1;
  operations: Record<string, OperationOverride>;
}

/** A rendered document and its Rust-owned JSON destination. */
export interface ArtifactPlan {
  output: string;
  document: Record<string, unknown>;
  rustSpecPath: string;
}

function diagnosticText(diagnostic: ExtractionDiagnostic): string {
  const location = diagnostic.location
    ? `${diagnostic.location.file}:${diagnostic.location.line}:${diagnostic.location.column}: `
    : "";
  return `${location}[${diagnostic.code}] ${diagnostic.message}`;
}

/** Aggregate strict diagnostics without losing individual source locations. */
export class DatabricksOpenapiError extends Error {
  readonly diagnostics: ExtractionDiagnostic[];

  constructor(message: string, diagnostics: ExtractionDiagnostic[] = []) {
    const details = diagnostics.map(diagnosticText).join("\n");
    super(details ? `${message}\n${details}` : message);
    this.name = "DatabricksOpenapiError";
    this.diagnostics = diagnostics;
  }
}

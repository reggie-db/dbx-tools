import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { DATABRICKS_SDK_VERSION, databricksSdkInputsFromDependencies } from "./inputs.ts";
import {
  DatabricksOpenapiError,
  type DatabricksOpenapiConfig,
  type DatabricksSdkInput,
  type OperationOverride,
  type OverrideDocument,
  type ResolvedSdkInput,
} from "./types.ts";

function record(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DatabricksOpenapiError(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DatabricksOpenapiError(`${description} must be a non-empty string`);
  }
  return value;
}

function relativePath(packageRoot: string, value: string): string {
  return isAbsolute(value) ? value : resolve(packageRoot, value);
}

function parseInput(value: unknown, index: number): DatabricksSdkInput {
  const input = record(value, `databricksOpenapi.inputs[${index}]`);
  const output = text(input.output, `databricksOpenapi.inputs[${index}].output`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(output)) {
    throw new DatabricksOpenapiError(`Invalid OpenAPI output segment: ${output}`);
  }
  const expectedOperations = input.expectedOperations;
  if (
    expectedOperations !== undefined &&
    (!Number.isInteger(expectedOperations) || (expectedOperations as number) <= 0)
  ) {
    throw new DatabricksOpenapiError(
      `databricksOpenapi.inputs[${index}].expectedOperations must be a positive integer`,
    );
  }
  return {
    package: text(input.package, `databricksOpenapi.inputs[${index}].package`),
    output,
    expectedOperations: expectedOperations as number | undefined,
  };
}

/** Read and validate this package's generated databricksOpenapi manifest field. */
export function readDatabricksOpenapiConfig(packageJsonPath: string): {
  packageRoot: string;
  config: DatabricksOpenapiConfig;
} {
  const manifest = record(
    JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown,
    packageJsonPath,
  );
  const dbxToolsConfig = record(manifest.dbxToolsConfig, "package.json dbxToolsConfig");
  const raw = record(
    dbxToolsConfig.databricksOpenapi,
    "package.json dbxToolsConfig.databricksOpenapi",
  );
  const packageRoot = dirname(packageJsonPath);
  const dependencies = record(manifest.devDependencies ?? {}, "package.json devDependencies");
  const inputs = databricksSdkInputsFromDependencies(
    Object.fromEntries(
      Object.entries(dependencies).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  ).map((input, index) =>
    parseInput(
      {
        package: input.package,
        output: input.output,
      },
      index,
    ),
  );
  if (inputs.length === 0) {
    throw new DatabricksOpenapiError(
      "package.json devDependencies contains no modular Databricks API SDK packages",
    );
  }
  const outputs = new Set(inputs.map((input) => input.output));
  if (outputs.size !== inputs.length) {
    throw new DatabricksOpenapiError("databricksOpenapi.inputs contains duplicate outputs");
  }
  return {
    packageRoot,
    config: {
      inputs,
      overrides:
        raw.overrides === undefined
          ? undefined
          : text(raw.overrides, "databricksOpenapi.overrides"),
      rustOutputDirectory: relativePath(
        packageRoot,
        text(raw.rustOutputDirectory, "databricksOpenapi.rustOutputDirectory"),
      ),
      rustClientPath: relativePath(
        packageRoot,
        text(raw.rustClientPath, "databricksOpenapi.rustClientPath"),
      ),
      strict:
        raw.strict === undefined
          ? true
          : typeof raw.strict === "boolean"
            ? raw.strict
            : (() => {
                throw new DatabricksOpenapiError("databricksOpenapi.strict must be boolean");
              })(),
    },
  };
}

function packageRootFromEntrypoint(entrypoint: string, packageName: string): string {
  let directory = dirname(entrypoint);
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
      if (manifest.name === packageName) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new DatabricksOpenapiError(
    `Unable to derive package root for ${packageName} from its public v1 export`,
  );
}

function resolveVersionedEntrypoint(
  require: NodeRequire,
  packageName: string,
): { apiVersion: string; entrypoint: string } {
  for (const version of ["v1", "v2", "v3"]) {
    try {
      return {
        apiVersion: version,
        entrypoint: require.resolve(`${packageName}/${version}`),
      };
    } catch {
      continue;
    }
  }
  throw new DatabricksOpenapiError(`${packageName} has no supported public versioned export`);
}

/** Resolve an SDK only through its public versioned export. */
export function resolveSdkInput(
  input: DatabricksSdkInput,
  packageJsonPath: string,
): ResolvedSdkInput {
  const require = createRequire(packageJsonPath);
  const { apiVersion, entrypoint } = resolveVersionedEntrypoint(require, input.package);
  const packageRoot = packageRootFromEntrypoint(entrypoint, input.package);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  const packageVersion = text(manifest.version, `${input.package} package version`);
  if (packageVersion !== DATABRICKS_SDK_VERSION) {
    throw new DatabricksOpenapiError(
      `${input.package} resolved to ${packageVersion}; expected ${DATABRICKS_SDK_VERSION}`,
    );
  }
  const versionDirectory = dirname(entrypoint);
  const clientPath = join(versionDirectory, "client.js");
  const modelPath = join(versionDirectory, "model.js");
  const modelDeclarationPath = join(versionDirectory, "model.d.ts");
  for (const path of [clientPath, modelPath, modelDeclarationPath]) {
    if (!existsSync(path)) {
      throw new DatabricksOpenapiError(
        `${input.package} does not provide ${path.slice(versionDirectory.length + 1)} beside its versioned export`,
      );
    }
  }
  return {
    input,
    packageRoot,
    packageVersion,
    apiVersion,
    entrypoint,
    clientPath,
    modelPath,
    modelDeclarationPath,
  };
}

const OVERRIDE_KEYS = new Set([
  "reason",
  "source",
  "status",
  "requestMediaType",
  "responseMediaType",
  "rawResponse",
]);
const RAW_RESPONSES = new Set(["string", "binary", "object"]);

function parseOperationOverride(operationId: string, value: unknown): OperationOverride {
  const raw = record(value, `Override ${operationId}`);
  for (const key of Object.keys(raw)) {
    if (!OVERRIDE_KEYS.has(key)) {
      throw new DatabricksOpenapiError(`Override ${operationId} contains unsupported field ${key}`);
    }
  }
  const status =
    raw.status === undefined ? undefined : text(String(raw.status), `${operationId}.status`);
  if (status !== undefined && !/^[1-5][0-9]{2}$/.test(status)) {
    throw new DatabricksOpenapiError(`Override ${operationId} has invalid HTTP status ${status}`);
  }
  const rawResponse =
    raw.rawResponse === undefined ? undefined : text(raw.rawResponse, `${operationId}.rawResponse`);
  if (rawResponse !== undefined && !RAW_RESPONSES.has(rawResponse)) {
    throw new DatabricksOpenapiError(
      `Override ${operationId}.rawResponse must be string, binary, or object`,
    );
  }
  const override: OperationOverride = {
    reason: text(raw.reason, `${operationId}.reason`),
    source: text(raw.source, `${operationId}.source`),
    status,
    requestMediaType:
      raw.requestMediaType === undefined
        ? undefined
        : text(raw.requestMediaType, `${operationId}.requestMediaType`),
    responseMediaType:
      raw.responseMediaType === undefined
        ? undefined
        : text(raw.responseMediaType, `${operationId}.responseMediaType`),
    rawResponse: rawResponse as OperationOverride["rawResponse"],
  };
  if (
    override.status === undefined &&
    override.requestMediaType === undefined &&
    override.responseMediaType === undefined &&
    override.rawResponse === undefined
  ) {
    throw new DatabricksOpenapiError(`Override ${operationId} does not apply a correction`);
  }
  return override;
}

/** Parse the versioned YAML correction format and reject broad override fields. */
export function readOverrides(packageRoot: string, path?: string): OverrideDocument {
  if (!path) return { version: 1, operations: {} };
  const absolutePath = relativePath(packageRoot, path);
  const document = record(parseYaml(readFileSync(absolutePath, "utf8")), path);
  const keys = Object.keys(document);
  if (keys.some((key) => key !== "version" && key !== "operations")) {
    throw new DatabricksOpenapiError(`${path} contains unsupported top-level fields`);
  }
  if (document.version !== 1) {
    throw new DatabricksOpenapiError(`${path} must declare version: 1`);
  }
  const operations = record(document.operations ?? {}, `${path} operations`);
  return {
    version: 1,
    operations: Object.fromEntries(
      Object.entries(operations)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([operationId, value]) => [operationId, parseOperationOverride(operationId, value)]),
    ),
  };
}

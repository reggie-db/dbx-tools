import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { extractResolvedSdk } from "./ast.ts";
import { type ArtifactTools, writeOpenapiArtifacts } from "./artifacts.ts";
import { readDatabricksOpenapiConfig, readOverrides, resolveSdkInput } from "./config.ts";
import { applyOverrides } from "./overrides.ts";
import { renderOpenapi } from "./render.ts";

/** Optional seams for package-local focused tests. */
export interface GenerateDatabricksOpenapiOptions {
  packageJsonPath?: string;
  artifactTools?: ArtifactTools;
}

/** Generate every configured Databricks OpenAPI package as one atomic batch. */
export async function generateDatabricksOpenapi(
  options: GenerateDatabricksOpenapiOptions = {},
): Promise<string[]> {
  const packageJsonPath =
    options.packageJsonPath ?? fileURLToPath(new URL("../package.json", import.meta.url));
  const { packageRoot, config } = readDatabricksOpenapiConfig(packageJsonPath);
  const overrides = readOverrides(packageRoot, config.overrides);
  const irs = config.inputs.map((input) => {
    const resolved = resolveSdkInput(input, packageJsonPath);
    return extractResolvedSdk(resolved, config.strict);
  });
  applyOverrides(irs, overrides, config.strict);

  return writeOpenapiArtifacts(
    irs.map((ir, index) => {
      const output = config.inputs[index]?.output;
      if (!output) throw new Error("OpenAPI input and IR inventory diverged");
      return {
        output,
        document: renderOpenapi(ir),
        rustSpecPath: join(config.rustOutputDirectory, output, "openapi.json"),
      };
    }),
    config.rustClientPath,
    options.artifactTools,
  );
}

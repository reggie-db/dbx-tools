import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { object } from "@dbx-tools/shared-core";

/** Exact version shared by the modular Databricks SDK dependencies. */
export const DATABRICKS_SDK_VERSION = "0.49.0";

/** Installed support packages that do not represent API clients. */
export const DATABRICKS_SDK_EXCLUDES = new Set([
  "@databricks/sdk-auth",
  "@databricks/sdk-core",
  "@databricks/sdk-experimental",
  "@databricks/sdk-options",
]);

/** One dynamically discovered modular Databricks API input. */
export interface PinnedDatabricksSdkInput {
  readonly package: `@databricks/sdk-${string}`;
  readonly version: string;
  readonly output: string;
}

interface PackageManifest {
  readonly name?: unknown;
  readonly exports?: unknown;
}

function hasVersionedApiExport(manifest: PackageManifest): boolean {
  const packageExports = manifest.exports;
  return (
    object.isRecord(packageExports) &&
    ["./v1", "./v2", "./v3"].some((path) => Object.hasOwn(packageExports, path))
  );
}

function inputForPackage(packageName: `@databricks/sdk-${string}`): PinnedDatabricksSdkInput {
  const output = packageName.slice("@databricks/sdk-".length);
  return {
    package: packageName,
    version: DATABRICKS_SDK_VERSION,
    output,
  };
}

/** Derive generator inputs from pinned modular SDK dependency names. */
export function databricksSdkInputsFromDependencies(
  dependencies: Readonly<Record<string, string>>,
): readonly PinnedDatabricksSdkInput[] {
  return Object.keys(dependencies)
    .filter(
      (packageName): packageName is `@databricks/sdk-${string}` =>
        packageName.startsWith("@databricks/sdk-") && !DATABRICKS_SDK_EXCLUDES.has(packageName),
    )
    .map(inputForPackage)
    .sort((left, right) => left.package.localeCompare(right.package));
}

/** Discover installed modular API packages through their public versioned exports. */
export function discoverDatabricksSdkInputs(
  databricksNodeModules = fileURLToPath(
    new URL("../../../../../node_modules/@databricks", import.meta.url),
  ),
): readonly PinnedDatabricksSdkInput[] {
  return readdirSync(databricksNodeModules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("sdk-"))
    .flatMap((entry): PinnedDatabricksSdkInput[] => {
      const manifest = JSON.parse(
        readFileSync(join(databricksNodeModules, entry.name, "package.json"), "utf8"),
      ) as PackageManifest;
      if (
        typeof manifest.name !== "string" ||
        !manifest.name.startsWith("@databricks/sdk-") ||
        DATABRICKS_SDK_EXCLUDES.has(manifest.name) ||
        !hasVersionedApiExport(manifest)
      ) {
        return [];
      }
      return [inputForPackage(manifest.name as `@databricks/sdk-${string}`)];
    })
    .sort((left, right) => left.package.localeCompare(right.package));
}

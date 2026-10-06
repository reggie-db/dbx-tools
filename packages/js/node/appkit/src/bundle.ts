/**
 * Compatibility exports for Databricks bundle/app configuration.
 *
 * Configuration sources, file loading, flattening, resource references, and
 * name normalization live in `@dbx-tools/core`'s `config` module.
 *
 * @module
 */

import { profile as authProfile } from "@dbx-tools/auth";
import { configUtils } from "@dbx-tools/core";

/** Unstructured JSON result returned by Databricks bundle validation. */
export type BundleValidateJson = Record<string, unknown>;
/** Parsed AppKit or bundle configuration file. */
export type ConfigFile = configUtils.ConfigFile;
/** Scalar or structured value accepted by a generated configuration map. */
export type ConfigMapValue = configUtils.ConfigMapValue;
/** Named configuration layer consulted while resolving application values. */
export type ConfigSource = configUtils.ConfigSource;
/** Options controlling layered configuration lookup and bundle profile selection. */
export type ResolveConfigValueOptions = configUtils.ConfigOptions;

/** Schema for one Databricks App resource entry in bundle configuration. */
export const bundleAppResourceSchema = configUtils.bundleResourceSchema;
/** Flatten an `app.yaml` environment map into process-ready string values. */
export const flattenAppYamlEnv = configUtils.flattenAppEnv;
/** Flatten Databricks bundle application environment entries into string values. */
export const flattenAppEnv = configUtils.flattenBundleEnv;
/** Resolve the nearest Databricks bundle configuration path for a working directory. */
export const getBundlePath = configUtils.getBundlePath;

/** Load the active Databricks bundle configuration. */
export function bundle(cwd?: string, profile?: string): Promise<ConfigFile | undefined> {
  return Promise.resolve(configUtils.bundleFile(cwd, profile ?? resolvedProfile()));
}

/** Resolve a layered AppKit configuration value. */
export function resolveConfigValue(
  name: string,
  options: ResolveConfigValueOptions = {},
): Promise<string | undefined> {
  return Promise.resolve(
    configUtils.resolveValue(name, {
      ...options,
      bundleProfile: options.bundleProfile ?? resolvedProfile(),
    }),
  );
}

function resolvedProfile(): string | undefined {
  try {
    return authProfile.resolveProfile().name;
  } catch {
    return undefined;
  }
}

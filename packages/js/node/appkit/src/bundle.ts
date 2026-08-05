/**
 * Compatibility exports for Databricks bundle/app configuration.
 *
 * Configuration sources, file loading, flattening, resource references, and
 * name normalization live in `@dbx-tools/core`'s `config` module.
 *
 * @module
 */

import { config as coreConfig } from "@dbx-tools/core";

export type BundleValidateJson = Record<string, unknown>;
export type ConfigFile = coreConfig.ConfigFile;
export type ConfigMapValue = coreConfig.ConfigMapValue;
export type ConfigSource = coreConfig.ConfigSource;
export type ResolveConfigValueOptions = coreConfig.ConfigOptions;

export const bundleAppResourceSchema = coreConfig.bundleResourceSchema;
export const flattenAppYamlEnv = coreConfig.flattenAppEnv;
export const flattenAppEnv = coreConfig.flattenBundleEnv;
export const getBundlePath = coreConfig.getBundlePath;

export function bundle(cwd?: string): Promise<ConfigFile | undefined> {
  return Promise.resolve(coreConfig.bundleFile(cwd));
}

export function resolveConfigValue(
  name: string,
  options: ResolveConfigValueOptions = {},
): Promise<string | undefined> {
  return Promise.resolve(coreConfig.resolveValue(name, options));
}

/**
 * Compatibility exports for Databricks bundle/app configuration.
 *
 * Configuration sources, file loading, flattening, resource references, and
 * name normalization live in `@dbx-tools/core`'s `config` module.
 *
 * @module
 */

import { configUtils } from "@dbx-tools/core";

export type BundleValidateJson = Record<string, unknown>;
export type ConfigFile = configUtils.ConfigFile;
export type ConfigMapValue = configUtils.ConfigMapValue;
export type ConfigSource = configUtils.ConfigSource;
export type ResolveConfigValueOptions = configUtils.ConfigOptions;

export const bundleAppResourceSchema = configUtils.bundleResourceSchema;
export const flattenAppYamlEnv = configUtils.flattenAppEnv;
export const flattenAppEnv = configUtils.flattenBundleEnv;
export const getBundlePath = configUtils.getBundlePath;

export function bundle(cwd?: string): Promise<ConfigFile | undefined> {
  return Promise.resolve(configUtils.bundleFile(cwd));
}

export function resolveConfigValue(
  name: string,
  options: ResolveConfigValueOptions = {},
): Promise<string | undefined> {
  return Promise.resolve(configUtils.resolveValue(name, options));
}

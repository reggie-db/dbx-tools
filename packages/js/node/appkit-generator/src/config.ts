/**
 * AppKit generator-plugin configuration and environment resolution.
 *
 * @module
 */

import type { BasePluginConfig } from "@databricks/appkit";
import { text, ENV_ONLY, positiveInt } from "@dbx-tools/core";
import { trimToNull } from "@dbx-tools/shared-core";
import manifest from "./manifest.json" with { type: "json" };
import {
  DEFAULT_MAX_SOURCES,
  DEFAULT_SOURCE_MAX_LENGTH,
  MAX_SOURCES,
  MAX_SOURCE_MAX_LENGTH,
} from "./research.ts";

/** Default ceiling for one complete generator operation. */
export const DEFAULT_GENERATOR_TIMEOUT_MS = 240_000;

/** AppKit configuration accepted by the generator plugin. */
export interface GeneratorPluginConfig extends BasePluginConfig {
  /** Model endpoint or loose model name used for structured synthesis. */
  model?: string;
  /** Maximum cited pages fetched per research operation. */
  maxSources?: number;
  /** Maximum readable characters retained from each fetched page. */
  sourceMaxLength?: number;
  /** Overall operation timeout in milliseconds. */
  timeoutMs?: number;
  /** Unity Catalog containing all generated per-user schemas. */
  catalog?: string;
  /** SQL warehouse used for data generation and validation. */
  warehouseId?: string;
}

/** Fully resolved generator configuration. */
export interface ResolvedGeneratorConfig {
  /** Optional pinned synthesis model. */
  model?: string;
  /** Bounded cited-page count. */
  maxSources: number;
  /** Character cap per fetched source. */
  sourceMaxLength: number;
  /** Overall operation timeout in milliseconds. */
  timeoutMs: number;
  /** Unity Catalog containing generated schemas, when configured. */
  catalog?: string;
  /** SQL warehouse used for mutations, when configured. */
  warehouseId?: string;
}

/** JSON Schema published by the generator plugin manifest. */
export const GENERATOR_CONFIG_SCHEMA = manifest.config.schema;

/** Resolve explicit plugin values over environment values and defaults. */
export function resolveGeneratorConfig(
  config: GeneratorPluginConfig = {},
): ResolvedGeneratorConfig {
  const model = trimToNull(config.model) ?? text("GENERATOR_MODEL", ENV_ONLY);
  const catalog = trimToNull(config.catalog) ?? text("GENERATOR_CATALOG", ENV_ONLY);
  const warehouseId = trimToNull(config.warehouseId) ?? text("DATABRICKS_WAREHOUSE_ID", ENV_ONLY);
  return {
    ...(model ? { model } : {}),
    ...(catalog ? { catalog } : {}),
    ...(warehouseId ? { warehouseId } : {}),
    maxSources: Math.min(
      positiveInt(config.maxSources, "GENERATOR_MAX_SOURCES", DEFAULT_MAX_SOURCES, ENV_ONLY),
      MAX_SOURCES,
    ),
    sourceMaxLength: Math.min(
      positiveInt(
        config.sourceMaxLength,
        "GENERATOR_SOURCE_MAX_LENGTH",
        DEFAULT_SOURCE_MAX_LENGTH,
        ENV_ONLY,
      ),
      MAX_SOURCE_MAX_LENGTH,
    ),
    timeoutMs: positiveInt(
      config.timeoutMs,
      "GENERATOR_TIMEOUT_MS",
      DEFAULT_GENERATOR_TIMEOUT_MS,
      ENV_ONLY,
    ),
  };
}

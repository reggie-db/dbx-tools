/**
 * AppKit integration for the shared Graphiti option contract.
 *
 * `@dbx-tools/graphiti` composes Graphiti and subnamed FalkorDB option fields.
 * This module adds only the AppKit-specific automatic port allocation sentinel.
 *
 * @module
 */
import type { BasePluginConfig } from "@databricks/appkit";
import {
  GraphitiOptionsSchema,
  graphitiOptionsFromEnvironment,
  type GraphitiOptions,
  type ResolvedGraphitiOptions,
} from "@dbx-tools/graphiti/options";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";

/** Shared Graphiti options accepted by the AppKit plugin. */
export type GraphitiPluginConfig = BasePluginConfig & GraphitiOptions;

/** Shared Graphiti options after AppKit allocates its sidecar ports. */
export type ResolvedGraphitiPluginConfig = BasePluginConfig & ResolvedGraphitiOptions;

/** AppKit manifest schema generated from the owning shared Zod schema. */
export const GRAPHITI_CONFIG_SCHEMA = z.toJSONSchema(GraphitiOptionsSchema) as JSONSchema7;

/** Merge explicit plugin config over shared environment names. */
export function resolveGraphitiConfig(
  config: GraphitiPluginConfig = {},
): ResolvedGraphitiPluginConfig {
  const environment = graphitiOptionsFromEnvironment(process.env);
  const resolved = GraphitiOptionsSchema.parse({
    ...environment,
    ...config,
    listen: config.listen ?? environment.listen ?? { scheme: "tcp", host: "127.0.0.1", port: 0 },
  });
  return resolved as ResolvedGraphitiPluginConfig;
}

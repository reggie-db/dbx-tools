/**
 * AppKit integration for the shared Graphiti option contract.
 *
 * `@dbx-tools/shared-graphiti` owns option fields, validation, defaults, and
 * environment names. This module adds only AppKit-specific automatic port
 * allocation sentinels.
 *
 * @module
 */
import type { BasePluginConfig } from "@databricks/appkit";
import {
  GraphitiOptionsSchema,
  graphitiOptionsFromEnvironment,
  type GraphitiOptions,
  type ResolvedGraphitiOptions,
} from "@dbx-tools/shared-graphiti";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";

/** Shared Graphiti options accepted by the AppKit plugin. */
export type GraphitiPluginConfig = BasePluginConfig & GraphitiOptions;

/** Shared Graphiti options after AppKit allocates its sidecar ports. */
export type ResolvedGraphitiPluginConfig = BasePluginConfig & ResolvedGraphitiOptions;

/** AppKit manifest schema generated from the owning shared Zod schema. */
export const GRAPHITI_CONFIG_SCHEMA = z.toJSONSchema(GraphitiOptionsSchema) as JSONSchema7;

/** Merge explicit plugin config over shared environment names. */
export function resolveGraphitiConfig(config: GraphitiPluginConfig = {}): GraphitiOptions {
  const environment = graphitiOptionsFromEnvironment(process.env);
  const resolved = GraphitiOptionsSchema.parse({
    ...environment,
    ...config,
    graphitiPort: config.graphitiPort ?? environment.graphitiPort ?? 0,
    modelGatewayPort: config.modelGatewayPort ?? environment.modelGatewayPort ?? 0,
  });
  const ports = [resolved.graphitiPort, resolved.modelGatewayPort].filter(Boolean);
  if (new Set(ports).size !== ports.length) {
    throw new Error("Graphiti sidecar ports must be distinct");
  }
  return resolved;
}

/**
 * AppKit integration for the shared Graphiti option contract.
 *
 * `@dbx-tools/shared-graphiti` owns the complete option contract. This module
 * adds only the AppKit-specific automatic port allocation sentinel.
 *
 * @module
 */
import type { BasePluginConfig } from "@databricks/appkit";
import { profile as authProfile } from "@dbx-tools/auth";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";

import {
  GraphitiOptionsSchema,
  graphitiOptionOverrides,
  graphitiOptionsFromEnvironment,
  resolveGraphitiOptions,
  type GraphitiOptions,
  type ResolvedGraphitiOptions,
} from "../options.ts";

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
  if (environment.profile && !authProfile.resolveProfile({ profile: environment.profile })) {
    environment.profile = undefined;
  }
  const overrides = graphitiOptionOverrides(config);
  const resolved = resolveGraphitiOptions({
    ...environment,
    ...overrides,
    listen: overrides.listen ??
      environment.listen ?? {
        scheme: "tcp",
        host: "127.0.0.1",
        port: 0,
      },
  });
  return { ...config, ...resolved } as ResolvedGraphitiPluginConfig;
}

/**
 * Complete option contract for the Node Graphiti runtime.
 *
 * Graphiti owns its model and HTTP listener fields. FalkorDB fields are
 * namespaced from the owning FalkorDB schema so CLI flags become `--falkor-*`
 * without maintaining a parallel database configuration.
 *
 * @module
 */

import { FalkorDBOptionsSchema } from "@dbx-tools/falkor-db/options";
import { options } from "@dbx-tools/shared-core";
import { GraphitiOptionsSchema as SharedGraphitiOptionsSchema } from "@dbx-tools/shared-graphiti";
import { z } from "zod";

const namespacedFalkor = options.namespaceOpts(FalkorDBOptionsSchema, "falkor");

export const GraphitiOptionsSchema = SharedGraphitiOptionsSchema.extend(namespacedFalkor.shape)
  .extend({
    falkorListen: FalkorDBOptionsSchema.shape.listen
      .default({ scheme: "tcp", host: "127.0.0.1", port: 6379 })
      .describe("FalkorDB listener used by Graphiti.")
      .meta({ env: "FALKORDB_LISTEN" }),
    falkorProfile: FalkorDBOptionsSchema.shape.profile.meta({
      env: "FALKORDB_PROFILE",
      helpDefault: false,
    }),
  })
  .strict()
  .describe("Options accepted by the Node Graphiti runtime.");

export const GraphitiCliOptionsSchema = GraphitiOptionsSchema.describe(
  "Graphiti options represented as Commander flags.",
);

export type GraphitiOptions = z.input<typeof GraphitiOptionsSchema>;
export const ResolvedGraphitiOptionsSchema = GraphitiOptionsSchema.describe(
  "Graphiti options after Graphiti and FalkorDB defaults are resolved.",
);
export type ResolvedGraphitiOptions = z.output<typeof ResolvedGraphitiOptionsSchema>;

/** Defaults resolved from the composed Graphiti and FalkorDB schemas. */
export const GRAPHITI_DEFAULTS = Object.freeze(GraphitiOptionsSchema.parse({}));

const graphitiOptionKeys = Object.keys(GraphitiOptionsSchema.shape) as Array<
  keyof typeof GRAPHITI_DEFAULTS
>;

/** Keep only explicitly supplied Graphiti fields and validate their values. */
export function graphitiOptionOverrides(value: unknown): GraphitiOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Graphiti options must be an object");
  }
  const source = value as Readonly<Record<string, unknown>>;
  const keys = graphitiOptionKeys.filter((key) => source[key] !== undefined);
  const parsed = GraphitiOptionsSchema.parse(
    Object.fromEntries(keys.map((key) => [key, source[key]])),
  );
  return Object.fromEntries(keys.map((key) => [key, parsed[key]])) as GraphitiOptions;
}

/** Resolve Graphiti and namespaced FalkorDB defaults. */
export function resolveGraphitiOptions(value: GraphitiOptions = {}): ResolvedGraphitiOptions {
  return ResolvedGraphitiOptionsSchema.parse(value);
}

/** Parse explicit environment entries through the complete runtime schema. */
export function graphitiOptionsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): GraphitiOptions {
  return options.parseOpts(GraphitiOptionsSchema, null, environment);
}

/** Serialize the complete runtime configuration for the managed process. */
export function graphitiOptionsEnvironment(
  value: GraphitiOptions = {},
): Readonly<Record<string, string>> {
  return options.serializeOptsEnvironment(GraphitiOptionsSchema, value);
}

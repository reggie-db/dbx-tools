/**
 * Graphiti CLI option surface.
 *
 * The Node Graphiti runtime composes Graphiti-owned fields with namespaced
 * FalkorDB-owned fields. This module exposes that exact surface without
 * creating parallel CLI policy.
 *
 * @module
 */

export {
  GRAPHITI_DEFAULTS,
  GraphitiCliOptionsSchema,
  GraphitiOptionsSchema,
  ResolvedGraphitiOptionsSchema,
  graphitiOptionOverrides,
  graphitiOptionsEnvironment,
  graphitiOptionsFromEnvironment,
  resolveGraphitiOptions,
} from "@dbx-tools/graphiti/options";
export type { GraphitiOptions, ResolvedGraphitiOptions } from "@dbx-tools/graphiti/options";

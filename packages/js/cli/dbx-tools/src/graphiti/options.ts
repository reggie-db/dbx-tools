/**
 * Graphiti CLI option surface.
 *
 * The Node Graphiti runtime owns the complete shared option contract. This
 * module re-exports that surface without creating parallel CLI policy.
 *
 * @module
 */

import { options } from "@dbx-tools/appkit-memory/graphiti";

/** Graphiti defaults derived from the shared owning schema. */
export const GRAPHITI_DEFAULTS = options.GRAPHITI_DEFAULTS;

/** Graphiti options represented as Commander flags. */
export const GraphitiCliOptionsSchema = options.GraphitiCliOptionsSchema;

/** Shared Graphiti option schema used by the CLI runtime. */
export const GraphitiOptionsSchema = options.GraphitiOptionsSchema;

/** Schema for Graphiti options after defaults are resolved. */
export const ResolvedGraphitiOptionsSchema = options.ResolvedGraphitiOptionsSchema;

/** Keep only explicitly supplied Graphiti fields and validate their values. */
export const graphitiOptionOverrides = options.graphitiOptionOverrides;

/** Serialize Graphiti options into the Python runtime environment. */
export const graphitiOptionsEnvironment = options.graphitiOptionsEnvironment;

/** Parse Graphiti option overrides from an environment record. */
export const graphitiOptionsFromEnvironment = options.graphitiOptionsFromEnvironment;

/** Apply shared defaults and validate Graphiti runtime invariants. */
export const resolveGraphitiOptions = options.resolveGraphitiOptions;

/** Graphiti option inputs accepted by the CLI. */
export type GraphitiOptions = options.GraphitiOptions;

/** Graphiti options after shared defaults are resolved. */
export type ResolvedGraphitiOptions = options.ResolvedGraphitiOptions;

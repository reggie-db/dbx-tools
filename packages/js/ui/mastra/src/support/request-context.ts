import { object, type SerializableValue } from "@dbx-tools/shared-core";
import type { RequestContext } from "@mastra/client-js";

/** Typed plain values or Mastra's native typed request-context container. */
export type MastraRequestContextInput<TValues extends Record<string, unknown>> =
  TValues | RequestContext<TValues>;

/** Static context or a per-turn resolver read when the user submits. */
export type MastraRequestContextSource<TValues extends Record<string, unknown>> =
  MastraRequestContextInput<TValues> | (() => MastraRequestContextInput<TValues> | undefined);

/** JSON-safe immutable snapshot retained for one run and its continuation. */
export type MastraRequestContextSnapshot = Record<string, SerializableValue>;

/**
 * Materialize and validate one run's application context. Infrastructure keys
 * remain server-owned; this only snapshots caller-provided JSON values.
 */
export function snapshotRequestContext<TValues extends Record<string, unknown>>(
  source: MastraRequestContextSource<TValues> | undefined,
): MastraRequestContextSnapshot | undefined {
  const input = typeof source === "function" ? source() : source;
  if (input === undefined) return undefined;
  const candidate =
    "toJSON" in input && typeof input.toJSON === "function" ? input.toJSON() : input;
  if (!object.isRecord(candidate) || !object.isSerializableValue(candidate)) {
    throw new TypeError("Mastra request context must be a JSON-serializable record");
  }
  return structuredClone(candidate) as MastraRequestContextSnapshot;
}

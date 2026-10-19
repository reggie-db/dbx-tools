import { RequestContext } from "@mastra/client-js";

/** Typed plain values or Mastra's native typed request-context container. */
export type MastraRequestContextInput<TValues extends Record<string, unknown>> =
  TValues | RequestContext<TValues>;

/** Static context or a per-turn resolver read when the user submits. */
export type MastraRequestContextSource<TValues extends Record<string, unknown>> =
  MastraRequestContextInput<TValues> | (() => MastraRequestContextInput<TValues> | undefined);

/**
 * Materialize one run's application context through Mastra's native container
 * and serialization policy.
 */
export function snapshotRequestContext<TValues extends Record<string, unknown>>(
  source: MastraRequestContextSource<TValues> | undefined,
): RequestContext | undefined {
  const input = typeof source === "function" ? source() : source;
  if (input === undefined) return undefined;
  const context =
    input instanceof RequestContext ? input : new RequestContext<unknown>(Object.entries(input));
  return new RequestContext<unknown>(Object.entries(structuredClone(context.toJSON())));
}

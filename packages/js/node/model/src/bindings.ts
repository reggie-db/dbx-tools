/**
 * Binding-safe facade for Databricks model discovery and routing.
 *
 * Generated language bindings should target this module instead of binding the
 * full model package. It exposes plain TypeScript records while delegating all
 * authentication, catalogue caching, fuzzy matching, policy, and URL selection
 * to {@link createModelClient}.
 *
 * @module
 */

import type { ModelClass, ModelMetadata } from "@dbx-tools/shared-model/contracts";
import { createModelClient, type ModelProtocol } from "./model-client.ts";

/** Binding-friendly fuzzy model route request. */
export interface ResolveModelRouteOptions {
  readonly profile?: string;
  readonly model?: string;
  readonly fuzzy?: boolean;
  readonly threshold?: number;
  readonly requiresTools?: boolean;
  readonly modelClass?: ModelClass;
  readonly fallbacks?: readonly string[];
  readonly liveOnly?: boolean;
  readonly protocol?: ModelProtocol;
  readonly refresh?: boolean;
  readonly login?: boolean;
}

/** Binding-friendly model endpoint metadata used by Graphiti and other runtimes. */
export interface ResolvedModelRoute {
  readonly modelId: string;
  readonly endpointName?: string;
  readonly endpointTask?: string;
  readonly endpointDimension?: number;
  readonly source: "explicit" | "fuzzy-match" | "class" | "fallback";
  readonly protocol: ModelProtocol;
  readonly host: string;
  readonly apiBase: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly metadata: ModelMetadata;
}

/** Resolve one fuzzy model request through the canonical Node model client. */
export async function resolveModelRoute(
  options: ResolveModelRouteOptions = {},
): Promise<ResolvedModelRoute> {
  const client = await createModelClient({
    ...(options.profile ? { auth: { profile: options.profile } } : {}),
  });
  const route = await client.route({
    ...(options.model ? { explicit: options.model } : {}),
    ...(options.fuzzy === undefined ? {} : { fuzzy: options.fuzzy }),
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    ...(options.requiresTools === undefined ? {} : { requiresTools: options.requiresTools }),
    ...(options.modelClass ? { modelClass: options.modelClass } : {}),
    ...(options.fallbacks ? { fallbacks: [...options.fallbacks] } : {}),
    ...(options.liveOnly === undefined ? {} : { liveOnly: options.liveOnly }),
    ...(options.protocol ? { protocol: options.protocol } : {}),
    ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
    ...(options.login === undefined ? {} : { login: options.login }),
  });
  return {
    modelId: route.modelId,
    ...(route.endpoint?.name ? { endpointName: route.endpoint.name } : {}),
    ...(route.endpoint?.task ? { endpointTask: route.endpoint.task } : {}),
    ...(route.endpoint?.dimension ? { endpointDimension: route.endpoint.dimension } : {}),
    source: route.source,
    protocol: route.protocol,
    host: route.host,
    apiBase: route.apiBase,
    url: route.url,
    headers: { ...route.headers },
    metadata: route.metadata,
  };
}

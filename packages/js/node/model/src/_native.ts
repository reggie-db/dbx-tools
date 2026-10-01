import {
  ModelClass as NativeModelClass,
  rankModels as rankModelsWithRust,
  type ModelQuery as NativeModelQuery,
  type ServingEndpointSummary as NativeServingEndpointSummary,
} from "@dbx-tools/model-rs";
import {
  model,
  type ModelQuery,
  type RankedModel,
  type ServingEndpointSummary,
} from "@dbx-tools/shared-model";

type ModelClass = model.ModelClass;

const MODEL_CLASS_TO_NATIVE: Readonly<Record<ModelClass, NativeModelClass>> = {
  [model.ModelClass.ChatThinking]: NativeModelClass.ChatThinking,
  [model.ModelClass.ChatBalanced]: NativeModelClass.ChatBalanced,
  [model.ModelClass.ChatFast]: NativeModelClass.ChatFast,
  [model.ModelClass.Embedding]: NativeModelClass.Embedding,
};

interface NativeRankingOptions {
  readonly includeDeprecated?: boolean;
  readonly modelClass?: ModelClass;
  readonly task?: string;
}

/** Rank public endpoint records through the Rust-owned model policy. */
export function rankEndpointsWithRust(
  endpoints: readonly ServingEndpointSummary[],
  query: ModelQuery = {},
  options: NativeRankingOptions = {},
): RankedModel[] {
  const endpointsByName = new Map(endpoints.map((endpoint) => [endpoint.name, endpoint]));
  return rankModelsWithRust(
    endpoints.map((endpoint) => toNativeEndpoint(endpoint, options)),
    toNativeQuery(query, options.includeDeprecated ?? false),
  ).map((ranked) => {
    const endpoint = endpointsByName.get(ranked.endpoint.name);
    if (!endpoint) {
      throw new Error(`Rust model ranking returned unknown endpoint "${ranked.endpoint.name}"`);
    }
    return {
      endpoint,
      modelClass: fromNativeClass(ranked.modelClass),
      ...(ranked.score !== undefined ? { score: ranked.score } : {}),
    };
  });
}

function toNativeQuery(query: ModelQuery, includeDeprecated: boolean): NativeModelQuery {
  return {
    search: query.search,
    modelClass:
      query.modelClass === undefined ? undefined : MODEL_CLASS_TO_NATIVE[query.modelClass],
    requiresTools: query.requiresTools ?? false,
    includeDeprecated,
    limit: query.limit,
    threshold: query.threshold,
  };
}

function toNativeEndpoint(
  endpoint: ServingEndpointSummary,
  options: NativeRankingOptions,
): NativeServingEndpointSummary {
  const modelClass = options.modelClass ?? endpoint.class;
  return {
    name: endpoint.name,
    displayName: endpoint.displayName,
    task: options.task ?? endpoint.task,
    state: endpoint.state,
    description: endpoint.description,
    supportsTools: endpoint.supportsTools,
    profile: endpoint.profile,
    modelClass: modelClass === undefined ? undefined : MODEL_CLASS_TO_NATIVE[modelClass],
    serviceNames: new Map(Object.entries(endpoint.serviceNames ?? {})),
    modelServiceName: endpoint.modelServiceName,
    reasoningEfforts: [],
    status: { deprecated: endpoint.status?.deprecated ?? false },
  };
}

function fromNativeClass(modelClass: NativeModelClass): ModelClass {
  switch (modelClass) {
    case NativeModelClass.ChatThinking:
      return model.ModelClass.ChatThinking;
    case NativeModelClass.ChatBalanced:
      return model.ModelClass.ChatBalanced;
    case NativeModelClass.ChatFast:
      return model.ModelClass.ChatFast;
    case NativeModelClass.Embedding:
      return model.ModelClass.Embedding;
  }
}

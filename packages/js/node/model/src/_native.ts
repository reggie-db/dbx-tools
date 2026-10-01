import {
  ModelClass as NativeModelClass,
  ReasoningEffort as NativeReasoningEffort,
  normalizeServingEndpointsJson,
  rankModels as rankModelsWithRust,
  type ModelQuery as NativeModelQuery,
  type ServingEndpointSummary as NativeServingEndpointSummary,
} from "@dbx-tools/model-rs";
import {
  model,
  type ModelQuery,
  type RankedModel,
  type ReasoningEffort,
  type ServingEndpointSummary,
} from "@dbx-tools/shared-model";

type ModelClass = model.ModelClass;

const MODEL_CLASS_TO_NATIVE: Readonly<Record<ModelClass, NativeModelClass>> = {
  [model.ModelClass.ChatThinking]: NativeModelClass.ChatThinking,
  [model.ModelClass.ChatBalanced]: NativeModelClass.ChatBalanced,
  [model.ModelClass.ChatFast]: NativeModelClass.ChatFast,
  [model.ModelClass.Embedding]: NativeModelClass.Embedding,
};

const REASONING_EFFORT_TO_NATIVE: Readonly<Record<string, NativeReasoningEffort>> = {
  none: NativeReasoningEffort.None,
  minimal: NativeReasoningEffort.Minimal,
  low: NativeReasoningEffort.Low,
  medium: NativeReasoningEffort.Medium,
  high: NativeReasoningEffort.High,
  xhigh: NativeReasoningEffort.Xhigh,
  max: NativeReasoningEffort.Max,
};

const REASONING_EFFORT_FROM_NATIVE: Readonly<Record<NativeReasoningEffort, ReasoningEffort>> = {
  [NativeReasoningEffort.None]: "none",
  [NativeReasoningEffort.Minimal]: "minimal",
  [NativeReasoningEffort.Low]: "low",
  [NativeReasoningEffort.Medium]: "medium",
  [NativeReasoningEffort.High]: "high",
  [NativeReasoningEffort.Xhigh]: "xhigh",
  [NativeReasoningEffort.Max]: "max",
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

/** Classify chat and embedding endpoints through the Rust-owned policy. */
export function classifyEndpointClassesWithRust(
  endpoints: readonly ServingEndpointSummary[],
): ReadonlyMap<string, ModelClass> {
  const chat = rankEndpointsWithRust(endpoints, {}, { includeDeprecated: true });
  const embeddings = rankEndpointsWithRust(
    endpoints,
    { modelClass: model.ModelClass.Embedding },
    { includeDeprecated: true },
  );
  return new Map(
    [...chat, ...embeddings].map((ranked) => [ranked.endpoint.name, ranked.modelClass]),
  );
}

/** Normalize serialized SDK endpoint records through the Rust-owned catalogue policy. */
export function normalizeEndpointsWithRust(endpoints: readonly unknown[]): ServingEndpointSummary[] {
  return normalizeServingEndpointsJson(JSON.stringify({ endpoints })).map(fromNativeEndpoint);
}

function toNativeQuery(query: ModelQuery, includeDeprecated: boolean): NativeModelQuery {
  return {
    search: query.search,
    modelClass:
      query.modelClass === undefined ? undefined : MODEL_CLASS_TO_NATIVE[query.modelClass],
    requiresTools: query.requiresTools,
    includeDeprecated: includeDeprecated || undefined,
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
    family: endpoint.family,
    task: options.task ?? endpoint.task,
    state: endpoint.state,
    description: endpoint.description,
    supportsTools: endpoint.supportsTools,
    profile: endpoint.profile,
    modelClass: modelClass === undefined ? undefined : MODEL_CLASS_TO_NATIVE[modelClass],
    serviceNames: new Map(Object.entries(endpoint.serviceNames ?? {})),
    modelServiceName: endpoint.modelServiceName,
    reasoningEfforts: (endpoint.reasoningEfforts ?? []).map((effort) => {
      const native = REASONING_EFFORT_TO_NATIVE[effort];
      if (native === undefined) throw new Error(`Unknown reasoning effort "${effort}"`);
      return native;
    }),
    status: { deprecated: endpoint.status?.deprecated ?? false },
    dimension: endpoint.dimension,
  };
}

function fromNativeEndpoint(endpoint: NativeServingEndpointSummary): ServingEndpointSummary {
  return {
    name: endpoint.name,
    ...(endpoint.displayName !== undefined ? { displayName: endpoint.displayName } : {}),
    ...(endpoint.family !== undefined ? { family: endpoint.family } : {}),
    ...(endpoint.task !== undefined ? { task: endpoint.task } : {}),
    ...(endpoint.state !== undefined ? { state: endpoint.state } : {}),
    ...(endpoint.description !== undefined ? { description: endpoint.description } : {}),
    ...(endpoint.supportsTools !== undefined ? { supportsTools: endpoint.supportsTools } : {}),
    ...(endpoint.profile !== undefined ? { profile: endpoint.profile } : {}),
    ...(endpoint.modelClass !== undefined ? { class: fromNativeClass(endpoint.modelClass) } : {}),
    ...(endpoint.serviceNames.size > 0
      ? { serviceNames: Object.fromEntries(endpoint.serviceNames) }
      : {}),
    ...(endpoint.modelServiceName !== undefined
      ? { modelServiceName: endpoint.modelServiceName }
      : {}),
    ...(endpoint.reasoningEfforts.length > 0
      ? {
          reasoningEfforts: endpoint.reasoningEfforts.map(
            (effort) => REASONING_EFFORT_FROM_NATIVE[effort],
          ),
        }
      : {}),
    status: { deprecated: endpoint.status.deprecated },
    ...(endpoint.dimension !== undefined ? { dimension: endpoint.dimension } : {}),
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

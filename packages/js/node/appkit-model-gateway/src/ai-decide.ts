/**
 * Databricks AI Functions `ai_decide` model selection.
 *
 * @module
 */

import { getExecutionContext, type WorkspaceClient } from "@databricks/appkit";
import { closeCache, createCache, getOrSet } from "@dbx-tools/cache";
import { refreshWorkspaceClientAuthentication } from "@dbx-tools/databricks";
import { endpointCapabilities, selection, versionTuple } from "@dbx-tools/model";
import { isRecord, log, toError } from "@dbx-tools/shared-core";
import type { ServingEndpointSummary } from "@dbx-tools/shared-model";
import {
  AiDecideModelFiltersSchema,
  AiDecideObservationSchema,
  AiDecideStrategySchema,
  type AiDecideModelFilters,
  type AiDecideObservation,
  type AiDecideStrategy,
  type ResolvedAiDecideModelFilters,
} from "@dbx-tools/shared-model-gateway";
import { z } from "zod";

import {
  AppKitSmartRouterProbeStore,
  SmartRouterContextBuilder,
  SmartRouterProbeRecordSchema,
  type SmartRouterProbeRecord,
  type SmartRouterProbeStore,
} from "./smart-router.ts";

const AI_DECIDE_PATH = "/api/2.0/ai-functions/ai-decide";
const DEFAULT_TIMEOUT_MS = 10_000;
const PROBE_KEY = "ai-decide-v1";
const POSITIVE_PROBE_TTL_MS = 5 * 60_000;
const NEGATIVE_PROBE_TTL_MS = 30_000;
const PROBE_CACHE_TTL_MS = POSITIVE_PROBE_TTL_MS * 2;
const logger = log.logger("appkit/model-gateway/ai-decide");

const AiDecideChoiceAnswerSchema = z
  .object({
    type: z.literal("choice"),
    choice: z.string().trim().min(1),
    probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .passthrough();

const AiDecideResponseSchema = z
  .object({
    response: z
      .object({
        answers: z.object({ model: AiDecideChoiceAnswerSchema }).passthrough(),
      })
      .passthrough(),
    metadata: z.object({ version: z.string() }).passthrough().optional(),
  })
  .passthrough();

/** Selection policy accepted by {@link AiDecideRouterService.select}. */
export interface AiDecideSelectionOptions {
  readonly strategy?: AiDecideStrategy;
  readonly filters?: AiDecideModelFilters;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Concrete endpoint and observable decision returned by `ai_decide`. */
export interface AiDecideSelection {
  readonly endpoint: ServingEndpointSummary;
  readonly observation: AiDecideObservation;
}

type AiDecideInvoker = (
  client: WorkspaceClient,
  body: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  timeoutMs: number,
) => Promise<unknown>;

type AiDecideProbeCache = ReturnType<typeof createCache>;

/** Select the best sufficient live foundation model through Databricks `ai_decide`. */
export class AiDecideRouterService {
  private readonly context = new SmartRouterContextBuilder();
  private readonly probes = new WeakMap<object, AiDecideProbeCache>();
  private readonly probeCaches = new Set<AiDecideProbeCache>();

  constructor(
    private readonly invoke: AiDecideInvoker = invokeAiDecide,
    private readonly probeStore: SmartRouterProbeStore = new AppKitSmartRouterProbeStore(),
  ) {}

  async select(
    input: unknown,
    endpoints: readonly ServingEndpointSummary[],
    client: WorkspaceClient | undefined = undefined,
    options: AiDecideSelectionOptions = {},
  ): Promise<AiDecideSelection> {
    const workspaceClient = client ?? getExecutionContext().client;
    const strategy = AiDecideStrategySchema.parse(options.strategy ?? "balanced");
    const filters = AiDecideModelFiltersSchema.parse(options.filters ?? {});
    const candidates = modelCandidates(endpoints, filters);
    if (candidates.length === 0) {
      throw new AiDecideRouterError(400, "No eligible foundation models are available");
    }
    if (candidates.length === 1) {
      const [endpoint] = candidates;
      return {
        endpoint: endpoint!,
        observation: AiDecideObservationSchema.parse({
          selectedModel: endpoint!.name,
          strategy,
          confidence: 1,
          probabilities: { [endpoint!.name]: 1 },
          latencyMs: 0,
        }),
      };
    }
    const task = await this.context.build(input);
    if (!task) throw new AiDecideRouterError(400, "ai_decide input contains no routable text");
    const labels = new Map(candidates.map((endpoint, index) => [`model_${index + 1}`, endpoint]));
    const criteria = Object.fromEntries(
      [...labels].map(([label, endpoint], index) => [
        label,
        candidateDescription(endpoint, index + 1),
      ]),
    );
    const body = {
      state: {
        task,
        strategy,
        candidates: candidates.map((endpoint, index) => candidateState(endpoint, index + 1)),
      },
      questions: {
        model: {
          type: "choice",
          instructions: strategyInstructions(strategy),
          criteria,
        },
      },
      options: { version: "1.0" },
    } as const;
    const startedAt = performance.now();
    const signal = options.signal ?? new AbortController().signal;
    let response: z.infer<typeof AiDecideResponseSchema>;
    try {
      response = AiDecideResponseSchema.parse(
        await this.invoke(workspaceClient, body, signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      );
      this.setProbeValue(workspaceClient, true);
    } catch (error) {
      this.setProbeValue(workspaceClient, false);
      throw error;
    }
    const answer = response.response.answers.model;
    const selected = labels.get(answer.choice);
    if (!selected) {
      throw new AiDecideRouterError(502, `ai_decide selected unknown candidate ${answer.choice}`);
    }
    const probabilities = answer.probabilities
      ? Object.fromEntries(
          Object.entries(answer.probabilities).flatMap(([label, probability]) => {
            const endpoint = labels.get(label);
            return endpoint ? [[endpoint.name, probability] as const] : [];
          }),
        )
      : undefined;
    return {
      endpoint: selected,
      observation: AiDecideObservationSchema.parse({
        selectedModel: selected.name,
        strategy,
        ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
        ...(probabilities && Object.keys(probabilities).length > 0 ? { probabilities } : {}),
        latencyMs: Math.round(performance.now() - startedAt),
      }),
    };
  }

  /** Probe and memoize whether the active workspace identity can call `ai_decide`. */
  async isEnabled(
    endpoints: readonly ServingEndpointSummary[],
    client: WorkspaceClient | undefined = undefined,
  ): Promise<boolean> {
    if (modelCandidates(endpoints, AiDecideModelFiltersSchema.parse({})).length < 2) {
      return false;
    }
    let workspaceClient: WorkspaceClient;
    try {
      workspaceClient = client ?? getExecutionContext().client;
    } catch {
      return false;
    }
    const cache = this.probeCache(workspaceClient);
    const probe = await getOrSet(cache, PROBE_KEY, () => this.loadProbe(endpoints, workspaceClient), {
      ttl: PROBE_CACHE_TTL_MS,
      refreshAfterWrite: (value) => this.probeTtl(value.enabled),
    });
    return probe?.enabled ?? false;
  }

  /** Stop process-local probe caches after active refreshes settle. */
  dispose(): void {
    for (const cache of this.probeCaches) void closeCache(cache);
    this.probeCaches.clear();
  }

  private async loadProbe(
    endpoints: readonly ServingEndpointSummary[],
    client: WorkspaceClient,
  ): Promise<SmartRouterProbeRecord> {
    const stored = await this.readStoredProbe(client);
    if (stored && stored.expiresAt > Date.now()) return stored;
    const enabled = await this.select(
      "Choose the lowest-latency sufficient model for a one-sentence factual answer.",
      endpoints,
      client,
      { strategy: "latency", timeoutMs: DEFAULT_TIMEOUT_MS },
    )
      .then(() => true)
      .catch((error) => {
        logger.debug("ai_decide capability probe unavailable", { error: toError(error) });
        return false;
      });
    const probe = this.probeRecord(enabled);
    await this.writeStoredProbe(probe, client);
    return probe;
  }

  private setProbeValue(client: WorkspaceClient, enabled: boolean): void {
    const probe = this.probeRecord(enabled);
    void this.writeProcessProbe(this.probeCache(client), probe);
    void this.writeStoredProbe(probe, client);
  }

  private probeRecord(enabled: boolean): SmartRouterProbeRecord {
    return { enabled, expiresAt: Date.now() + this.probeTtl(enabled) };
  }

  private probeTtl(enabled: boolean): number {
    return enabled ? POSITIVE_PROBE_TTL_MS : NEGATIVE_PROBE_TTL_MS;
  }

  private async readStoredProbe(
    client: WorkspaceClient,
  ): Promise<SmartRouterProbeRecord | undefined> {
    try {
      const parsed = SmartRouterProbeRecordSchema.safeParse(
        await this.probeStore.get(PROBE_KEY, client),
      );
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      logger.debug("ai_decide probe cache read failed", { error: toError(error) });
      return undefined;
    }
  }

  private async writeProcessProbe(
    cache: AiDecideProbeCache,
    probe: SmartRouterProbeRecord,
  ): Promise<void> {
    try {
      await cache.set(PROBE_KEY, probe, { ttl: PROBE_CACHE_TTL_MS });
    } catch (error) {
      logger.debug("ai_decide process probe cache write failed", { error: toError(error) });
    }
  }

  private async writeStoredProbe(
    probe: SmartRouterProbeRecord,
    client: WorkspaceClient,
  ): Promise<void> {
    try {
      await this.probeStore.set(
        PROBE_KEY,
        probe,
        Math.max(1, Math.ceil(PROBE_CACHE_TTL_MS / 1_000)),
        client,
      );
    } catch (error) {
      logger.debug("ai_decide probe cache write failed", { error: toError(error) });
    }
  }

  private probeCache(client: WorkspaceClient): AiDecideProbeCache {
    const owner =
      client.config && typeof client.config === "object" ? (client.config as object) : client;
    let cache = this.probes.get(owner);
    if (!cache) {
      cache = createCache({ maxEntries: 1, useClone: false });
      this.probes.set(owner, cache);
      this.probeCaches.add(cache);
    }
    return cache;
  }
}

/** HTTP failure returned by the Databricks AI Functions router. */
export class AiDecideRouterError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AiDecideRouterError";
  }
}

function modelCandidates(
  endpoints: readonly ServingEndpointSummary[],
  filters: ResolvedAiDecideModelFilters,
): ServingEndpointSummary[] {
  const families = filters.families?.map((family) => family.toLowerCase());
  return selection
    .lookupModels(
      endpoints,
      {
        ...(filters.modelClass ? { modelClass: filters.modelClass } : {}),
        modelSource: filters.modelSource,
        ...(filters.requiresTools !== undefined ? { requiresTools: filters.requiresTools } : {}),
        ...(filters.requiresStructuredOutput !== undefined
          ? { requiresStructuredOutput: filters.requiresStructuredOutput }
          : {}),
        limit: filters.maxCandidates,
      },
      { preferSystemModels: true },
    )
    .map(({ endpoint }) => endpoint)
    .filter((endpoint) => !families || (endpoint.family && families.includes(endpoint.family.toLowerCase())));
}

function candidateState(endpoint: ServingEndpointSummary, rank: number): Record<string, unknown> {
  const capabilities = endpointCapabilities(endpoint);
  return {
    id: endpoint.name,
    rank,
    display_name: endpoint.displayName,
    family: endpoint.family,
    version: versionTuple(endpoint.name),
    class: endpoint.class,
    profile: endpoint.profile,
    capabilities: {
      chat: capabilities.chat,
      tools: capabilities.tools,
      structured_output: endpoint.supportsStructuredOutput === true,
      reasoning_efforts: endpoint.reasoningEfforts ?? [],
    },
  };
}

function candidateDescription(endpoint: ServingEndpointSummary, rank: number): Record<string, unknown> {
  return {
    model: endpoint.name,
    rank,
    family: endpoint.family ?? null,
    version: versionTuple(endpoint.name),
    capability_class: endpoint.class ?? null,
    quality_score: endpoint.profile?.quality ?? null,
    speed_score: endpoint.profile?.speed ?? null,
    cost_score: endpoint.profile?.cost ?? null,
    supports_tools: endpointCapabilities(endpoint).tools,
    supports_structured_output: endpoint.supportsStructuredOutput === true,
    reasoning_efforts: endpoint.reasoningEfforts ?? [],
  };
}

function strategyInstructions(strategy: AiDecideStrategy): string {
  const objective = {
    balanced:
      "Choose the smallest and least expensive model that is still likely to answer the task accurately and completely.",
    quality: "Choose the model most likely to produce the highest-quality correct answer.",
    cost: "Choose the lowest-cost model that is still sufficient for the task.",
    latency: "Choose the fastest model that is still sufficient for the task.",
  }[strategy];
  return `${objective} Use the supplied rank, version, capability class, quality, speed, cost, tool, structured-output, family, and reasoning metadata. Treat a newer unscored model as potentially stronger than an older scored predecessor rather than penalizing missing profile scores. Prefer simpler models for simple requests and reserve stronger reasoning models for genuinely complex work.`;
}

async function invokeAiDecide(
  client: WorkspaceClient,
  body: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const host = (await client.config.getHost()).toString();
  const url = new URL(AI_DECIDE_PATH, host);
  const headers = new Headers({ "content-type": "application/json" });
  await client.config.authenticate(headers);
  const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: combinedSignal,
  });
  if (response.status === 401 && (await refreshWorkspaceClientAuthentication(client))) {
    await response.body?.cancel();
    headers.delete("authorization");
    headers.delete("x-databricks-workspace-id");
    await client.config.authenticate(headers);
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 500);
    throw new AiDecideRouterError(
      response.status,
      `Databricks ai_decide failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const value = (await response.json()) as unknown;
  if (isRecord(value) && typeof value.error_message === "string" && value.error_message) {
    throw new AiDecideRouterError(502, value.error_message);
  }
  return value;
}

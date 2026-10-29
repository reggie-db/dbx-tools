/**
 * Databricks Smart Router transport, context construction, probing, and turn pinning.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { CacheManager, getExecutionContext, type WorkspaceClient } from "@databricks/appkit";
import { refreshWorkspaceClientAuthentication } from "@dbx-tools/databricks";
import { isRecord, log, toError } from "@dbx-tools/shared-core";
import { ReasoningEffortSchema, type ReasoningEffort } from "@dbx-tools/shared-model";
import {
  SMART_ROUTER_NAME,
  SmartRouterObservationSchema,
  SmartRouterRequestSchema,
  SmartRouterResponseSchema,
  type ClientProtocol,
  type ModelTarget,
  type RequestedFeatures,
  type SmartRouterHarness,
  type SmartRouterObservation,
  type SmartRouterRequest,
} from "@dbx-tools/shared-model-gateway";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import { z } from "zod";

import { resolveRoute } from "./router.ts";

const logger = log.logger("appkit/model-gateway/smart-router");
const ROUTE_CACHE_NAMESPACE = "model-gateway-smart-router";
const ROUTE_POLICY_VERSION = 1;
const PROBE_CACHE_NAMESPACE = "model-gateway-smart-router-probe";
const PROBE_CACHE_VERSION = 1;
const PROBE_TASK = "Check whether Smart Router can select an available model.";
const NEGATIVE_PROBE_TTL_MS = 30_000;
const CONTEXT_ENCODING = new Tiktoken(o200kBase);

/** Runtime settings for Smart Router. */
export interface SmartRouterSettings {
  readonly contextTokenBudget: number;
  readonly probeRefreshIntervalMs: number;
  readonly probeTtlMs: number;
  readonly routeTtlSeconds: number;
  readonly routerName: string;
  readonly timeoutMs: number;
}

/** One route option associated with the caller-owned value it represents. */
export interface SmartRouterCandidate<T> {
  readonly harness: SmartRouterHarness;
  readonly model: string;
  readonly value: T;
}

/** Result returned after mapping a Databricks route back to a caller-owned value. */
export interface SmartRouterSelection<T> {
  readonly harness: SmartRouterHarness;
  readonly latencyMs: number;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly rationale?: string;
  readonly routeModel: string;
  readonly routerName: string;
  readonly value: T;
}

/** Portable persistence surface for a pinned Smart Router turn. */
export interface SmartRouterStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: SmartRouterObservation, ttlSeconds: number): Promise<void>;
}

export const SmartRouterProbeRecordSchema = z
  .object({
    enabled: z.boolean().describe("Whether the live Smart Router probe succeeded."),
    expiresAt: z.number().int().describe("Epoch milliseconds when this probe becomes stale."),
  })
  .describe("Persisted Smart Router capability probe result.");

export type SmartRouterProbeRecord = z.infer<typeof SmartRouterProbeRecordSchema>;

/** Optional persistent cache for capability probes. */
export interface SmartRouterProbeStore {
  get(key: string, client: WorkspaceClient): Promise<unknown>;
  set(
    key: string,
    value: SmartRouterProbeRecord,
    ttlSeconds: number,
    client: WorkspaceClient,
  ): Promise<void>;
}

/** Result applied to one concrete gateway request. */
export interface SmartRouterResult {
  readonly body: Readonly<Record<string, unknown>>;
  readonly observation: SmartRouterObservation;
  readonly target: ModelTarget;
}

/** Bounded task context extracted from an arbitrary supported input shape. */
export interface SmartRouterContext {
  readonly continuation: boolean;
  readonly logicalTurn: string;
  readonly task: string;
}

/** Error carrying an HTTP status for Smart Router validation or availability failures. */
export class SmartRouterError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SmartRouterError";
  }
}

/** AppKit cache adapter; configured Lakebase/Postgres storage remains AppKit-owned. */
export class AppKitSmartRouterStore implements SmartRouterStore {
  async get(key: string): Promise<unknown> {
    const cache = await CacheManager.getInstance();
    return cache.get(cache.generateKey([ROUTE_CACHE_NAMESPACE, ROUTE_POLICY_VERSION], key));
  }

  async set(key: string, value: SmartRouterObservation, ttlSeconds: number): Promise<void> {
    const cache = await CacheManager.getInstance();
    await cache.set(cache.generateKey([ROUTE_CACHE_NAMESPACE, ROUTE_POLICY_VERSION], key), value, {
      ttl: ttlSeconds,
    });
  }
}

/** AppKit cache adapter for process- and persistence-backed capability probes. */
export class AppKitSmartRouterProbeStore implements SmartRouterProbeStore {
  async get(key: string, client: WorkspaceClient): Promise<unknown> {
    const cache = appKitCacheManager();
    if (!cache) return undefined;
    const identity = await smartRouterProbeIdentity(client);
    return cache.get(
      cache.generateKey([PROBE_CACHE_NAMESPACE, PROBE_CACHE_VERSION], `${identity}:${key}`),
    );
  }

  async set(
    key: string,
    value: SmartRouterProbeRecord,
    ttlSeconds: number,
    client: WorkspaceClient,
  ): Promise<void> {
    const cache = appKitCacheManager();
    if (!cache) return;
    const identity = await smartRouterProbeIdentity(client);
    await cache.set(
      cache.generateKey([PROBE_CACHE_NAMESPACE, PROBE_CACHE_VERSION], `${identity}:${key}`),
      value,
      { ttl: ttlSeconds },
    );
  }
}

interface ProbeEntry {
  readonly cache: Map<string, ProbeEntry>;
  readonly candidates: readonly SmartRouterCandidate<unknown>[];
  readonly client: WeakRef<WorkspaceClient>;
  readonly key: string;
  expiresAt: number;
  refresh?: Promise<boolean>;
  value?: boolean;
}

/** Optional identity and cancellation inputs for one Smart Router call. */
export interface SmartRouterSelectOptions {
  readonly client?: WorkspaceClient;
  readonly signal?: AbortSignal;
}

type SmartRouterInvoker = (
  client: WorkspaceClient,
  request: SmartRouterRequest,
  signal: AbortSignal,
  timeoutMs: number,
) => Promise<unknown>;

/**
 * Dedicated Smart Router service for strings, request objects, message arrays,
 * and generic JSON-like inputs.
 */
export class SmartRouterService {
  readonly context: SmartRouterContextBuilder;
  private readonly probes = new WeakMap<object, Map<string, ProbeEntry>>();
  private readonly probeEntries = new Set<ProbeEntry>();
  private probeRefreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly settings: SmartRouterSettings,
    private readonly invoke: SmartRouterInvoker = invokeSmartRouter,
    private readonly probeStore: SmartRouterProbeStore = new AppKitSmartRouterProbeStore(),
  ) {
    this.context = new SmartRouterContextBuilder(settings.contextTokenBudget);
  }

  /** Select one offered route for arbitrary input content. */
  async select<T>(
    input: unknown,
    candidates: readonly SmartRouterCandidate<T>[],
    options: SmartRouterSelectOptions = {},
  ): Promise<SmartRouterSelection<T>> {
    const task = this.context.build(input);
    if (!task) throw new SmartRouterError(400, "Smart Router input contains no routable text");
    const client = options.client ?? getExecutionContext().client;
    try {
      const selection = await this.selectTask(task, candidates, { ...options, client });
      this.setProbeValue(candidates, client, true);
      return selection;
    } catch (error) {
      this.setProbeUnavailable(candidates, client);
      throw error;
    }
  }

  /** Return a memoized live capability probe for the active identity and candidate menu. */
  async isEnabled<T>(
    candidates: readonly SmartRouterCandidate<T>[],
    client = getExecutionContext().client,
  ): Promise<boolean> {
    const offered = uniqueCandidates(candidates);
    if (offered.length === 0) return false;
    const cache = this.probeCache(client);
    const key = probeKey(offered, this.settings.routerName);
    const now = Date.now();
    const cached = cache.get(key);
    if (cached) {
      if (cached.value === undefined) return cached.refresh!;
      if (cached.expiresAt <= now && !cached.refresh) void this.refreshProbe(cached);
      return cached.value;
    }
    const entry = this.createProbeEntry(cache, key, offered, client);
    return this.initializeProbe(entry);
  }

  /** Stop this service's unref'd background probe refresh timer. */
  dispose(): void {
    if (this.probeRefreshTimer) clearInterval(this.probeRefreshTimer);
    this.probeRefreshTimer = undefined;
    this.probeEntries.clear();
  }

  private createProbeEntry<T>(
    cache: Map<string, ProbeEntry>,
    key: string,
    candidates: readonly SmartRouterCandidate<T>[],
    client: WorkspaceClient,
  ): ProbeEntry {
    const entry: ProbeEntry = {
      cache,
      candidates,
      client: new WeakRef(client),
      key,
      expiresAt: 0,
    };
    this.replaceProbe(cache, key, entry);
    return entry;
  }

  private initializeProbe(entry: ProbeEntry): Promise<boolean> {
    const client = entry.client.deref();
    if (!client) return Promise.resolve(false);
    let refresh!: Promise<boolean>;
    refresh = this.readStoredProbe(entry, client)
      .then((stored) => {
        if (stored && stored.expiresAt > Date.now()) {
          entry.value = stored.enabled;
          entry.expiresAt = stored.expiresAt;
          return stored.enabled;
        }
        return this.executeProbe(entry, client);
      })
      .finally(() => {
        if (entry.refresh === refresh) entry.refresh = undefined;
      });
    entry.refresh = refresh;
    return refresh;
  }

  private refreshProbe(entry: ProbeEntry): Promise<boolean> {
    if (entry.refresh) return entry.refresh;
    const client = entry.client.deref();
    if (!client) return Promise.resolve(false);
    let refresh!: Promise<boolean>;
    refresh = this.executeProbe(entry, client).finally(() => {
      if (entry.refresh === refresh) entry.refresh = undefined;
    });
    entry.refresh = refresh;
    return refresh;
  }

  private async executeProbe(entry: ProbeEntry, client: WorkspaceClient): Promise<boolean> {
    const enabled = await this.selectTask(PROBE_TASK, entry.candidates, { client })
      .then(() => true)
      .catch((error) => {
        logger.debug("Smart Router capability probe unavailable", { error: toError(error) });
        return false;
      });
    if (entry.cache.get(entry.key) === entry) {
      this.updateProbeEntry(entry, enabled);
      void this.writeStoredProbe(entry, enabled, client);
    }
    return enabled;
  }

  private setProbeValue<T>(
    candidates: readonly SmartRouterCandidate<T>[],
    client: WorkspaceClient,
    enabled: boolean,
  ): void {
    const offered = uniqueCandidates(candidates);
    if (offered.length === 0) return;
    const cache = this.probeCache(client);
    const key = probeKey(offered, this.settings.routerName);
    const entry = cache.get(key) ?? this.createProbeEntry(cache, key, offered, client);
    this.updateProbeEntry(entry, enabled);
    void this.writeStoredProbe(entry, enabled, client);
  }

  private setProbeUnavailable<T>(
    candidates: readonly SmartRouterCandidate<T>[],
    client: WorkspaceClient,
  ): void {
    const cache = this.probeCache(client);
    for (const cached of cache.values()) {
      this.updateProbeEntry(cached, false);
      void this.writeStoredProbe(cached, false, client);
    }
    this.setProbeValue(candidates, client, false);
  }

  private updateProbeEntry(entry: ProbeEntry, enabled: boolean): void {
    entry.value = enabled;
    entry.expiresAt = Date.now() + this.probeTtl(enabled);
  }

  private async readStoredProbe(
    entry: ProbeEntry,
    client: WorkspaceClient,
  ): Promise<SmartRouterProbeRecord | undefined> {
    try {
      const parsed = SmartRouterProbeRecordSchema.safeParse(
        await this.probeStore.get(entry.key, client),
      );
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      logger.debug("Smart Router probe cache read failed", { error: toError(error) });
      return undefined;
    }
  }

  private async writeStoredProbe(
    entry: ProbeEntry,
    enabled: boolean,
    client: WorkspaceClient,
  ): Promise<void> {
    try {
      await this.probeStore.set(
        entry.key,
        { enabled, expiresAt: entry.expiresAt },
        Math.max(
          1,
          Math.ceil(
            (Math.max(this.settings.probeRefreshIntervalMs, this.settings.probeTtlMs) * 2) / 1_000,
          ),
        ),
        client,
      );
    } catch (error) {
      logger.debug("Smart Router probe cache write failed", { error: toError(error) });
    }
  }

  private probeCache(client: WorkspaceClient): Map<string, ProbeEntry> {
    const owner = client.config as object;
    let cache = this.probes.get(owner);
    if (!cache) {
      cache = new Map();
      this.probes.set(owner, cache);
    }
    return cache;
  }

  private replaceProbe(cache: Map<string, ProbeEntry>, key: string, entry: ProbeEntry): void {
    const previous = cache.get(key);
    if (previous) this.probeEntries.delete(previous);
    cache.set(key, entry);
    this.probeEntries.add(entry);
    this.ensureProbeRefreshTimer();
  }

  private probeTtl(enabled: boolean): number {
    return enabled
      ? this.settings.probeTtlMs
      : Math.min(this.settings.probeTtlMs, NEGATIVE_PROBE_TTL_MS);
  }

  private ensureProbeRefreshTimer(): void {
    if (this.probeRefreshTimer) return;
    this.probeRefreshTimer = setInterval(() => {
      void this.refreshProbes();
    }, this.settings.probeRefreshIntervalMs);
    this.probeRefreshTimer.unref();
  }

  private async refreshProbes(): Promise<void> {
    const refreshes: Promise<boolean>[] = [];
    for (const entry of [...this.probeEntries]) {
      if (entry.cache.get(entry.key) !== entry) {
        this.probeEntries.delete(entry);
        continue;
      }
      const client = entry.client.deref();
      if (!client) {
        entry.cache.delete(entry.key);
        this.probeEntries.delete(entry);
        continue;
      }
      if (!entry.refresh) refreshes.push(this.refreshProbe(entry));
    }
    await Promise.allSettled(refreshes);
  }

  private async selectTask<T>(
    task: string,
    candidates: readonly SmartRouterCandidate<T>[],
    options: SmartRouterSelectOptions,
  ): Promise<SmartRouterSelection<T>> {
    const offered = uniqueCandidates(candidates);
    if (offered.length === 0) {
      throw new SmartRouterError(400, "No compatible system models are available to Smart Router");
    }
    const request = SmartRouterRequestSchema.parse({
      route_options: offered.map(({ model, harness }) => ({ model, harness })),
      task: { prompt: task },
      route_selector: { router_name: this.settings.routerName },
    });
    const client = options.client ?? getExecutionContext().client;
    const signal = options.signal ?? new AbortController().signal;
    const startedAt = Date.now();
    const response = SmartRouterResponseSchema.parse(
      await this.invoke(client, request, signal, this.settings.timeoutMs),
    );
    const selection = response.route_selection[0]!;
    const selected = offered.find(
      (candidate) =>
        normalizeRouteModel(candidate.model) ===
          normalizeRouteModel(selection.route_option.model) &&
        (!selection.route_option.harness || candidate.harness === selection.route_option.harness),
    );
    if (!selected) {
      throw new SmartRouterError(
        502,
        `Smart Router selected an unsupported model: ${selection.route_option.model}`,
      );
    }
    return {
      value: selected.value,
      routeModel: selection.route_option.model,
      harness: selected.harness,
      routerName: this.settings.routerName,
      latencyMs: Date.now() - startedAt,
      ...(response.rationale ? { rationale: response.rationale } : {}),
      ...(selection.params ? { params: selection.params } : {}),
    };
  }
}

/** Build a Smart Router candidate menu from values carrying modelServiceName. */
export function smartRouterCandidates<T extends { readonly modelServiceName?: string }>(
  values: readonly T[],
  harness: SmartRouterHarness,
): SmartRouterCandidate<T>[] {
  return values.flatMap((value) => {
    const model = value.modelServiceName?.trim();
    if (!model || !model.toLowerCase().startsWith("system.ai.")) return [];
    return [{ model, harness, value }];
  });
}

/**
 * Context extractor shared by the gateway, Mastra, and the file/stdin CLI.
 * It favors conversation/task fields and ignores credentials, tool schemas,
 * and tool arguments.
 */
export class SmartRouterContextBuilder {
  constructor(private readonly tokenBudget = 4_096) {}

  /** Return only the bounded task prompt required by routes:select. */
  build(input: unknown): string {
    return this.analyze(input).task;
  }

  /** Return bounded task text plus logical-turn metadata used for pinning. */
  analyze(input: unknown): SmartRouterContext {
    const normalized = parseJsonString(input);
    const events = conversationEvents(normalized);
    if (events.length > 0) return contextFromEvents(events, this.tokenBudget);
    const values = collectTaskStrings(normalized);
    const task = truncateText(values.join("\n"), this.tokenBudget, "start");
    return { task, logicalTurn: task, continuation: false };
  }
}

/** Smart Router orchestration shared by Responses, Chat Completions, and Messages. */
export class SmartModelRouter {
  readonly service: SmartRouterService;

  constructor(
    private readonly settings: SmartRouterSettings,
    service = new SmartRouterService(settings),
    private readonly store: SmartRouterStore = new AppKitSmartRouterStore(),
    private readonly client?: WorkspaceClient,
  ) {
    this.service = service;
  }

  /** Probe whether Smart Router is usable for the current model catalogue. */
  isEnabled(targets: readonly ModelTarget[]): Promise<boolean> {
    const candidates = smartRouterCandidates(
      targets.filter((target) => target.capabilities.chat && target.capabilities.aiGatewayCodex),
      "codex",
    );
    return this.client
      ? this.service.isEnabled(candidates, this.client)
      : this.service.isEnabled(candidates);
  }

  /** Resolve one virtual smart-router request to a concrete compatible target. */
  async resolve(input: {
    readonly body: Readonly<Record<string, unknown>>;
    readonly features: RequestedFeatures;
    readonly headers: Headers;
    readonly preferSystemModels: boolean;
    readonly protocol: Exclude<ClientProtocol, "openai-embeddings">;
    readonly signal: AbortSignal;
    readonly targets: readonly ModelTarget[];
  }): Promise<SmartRouterResult> {
    const harness: SmartRouterHarness =
      input.protocol === "anthropic-messages" ? "claude" : "codex";
    const explicitReasoningEffort = requestedReasoningEffort(input.body);
    const eligibleTargets = input.targets.filter((target) =>
      isEligibleTarget(
        target,
        { ...input, originator: input.headers.get("originator") ?? undefined },
        explicitReasoningEffort,
        harness,
      ),
    );
    const candidates = smartRouterCandidates(eligibleTargets, harness);
    if (candidates.length === 0) {
      throw new SmartRouterError(
        400,
        "No compatible system models are available to Databricks Smart Router",
      );
    }

    const context = this.service.context.analyze(input.body);
    if (!context.task) {
      throw new SmartRouterError(400, "Smart Router request contains no task text");
    }
    const key = smartRouterTurnKey(context.logicalTurn, candidates, {
      harness,
      protocol: input.protocol,
      features: input.features,
      ...(explicitReasoningEffort ? { explicitReasoningEffort } : {}),
    });
    const cached = context.continuation ? await this.readCached(key, eligibleTargets) : undefined;
    if (cached) {
      return {
        target: eligibleTargets.find((target) => target.id === cached.selectedModel)!,
        body: input.body,
        observation: { ...cached, source: "cache" },
      };
    }

    const selected = await this.service.select(context.task, candidates, {
      signal: input.signal,
      ...(this.client ? { client: this.client } : {}),
    });
    const target = selected.value;
    const observation = SmartRouterObservationSchema.parse({
      selectedModel: target.id,
      routeModel: selected.routeModel,
      harness: selected.harness,
      routerName: selected.routerName,
      source: "router",
      latencyMs: selected.latencyMs,
      ...(selected.rationale ? { rationale: selected.rationale } : {}),
      ...(selected.params ? { params: selected.params } : {}),
    });
    await this.writeCached(key, observation);
    logger.debug("selected Smart Router model", {
      candidateCount: candidates.length,
      harness,
      latencyMs: observation.latencyMs,
      model: observation.selectedModel,
      routeModel: observation.routeModel,
      routerName: observation.routerName,
    });
    return { target, body: input.body, observation };
  }

  private async readCached(
    key: string,
    targets: readonly ModelTarget[],
  ): Promise<SmartRouterObservation | undefined> {
    try {
      const parsed = SmartRouterObservationSchema.safeParse(await this.store.get(key));
      if (!parsed.success) return undefined;
      return targets.some((target) => target.id === parsed.data.selectedModel)
        ? parsed.data
        : undefined;
    } catch (error) {
      logger.debug("Smart Router cache read failed", { error: toError(error) });
      return undefined;
    }
  }

  private async writeCached(key: string, observation: SmartRouterObservation): Promise<void> {
    try {
      await this.store.set(key, observation, this.settings.routeTtlSeconds);
    } catch (error) {
      logger.debug("Smart Router cache write failed", { error: toError(error) });
    }
  }
}

/** Stable logical-turn key shared by initial requests and tool continuations. */
export function smartRouterTurnKey(
  logicalTurn: string,
  candidates: readonly SmartRouterCandidate<unknown>[],
  context: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        logicalTurn,
        candidates: candidates.map(({ model, harness }) => ({ model, harness })),
        context,
      }),
    )
    .digest("hex");
}

function isEligibleTarget(
  target: ModelTarget,
  input: {
    readonly features: RequestedFeatures;
    readonly originator?: string;
    readonly preferSystemModels: boolean;
    readonly protocol: Exclude<ClientProtocol, "openai-embeddings">;
  },
  explicitReasoningEffort: ReasoningEffort | undefined,
  harness: SmartRouterHarness,
): boolean {
  if (!target.endpoint || target.endpoint.status?.deprecated === true) return false;
  if (!target.modelServiceName?.toLowerCase().startsWith("system.ai.")) return false;
  if (!target.capabilities.chat) return false;
  if (harness === "codex" && !target.capabilities.aiGatewayCodex) return false;
  if (harness === "claude" && !target.capabilities.anthropic) return false;
  if (input.features.tools && !target.capabilities.tools) return false;
  if (input.features.parallelTools && !target.capabilities.parallelTools) return false;
  if (input.features.customTools && !target.capabilities.customTools) return false;
  if (input.features.structuredOutput && !target.capabilities.structuredOutput) return false;
  if (input.features.webSearch && !target.capabilities.webSearch) return false;
  if (input.features.imageInput && !target.capabilities.imageInput) return false;
  if (input.features.applyPatch && !target.capabilities.applyPatch) return false;
  if (input.features.reasoning && !target.capabilities.reasoning) return false;
  if (
    explicitReasoningEffort &&
    explicitReasoningEffort !== "none" &&
    !target.reasoningEfforts.includes(explicitReasoningEffort)
  ) {
    return false;
  }
  try {
    resolveRoute({
      clientProtocol: input.protocol,
      ...(input.originator ? { originator: input.originator } : {}),
      preferSystemModels: input.preferSystemModels,
      features: input.features,
      target,
    });
    return true;
  } catch {
    return false;
  }
}

function requestedReasoningEffort(
  body: Readonly<Record<string, unknown>>,
): ReasoningEffort | undefined {
  const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined;
  const outputConfig = isRecord(body.output_config) ? body.output_config : undefined;
  const raw = body.reasoning_effort ?? reasoning?.effort ?? outputConfig?.effort;
  if (raw === undefined || raw === null) return undefined;
  const normalized = String(raw).trim().toLowerCase().replaceAll("_", "-");
  const parsed = ReasoningEffortSchema.safeParse(
    normalized === "extra-high" ? "xhigh" : normalized,
  );
  if (!parsed.success) {
    throw new SmartRouterError(400, `Unsupported Smart Router reasoning effort: ${String(raw)}`);
  }
  return parsed.data;
}

interface ConversationEvent {
  readonly role: "assistant" | "system" | "tool" | "user";
  readonly text: string;
}

function contextFromEvents(
  events: readonly ConversationEvent[],
  tokenBudget: number,
): SmartRouterContext {
  const latestUserIndex = lastEventIndex(events, "user");
  const taskEvent = latestUserIndex >= 0 ? events[latestUserIndex] : events.at(-1);
  const task = truncateText(taskEvent?.text ?? "", tokenBudget, "start");
  let remaining = Math.max(0, tokenBudget - countTokens(task));
  const context: string[] = [];
  for (
    let index = (taskEvent ? events.indexOf(taskEvent) : events.length) - 1;
    index >= 0;
    index -= 1
  ) {
    const event = events[index];
    if (!event || !event.text || event.role === "tool") continue;
    const value = `${event.role}: ${event.text}`;
    const retained = truncateText(value, remaining, "end");
    if (!retained) break;
    context.unshift(retained);
    remaining -= countTokens(retained);
  }
  const combined = [...context, task].filter(Boolean).join("\n");
  const logicalEvents = latestUserIndex >= 0 ? events.slice(0, latestUserIndex + 1) : events;
  return {
    task: combined,
    logicalTurn: logicalEvents.map((event) => `${event.role}:${event.text}`).join("\n"),
    continuation:
      latestUserIndex >= 0 &&
      events.slice(latestUserIndex + 1).some((event) => event.role !== "system"),
  };
}

function conversationEvents(input: unknown): ConversationEvent[] {
  if (typeof input === "string") return input.trim() ? [{ role: "user", text: input.trim() }] : [];
  if (Array.isArray(input)) return input.flatMap(messageEvent);
  if (!isRecord(input)) return [];
  for (const key of ["messages", "input"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return [{ role: "user", text: value.trim() }];
    if (Array.isArray(value)) {
      const events = value.flatMap(messageEvent);
      if (events.length > 0) return events;
    }
  }
  return [];
}

function messageEvent(value: unknown): ConversationEvent[] {
  if (typeof value === "string") return value.trim() ? [{ role: "user", text: value.trim() }] : [];
  if (!isRecord(value)) return [];
  const role = messageRole(value);
  if (!role) return [];
  const text = contentText(value.content ?? value.text ?? value.input_text ?? value.output_text);
  return text ? [{ role, text }] : [];
}

function messageRole(
  value: Readonly<Record<string, unknown>>,
): ConversationEvent["role"] | undefined {
  if (value.role === "user" || value.role === "assistant" || value.role === "system") {
    return value.role;
  }
  if (
    value.role === "tool" ||
    value.type === "function_call_output" ||
    value.type === "tool_result"
  ) {
    return "tool";
  }
  if (value.type === "function_call" || value.type === "reasoning") return "assistant";
  if (value.type === "message" && value.role === undefined) return "user";
  return undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  for (const key of ["text", "input_text", "output_text", "content"] as const) {
    const text = contentText(value[key]);
    if (text) return text;
  }
  return "";
}

const TASK_KEYS = [
  "prompt",
  "task",
  "query",
  "question",
  "request",
  "description",
  "message",
  "text",
  "input",
] as const;
const IGNORED_KEYS = new Set([
  "api_key",
  "authorization",
  "arguments",
  "credentials",
  "headers",
  "metadata",
  "password",
  "secret",
  "token",
  "tools",
]);

function collectTaskStrings(input: unknown): string[] {
  if (typeof input === "string") return input.trim() ? [input.trim()] : [];
  const preferred: string[] = [];
  if (isRecord(input)) {
    for (const key of TASK_KEYS) preferred.push(...stringLeaves(input[key], key, 0));
  }
  return preferred.length > 0 ? preferred.slice(0, 32) : stringLeaves(input, "", 0).slice(0, 32);
}

function stringLeaves(value: unknown, key: string, depth: number): string[] {
  if (depth > 6 || IGNORED_KEYS.has(key.toLowerCase())) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((item) => stringLeaves(item, key, depth + 1));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([childKey, child]) =>
    stringLeaves(child, childKey, depth + 1),
  );
}

function parseJsonString(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return input;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return input;
  }
}

function countTokens(text: string): number {
  return CONTEXT_ENCODING.encode(text, [], []).length;
}

function truncateText(text: string, tokenBudget: number, edge: "start" | "end"): string {
  if (tokenBudget <= 0 || !text) return "";
  const tokens = CONTEXT_ENCODING.encode(text, [], []);
  if (tokens.length <= tokenBudget) return text;
  return CONTEXT_ENCODING.decode(
    edge === "start" ? tokens.slice(0, tokenBudget) : tokens.slice(-tokenBudget),
  );
}

function lastEventIndex(
  events: readonly ConversationEvent[],
  role: ConversationEvent["role"],
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.role === role) return index;
  }
  return -1;
}

function uniqueCandidates<T>(
  candidates: readonly SmartRouterCandidate<T>[],
): SmartRouterCandidate<T>[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.harness}:${normalizeRouteModel(candidate.model)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeRouteModel(model: string): string {
  let normalized = model.trim().toLowerCase().split("/").at(-1) ?? "";
  for (const prefix of ["databricks-", "system.ai."] as const) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }
  return normalized;
}

function probeKey<T>(candidates: readonly SmartRouterCandidate<T>[], routerName: string): string {
  return JSON.stringify({
    routerName,
    candidates: candidates
      .map(({ model, harness }) => ({ model: normalizeRouteModel(model), harness }))
      .sort((left, right) =>
        `${left.harness}:${left.model}`.localeCompare(`${right.harness}:${right.model}`),
      ),
  });
}

function appKitCacheManager(): CacheManager | undefined {
  try {
    return CacheManager.getInstanceSync();
  } catch {
    return undefined;
  }
}

async function smartRouterProbeIdentity(client: WorkspaceClient): Promise<string> {
  const headers = new Headers();
  const host = (await client.config.getHost()).toString();
  await client.config.authenticate(headers);
  return createHash("sha256")
    .update(host)
    .update("\0")
    .update(headers.get("authorization") ?? "")
    .update("\0")
    .update(headers.get("x-databricks-workspace-id") ?? "")
    .digest("hex");
}

async function invokeSmartRouter(
  client: WorkspaceClient,
  body: SmartRouterRequest,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const host = (await client.config.getHost()).toString();
  const url = new URL("/ai-gateway/routing/v1/routes:select", host);
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
    throw new SmartRouterError(
      response.status === 404 ? 404 : 503,
      `Databricks Smart Router failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return response.json();
}

/** Defaults shared by gateway, Mastra, and CLI Smart Router callers. */
export const SMART_ROUTER_DEFAULT_SETTINGS: SmartRouterSettings = Object.freeze({
  contextTokenBudget: 4_096,
  probeRefreshIntervalMs: 3_600_000,
  probeTtlMs: 300_000,
  routeTtlSeconds: 21_600,
  routerName: SMART_ROUTER_NAME,
  timeoutMs: 10_000,
});

/**
 * Context-aware automatic routing orchestration for every supported chat API.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { CacheManager, getExecutionContext } from "@databricks/appkit";
import { refreshWorkspaceClientAuthentication } from "@dbx-tools/databricks";
import {
  automaticDecisionForOnlyTier,
  automaticDecisionForReasoning,
  automaticTierForModelClass,
  fallbackAutomaticRouteDecision,
  resolveAutomaticModel,
} from "@dbx-tools/model";
import { isRecord, log, toError } from "@dbx-tools/shared-core";
import {
  AutomaticRouteDecisionSchema,
  AutomaticRouteObservationSchema,
  AutomaticRouteRequestSchema,
  ModelClass,
  ReasoningEffortSchema,
  type AutomaticRouteDecision,
  type AutomaticRouteDecisionSource,
  type AutomaticRouteObservation,
  type AutomaticRouteRequest,
  type AutomaticRouteTier,
  type ReasoningEffort,
} from "@dbx-tools/shared-model";
import type {
  ClientProtocol,
  ModelTarget,
  RequestedFeatures,
} from "@dbx-tools/shared-model-gateway";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import { z } from "zod";

import { resolveRoute } from "./router.ts";

const logger = log.logger("appkit/model-gateway/automatic");
const ROUTE_CACHE_NAMESPACE = "model-gateway-auto-route";
const ROUTE_POLICY_VERSION = 1;
const SELECTOR_ENCODING = new Tiktoken(o200kBase);

const ROUTE_CHOICES = [
  routeChoice("fast_minimal_short_response", "fast", "minimal", "short_response"),
  routeChoice("fast_low_extraction", "fast", "low", "extraction"),
  routeChoice("balanced_low_routine_qa", "balanced", "low", "routine_qa"),
  routeChoice("balanced_medium_tool_use", "balanced", "medium", "tool_use"),
  routeChoice("thinking_high_research", "thinking", "high", "research"),
  routeChoice("thinking_high_debugging", "thinking", "high", "debugging"),
  routeChoice("thinking_high_code_change", "thinking", "high", "code_change"),
  routeChoice("thinking_xhigh_large_refactor", "thinking", "xhigh", "large_refactor"),
  routeChoice("thinking_high_long_context", "thinking", "high", "long_context"),
  routeChoice("balanced_medium_ambiguous", "balanced", "medium", "ambiguous"),
] as const;

const ROUTE_CHOICE_BY_ID = new Map(ROUTE_CHOICES.map((choice) => [choice.id, choice.decision]));

const SystemOneResponseSchema = z
  .object({
    decisions: z.object({
      route: z.object({
        answer: z.object({
          type: z.literal("choice"),
          choice: z.string().min(1),
          confidence: z.number().finite().min(0).max(1),
          probabilities: z.record(z.string(), z.number().finite().min(0).max(1)).optional(),
        }),
      }),
    }),
  })
  .passthrough();

/** Selector service used by automatic routing. */
export interface AutomaticRouteSelector {
  select(request: AutomaticRouteRequest, signal: AbortSignal): Promise<AutomaticRouteDecision>;
}

/** Portable persistence surface for pinned automatic turn decisions. */
export interface AutomaticRouteStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: AutomaticRouteObservation, ttlSeconds: number): Promise<void>;
}

/** Runtime settings for automatic routing. */
export interface AutomaticRouteSettings {
  readonly minimumConfidence: number;
  readonly preferCostEfficientModels: boolean;
  readonly routeTtlSeconds: number;
  readonly selectorModel: string;
  readonly selectorTokenBudget: number;
  readonly selectorTimeoutMs: number;
}

/** Result applied to one concrete gateway request. */
export interface AutomaticRouteResult {
  readonly body: Readonly<Record<string, unknown>>;
  readonly observation: AutomaticRouteObservation;
  readonly target: ModelTarget;
}

/** Route-affecting policy included in a logical-turn cache key. */
export interface AutomaticTurnKeyContext {
  readonly explicitReasoningEffort?: ReasoningEffort;
  readonly features: AutomaticRouteRequest["features"];
  readonly preferSystemModels: boolean;
}

/** Error carrying an HTTP status for automatic-routing validation failures. */
export class AutomaticRoutingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AutomaticRoutingError";
  }
}

/** AppKit cache adapter; configured Lakebase/Postgres storage remains AppKit-owned. */
export class AppKitAutomaticRouteStore implements AutomaticRouteStore {
  async get(key: string): Promise<unknown> {
    const cache = await CacheManager.getInstance();
    return cache.get(cache.generateKey([ROUTE_CACHE_NAMESPACE, ROUTE_POLICY_VERSION], key));
  }

  async set(key: string, value: AutomaticRouteObservation, ttlSeconds: number): Promise<void> {
    const cache = await CacheManager.getInstance();
    await cache.set(cache.generateKey([ROUTE_CACHE_NAMESPACE, ROUTE_POLICY_VERSION], key), value, {
      ttl: ttlSeconds,
    });
  }
}

/** Databricks System One selector using the current AppKit execution identity. */
export class SystemOneAutomaticRouteSelector implements AutomaticRouteSelector {
  constructor(
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async select(
    request: AutomaticRouteRequest,
    signal: AbortSignal,
  ): Promise<AutomaticRouteDecision> {
    const choices = ROUTE_CHOICES.filter((choice) => request.eligibleTiers.includes(choice.tier));
    const response = await invokeSystemOne(
      {
        model: this.model,
        state: JSON.stringify(request),
        questions: [
          {
            name: "route",
            instruction:
              "Choose the least expensive route that can complete the request reliably. Use thinking for difficult research, debugging, broad code changes, large refactors, or long-context synthesis. Do not downgrade a short follow-up when recent context shows a complex ongoing task.",
            choices: choices.map((choice) => ({ choice: choice.id, criteria: choice.criteria })),
          },
        ],
      },
      signal,
      this.timeoutMs,
    );
    const parsed = SystemOneResponseSchema.parse(response);
    const answer = parsed.decisions.route.answer;
    const decision = ROUTE_CHOICE_BY_ID.get(answer.choice);
    if (!decision || !request.eligibleTiers.includes(decision.tier)) {
      throw new Error(`System One returned an ineligible route choice: ${answer.choice}`);
    }
    return AutomaticRouteDecisionSchema.parse({ ...decision, confidence: answer.confidence });
  }
}

/** Automatic router shared by Responses, Chat Completions, and Anthropic Messages. */
export class AutomaticModelRouter {
  constructor(
    private readonly settings: AutomaticRouteSettings,
    private readonly selector: AutomaticRouteSelector = new SystemOneAutomaticRouteSelector(
      settings.selectorModel,
      settings.selectorTimeoutMs,
    ),
    private readonly store: AutomaticRouteStore = new AppKitAutomaticRouteStore(),
  ) {}

  async resolve(input: {
    readonly body: Readonly<Record<string, unknown>>;
    readonly features: RequestedFeatures;
    readonly headers: Headers;
    readonly preferSystemModels: boolean;
    readonly protocol: Exclude<ClientProtocol, "openai-embeddings">;
    readonly signal: AbortSignal;
    readonly targets: readonly ModelTarget[];
  }): Promise<AutomaticRouteResult> {
    const explicitReasoningEffort = requestedReasoningEffort(input.body);
    const eligibleTargets = input.targets.filter((target) =>
      isEligibleTarget(
        target,
        { ...input, originator: input.headers.get("originator") ?? undefined },
        explicitReasoningEffort,
      ),
    );
    if (eligibleTargets.length === 0) {
      throw new AutomaticRoutingError(
        400,
        "No live model can preserve the requested protocol and capabilities for automatic routing",
      );
    }

    const eligibleTiers = automaticTiers(eligibleTargets);
    const request = summarizeAutomaticRequest(
      input.protocol,
      input.body,
      input.features,
      eligibleTiers,
      this.settings.selectorTokenBudget,
    );
    const key = automaticTurnKey(input.protocol, input.body, request.toolNames, {
      features: request.features,
      preferSystemModels: input.preferSystemModels,
      ...(explicitReasoningEffort ? { explicitReasoningEffort } : {}),
    });
    const cached = request.continuation
      ? await this.readCached(key, eligibleTargets, explicitReasoningEffort)
      : undefined;
    const explicitReasoningControl = hasExplicitReasoningControl(
      input.protocol,
      input.body,
      explicitReasoningEffort,
    );
    if (cached) {
      const target = eligibleTargets.find((candidate) => candidate.id === cached.selectedModel)!;
      return {
        target,
        observation: { ...cached, source: "cache" },
        body: applyAutomaticReasoning(
          input.protocol,
          input.body,
          cached.reasoningEffort,
          explicitReasoningControl,
        ),
      };
    }

    const selected = await this.selectDecision(request, explicitReasoningEffort, input.signal);
    const endpoints = eligibleTargets
      .map((target) => target.endpoint)
      .filter(
        (endpoint): endpoint is NonNullable<ModelTarget["endpoint"]> => endpoint !== undefined,
      );
    const resolved = resolveAutomaticModel(endpoints, selected.decision, {
      preferSystemModels: input.preferSystemModels,
      preferCostEfficientModels: this.settings.preferCostEfficientModels,
      ...(explicitReasoningEffort ? { explicitReasoningEffort } : {}),
    });
    const target = eligibleTargets.find((candidate) => candidate.id === resolved.endpoint.name);
    if (!target) {
      throw new AutomaticRoutingError(500, "Automatic routing resolved an unavailable model");
    }
    const observation = AutomaticRouteObservationSchema.parse({
      selectedModel: target.id,
      tier: resolved.tier,
      ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
      confidence: selected.decision.confidence,
      reasonCode: selected.decision.reasonCode,
      source: selected.source,
      degraded: selected.degraded,
      ...(selected.selectorLatencyMs !== undefined
        ? { selectorLatencyMs: selected.selectorLatencyMs }
        : {}),
      ...(selected.selectorCalled ? { selectorModel: this.settings.selectorModel } : {}),
    });
    await this.writeCached(key, observation);
    logger.info("selected automatic route", {
      candidateCount: eligibleTargets.length,
      confidence: observation.confidence,
      degraded: observation.degraded,
      model: observation.selectedModel,
      reasonCode: observation.reasonCode,
      source: observation.source,
      tier: observation.tier,
    });
    return {
      target,
      observation,
      body: applyAutomaticReasoning(
        input.protocol,
        input.body,
        observation.reasoningEffort,
        explicitReasoningControl,
      ),
    };
  }

  private async selectDecision(
    request: AutomaticRouteRequest,
    explicitReasoningEffort: ReasoningEffort | undefined,
    signal: AbortSignal,
  ): Promise<{
    decision: AutomaticRouteDecision;
    degraded: boolean;
    selectorCalled: boolean;
    selectorLatencyMs?: number;
    source: AutomaticRouteDecisionSource;
  }> {
    if (request.eligibleTiers.length === 1) {
      return {
        decision: automaticDecisionForOnlyTier(request.eligibleTiers[0]!),
        degraded: false,
        selectorCalled: false,
        source: "heuristic",
      };
    }
    if (explicitReasoningEffort) {
      return {
        decision: automaticDecisionForReasoning(explicitReasoningEffort, request.eligibleTiers),
        degraded: false,
        selectorCalled: false,
        source: "heuristic",
      };
    }
    const startedAt = Date.now();
    try {
      const decision = await this.selector.select(request, signal);
      const selectorLatencyMs = Date.now() - startedAt;
      if (decision.confidence < this.settings.minimumConfidence) {
        return {
          decision: fallbackAutomaticRouteDecision(request),
          degraded: true,
          selectorCalled: true,
          selectorLatencyMs,
          source: "fallback",
        };
      }
      return {
        decision,
        degraded: false,
        selectorCalled: true,
        selectorLatencyMs,
        source: "selector",
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      logger.warn("automatic selector unavailable; using deterministic fallback", {
        elapsedMs: Date.now() - startedAt,
        error: toError(error),
        selectorModel: this.settings.selectorModel,
      });
      return {
        decision: fallbackAutomaticRouteDecision(request),
        degraded: true,
        selectorCalled: true,
        selectorLatencyMs: Date.now() - startedAt,
        source: "fallback",
      };
    }
  }

  private async readCached(
    key: string,
    targets: readonly ModelTarget[],
    explicitReasoningEffort: ReasoningEffort | undefined,
  ): Promise<AutomaticRouteObservation | undefined> {
    try {
      const parsed = AutomaticRouteObservationSchema.safeParse(await this.store.get(key));
      if (!parsed.success) return undefined;
      if (!targets.some((target) => target.id === parsed.data.selectedModel)) return undefined;
      if (
        explicitReasoningEffort !== undefined &&
        parsed.data.reasoningEffort !== explicitReasoningEffort
      ) {
        return undefined;
      }
      return parsed.data;
    } catch (error) {
      logger.debug("automatic route cache read failed", { error: toError(error) });
      return undefined;
    }
  }

  private async writeCached(key: string, observation: AutomaticRouteObservation): Promise<void> {
    try {
      await this.store.set(key, observation, this.settings.routeTtlSeconds);
    } catch (error) {
      logger.debug("automatic route cache write failed", { error: toError(error) });
    }
  }
}

/** Build bounded selector state without tool arguments, binary data, or credentials. */
export function summarizeAutomaticRequest(
  protocol: Exclude<ClientProtocol, "openai-embeddings">,
  body: Readonly<Record<string, unknown>>,
  features: RequestedFeatures,
  eligibleTiers: readonly AutomaticRouteTier[],
  selectorTokenBudget = 4_096,
): AutomaticRouteRequest {
  const events = conversationEvents(protocol, body);
  const latestUserIndex = lastUserEventIndex(events);
  const latestUser = latestUserIndex >= 0 ? (events[latestUserIndex]?.text ?? "") : "";
  const currentRequest = truncateSelectorText(latestUser, selectorTokenBudget, "start");
  const currentTokens = countSelectorTokens(currentRequest);
  const recentContext = selectRecentContext(
    events.slice(0, Math.max(0, latestUserIndex)),
    Math.max(0, selectorTokenBudget - currentTokens),
  );
  const selectorTokens =
    currentTokens +
    recentContext.reduce((total, message) => total + countSelectorTokens(message), 0);
  const toolNames = requestToolNames(body);
  return AutomaticRouteRequestSchema.parse({
    protocol,
    currentRequest,
    recentContext,
    toolNames,
    inputCharacters: events.reduce((total, event) => total + event.text.length, 0),
    selectorTokens,
    continuation:
      latestUserIndex >= 0 &&
      events.slice(latestUserIndex + 1).some((event) => event.role !== "system"),
    features: {
      tools: features.tools,
      webSearch: features.webSearch,
      imageInput: features.imageInput,
      structuredOutput: features.structuredOutput,
      applyPatch: features.applyPatch,
    },
    eligibleTiers: [...eligibleTiers],
  });
}

function selectRecentContext(events: readonly ConversationEvent[], tokenBudget: number): string[] {
  if (tokenBudget <= 0) return [];
  const selected: string[] = [];
  let remaining = tokenBudget;
  for (let index = events.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const event = events[index];
    if (!event || (event.role !== "user" && event.role !== "assistant") || !event.text) continue;
    const prefix = `${event.role}: `;
    const prefixTokens = countSelectorTokens(prefix);
    if (prefixTokens >= remaining) break;
    const contentBudget = remaining - prefixTokens;
    const contentTokens = countSelectorTokens(event.text);
    const content =
      contentTokens <= contentBudget
        ? event.text
        : truncateSelectorText(event.text, contentBudget, "end");
    const formatted = `${prefix}${content}`;
    const tokens = countSelectorTokens(formatted);
    if (tokens > remaining) break;
    selected.push(formatted);
    remaining -= tokens;
    if (contentTokens > contentBudget) break;
  }
  return selected.reverse();
}

function countSelectorTokens(text: string): number {
  return SELECTOR_ENCODING.encode(text, [], []).length;
}

function truncateSelectorText(text: string, tokenBudget: number, edge: "start" | "end"): string {
  if (tokenBudget <= 0 || !text) return "";
  const tokens = SELECTOR_ENCODING.encode(text, [], []);
  if (tokens.length <= tokenBudget) return text;
  return SELECTOR_ENCODING.decode(
    edge === "start" ? tokens.slice(0, tokenBudget) : tokens.slice(-tokenBudget),
  );
}

/** Stable logical-turn key shared by initial requests and later tool continuations. */
export function automaticTurnKey(
  protocol: Exclude<ClientProtocol, "openai-embeddings">,
  body: Readonly<Record<string, unknown>>,
  toolNames = requestToolNames(body),
  context?: AutomaticTurnKeyContext,
): string {
  const events = conversationEvents(protocol, body);
  const latestUserIndex = lastUserEventIndex(events);
  const stableEvents = latestUserIndex >= 0 ? events.slice(0, latestUserIndex + 1) : events;
  return createHash("sha256")
    .update(
      JSON.stringify({
        protocol,
        events: stableEvents.map((event) => ({ role: event.role, text: event.text })),
        toolNames,
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
): boolean {
  if (!target.endpoint || target.endpoint.status?.deprecated === true) return false;
  if (!target.capabilities.chat) return false;
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
    throw new AutomaticRoutingError(400, `Unsupported automatic reasoning effort: ${String(raw)}`);
  }
  return parsed.data;
}

function hasExplicitReasoningControl(
  protocol: Exclude<ClientProtocol, "openai-embeddings">,
  body: Readonly<Record<string, unknown>>,
  explicitReasoningEffort: ReasoningEffort | undefined,
): boolean {
  if (explicitReasoningEffort !== undefined) return true;
  return protocol === "anthropic-messages" && Object.hasOwn(body, "thinking");
}

function automaticTiers(targets: readonly ModelTarget[]): AutomaticRouteTier[] {
  const tiers = new Set<AutomaticRouteTier>();
  for (const target of targets) {
    tiers.add(automaticTierForModelClass(target.endpoint?.class ?? ModelClass.ChatBalanced));
  }
  return ["fast", "balanced", "thinking"].filter((tier): tier is AutomaticRouteTier =>
    tiers.has(tier as AutomaticRouteTier),
  );
}

function applyAutomaticReasoning(
  protocol: Exclude<ClientProtocol, "openai-embeddings">,
  body: Readonly<Record<string, unknown>>,
  effort: ReasoningEffort | undefined,
  explicitReasoning: boolean,
): Readonly<Record<string, unknown>> {
  if (!effort || explicitReasoning) return body;
  if (protocol === "openai-responses") {
    const reasoning = isRecord(body.reasoning) ? body.reasoning : {};
    return { ...body, reasoning: { ...reasoning, effort } };
  }
  if (protocol === "openai-chat") return { ...body, reasoning_effort: effort };
  const outputConfig = isRecord(body.output_config) ? body.output_config : {};
  if (effort === "none") {
    return { ...body, thinking: { type: "disabled" }, output_config: outputConfig };
  }
  return {
    ...body,
    thinking: { type: "adaptive" },
    output_config: { ...outputConfig, effort },
  };
}

interface ConversationEvent {
  readonly role: "assistant" | "system" | "tool" | "user";
  readonly text: string;
}

function lastUserEventIndex(events: readonly ConversationEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.role === "user") return index;
  }
  return -1;
}

function conversationEvents(
  protocol: Exclude<ClientProtocol, "openai-embeddings">,
  body: Readonly<Record<string, unknown>>,
): ConversationEvent[] {
  const source = protocol === "openai-responses" ? body.input : body.messages;
  if (typeof source === "string") return [{ role: "user", text: source }];
  if (!Array.isArray(source)) return [];
  return source.flatMap((item): ConversationEvent[] => {
    if (!isRecord(item)) return [];
    const role = eventRole(item);
    if (!role) return [];
    return [{ role, text: contentText(item.content ?? item.text ?? item.input_text) }];
  });
}

function eventRole(item: Readonly<Record<string, unknown>>): ConversationEvent["role"] | undefined {
  if (item.role === "user" || item.role === "assistant" || item.role === "system") return item.role;
  if (item.role === "tool") return "tool";
  if (item.type === "function_call_output" || item.type === "tool_result") return "tool";
  if (item.type === "function_call" || item.type === "reasoning") return "assistant";
  return undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  for (const key of ["text", "input_text", "output_text", "content"] as const) {
    const text = contentText(value[key]);
    if (text) return text;
  }
  return "";
}

function requestToolNames(body: Readonly<Record<string, unknown>>): string[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools
    .filter((tool): tool is Record<string, unknown> => isRecord(tool))
    .map((tool) => {
      if (typeof tool.name === "string") return tool.name;
      return isRecord(tool.function) && typeof tool.function.name === "string"
        ? tool.function.name
        : undefined;
    })
    .filter((name): name is string => Boolean(name?.trim()))
    .map((name) => name.trim().slice(0, 200))
    .slice(0, 64);
}

function routeChoice(
  id: string,
  tier: AutomaticRouteTier,
  reasoningEffort: ReasoningEffort,
  reasonCode: AutomaticRouteDecision["reasonCode"],
) {
  return {
    id,
    tier,
    decision: { tier, reasoningEffort, confidence: 1, reasonCode },
    criteria: routeCriteria(tier, reasonCode),
  } as const;
}

function routeCriteria(
  tier: AutomaticRouteTier,
  reasonCode: AutomaticRouteDecision["reasonCode"],
): string {
  return `${tier} route for ${reasonCode.replaceAll("_", " ")} tasks`;
}

async function invokeSystemOne(
  body: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const client = getExecutionContext().client;
  const host = (await client.config.getHost()).toString();
  const url = new URL("/ai-gateway/typesafe/v1/systemone", host);
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
    await response.body?.cancel();
    throw new Error(`System One selector failed with HTTP ${response.status}`);
  }
  return response.json();
}

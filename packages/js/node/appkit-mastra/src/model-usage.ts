/** Caller-facing Mastra model routing and token-usage events. */

import {
  MODEL_ROUTE_PART_TYPE,
  MODEL_USAGE_PART_TYPE,
  ModelRoutePartDataSchema,
  ModelUsagePartDataSchema,
  type ModelRoutePartData,
  type ModelUsagePartData,
} from "@dbx-tools/shared-mastra";
import { estimateModelTokenPrice } from "@dbx-tools/model";
import type { RequestContext } from "@mastra/core/request-context";

import { MASTRA_MODEL_ROUTE_KEY, type MastraModelRoute } from "./serving.ts";

/** Minimal Mastra usage shape required to publish one cumulative snapshot. */
export interface MastraTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

/** Minimal custom writer supplied to Mastra's native `onFinish` callback. */
export interface MastraFinishWriter {
  custom(data: {
    type: `data-${string}`;
    data: unknown;
    transient?: boolean;
  }): void | Promise<void>;
}

/** Build the validated caller-facing route event once model selection resolves. */
export function modelRoutePartData(
  requestContext: Pick<RequestContext, "get">,
  runId?: string,
): ModelRoutePartData | undefined {
  const route = requestContext.get(MASTRA_MODEL_ROUTE_KEY) as MastraModelRoute | undefined;
  if (!route) return undefined;
  const pricing = estimateModelTokenPrice(route.model, {})?.rate;
  return ModelRoutePartDataSchema.parse({
    ...(runId ? { runId } : {}),
    model: route.model,
    selection: route.selection,
    ...(route.smartRouter ? { smartRouter: route.smartRouter } : {}),
    ...(route.aiDecide ? { aiDecide: route.aiDecide } : {}),
    ...(pricing ? { pricing } : {}),
  });
}

/** Build a validated caller-facing cumulative usage snapshot. */
export function modelUsagePartData(
  requestContext: Pick<RequestContext, "get">,
  usage: MastraTurnUsage,
  runId?: string,
): ModelUsagePartData | undefined {
  const route = requestContext.get(MASTRA_MODEL_ROUTE_KEY) as MastraModelRoute | undefined;
  if (!route) return undefined;
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const totalTokens = tokenCount(usage.totalTokens ?? inputTokens + outputTokens);
  const cachedInputTokens = tokenCount(usage.cachedInputTokens);
  const price = estimateModelTokenPrice(route.model, {
    inputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens,
    cacheReadTokens: cachedInputTokens,
  });
  return ModelUsagePartDataSchema.parse({
    ...modelRoutePartData(requestContext, runId),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(usage.reasoningTokens !== undefined
        ? { reasoningTokens: tokenCount(usage.reasoningTokens) }
        : {}),
      ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    },
    ...(price ? { estimatedCostDbu: price.price.dbu } : {}),
  });
}

/** Emit the selected route through a Mastra custom writer. */
export async function emitModelRoutePart(
  requestContext: Pick<RequestContext, "get">,
  writer: MastraFinishWriter | undefined,
  runId?: string,
): Promise<void> {
  const data = modelRoutePartData(requestContext, runId);
  if (!data || !writer) return;
  await writer.custom({ type: MODEL_ROUTE_PART_TYPE, data });
}

/** Emit a persistent AI SDK data part through Mastra's native finish writer. */
export async function emitModelUsagePart(
  requestContext: Pick<RequestContext, "get">,
  usage: MastraTurnUsage,
  writer: MastraFinishWriter | undefined,
  runId?: string,
): Promise<void> {
  const data = modelUsagePartData(requestContext, usage, runId);
  if (!data || !writer) return;
  await writer.custom({ type: MODEL_USAGE_PART_TYPE, data });
}

function tokenCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value!)) : 0;
}

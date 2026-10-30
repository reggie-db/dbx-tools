/** Caller-facing Mastra model routing and token-usage events. */

import {
  MODEL_USAGE_PART_TYPE,
  ModelUsagePartDataSchema,
  type ModelUsagePartData,
} from "@dbx-tools/shared-mastra";
import type { RequestContext } from "@mastra/core/request-context";

import { MASTRA_MODEL_ROUTE_KEY, type MastraModelRoute } from "./serving.ts";

/** Minimal Mastra usage shape required to publish one completed turn. */
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

/** Build the validated caller-facing event for one completed agent turn. */
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
  const estimatedCostUsd =
    route.costPerMillionTokens !== undefined
      ? (totalTokens * route.costPerMillionTokens) / 1_000_000
      : undefined;
  return ModelUsagePartDataSchema.parse({
    ...(runId ? { runId } : {}),
    model: route.model,
    selection: route.selection,
    ...(route.smartRouter ? { smartRouter: route.smartRouter } : {}),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(usage.reasoningTokens !== undefined
        ? { reasoningTokens: tokenCount(usage.reasoningTokens) }
        : {}),
      ...(usage.cachedInputTokens !== undefined
        ? { cachedInputTokens: tokenCount(usage.cachedInputTokens) }
        : {}),
    },
    ...(route.costPerMillionTokens !== undefined
      ? { costPerMillionTokens: route.costPerMillionTokens }
      : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
  });
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

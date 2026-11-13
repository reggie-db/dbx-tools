import { Tooltip, TooltipContent, TooltipTrigger, cn } from "@databricks/appkit-ui/react";
import {
  MODEL_ROUTE_PART_TYPE,
  MODEL_USAGE_PART_TYPE,
  ModelRoutePartDataSchema,
  ModelUsagePartDataSchema,
  type ModelRoutePartData,
  type ModelUsagePartData,
} from "@dbx-tools/shared-mastra";
import { toModelDisplayName } from "@dbx-tools/shared-model";
import type { UIMessage } from "ai";
import { RouteIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import type { ChatMetric, ChatMetrics } from "./types.ts";
import { readBrowserMessageTimestamps } from "../support/browser-transcript.ts";

const ALL_METRICS = ["tokens", "time", "dbu", "usd"] as const satisfies readonly ChatMetric[];

/** Model route and latest cumulative usage stored on one assistant turn. */
export interface SelectedModelActivity {
  route: ModelRoutePartData;
  usage?: ModelUsagePartData;
}

/** Minimal assistant message shape needed for route and metric rendering. */
export interface SelectedModelMessage {
  metadata?: unknown;
  parts: readonly { type: string; data?: unknown }[];
}

/** Read the model route and latest usage stored on one assistant turn. */
export function selectedModelActivity(
  message: SelectedModelMessage,
): SelectedModelActivity | undefined {
  let route: ModelRoutePartData | undefined;
  let usage: ModelUsagePartData | undefined;
  for (const part of message.parts) {
    if (part.type === MODEL_ROUTE_PART_TYPE) {
      const parsed = ModelRoutePartDataSchema.safeParse((part as { data?: unknown }).data);
      if (parsed.success) route ??= parsed.data;
    }
    if (part.type === MODEL_USAGE_PART_TYPE) {
      const parsed = ModelUsagePartDataSchema.safeParse((part as { data?: unknown }).data);
      if (parsed.success) {
        route ??= parsed.data;
        usage = parsed.data;
      }
    }
  }
  return route ? { route, ...(usage ? { usage } : {}) } : undefined;
}

/** Read the earliest available model route stored on one assistant turn. */
export const selectedModelRoute = (message: SelectedModelMessage): ModelRoutePartData | undefined =>
  selectedModelActivity(message)?.route;

/** Normalize the public one-or-many metric option while preserving caller order. */
export function normalizeChatMetrics(metrics: ChatMetrics | undefined): ChatMetric[] {
  if (metrics === undefined) return [];
  return [...new Set(Array.isArray(metrics) ? metrics : [metrics])];
}

type MetricValues = Record<ChatMetric, string>;

/** Numeric per-turn metrics derived from persisted route, usage, and timestamps. */
export interface SelectedModelTurnMetrics {
  tokens?: number;
  timeMs?: number;
  dbu?: number;
  usd?: number;
}

function elapsedMs(
  message: Pick<UIMessage, "metadata">,
  active: boolean,
  now: number,
  fallbackStartedAt: number,
): number | undefined {
  const timestamps = readBrowserMessageTimestamps(message);
  if (!timestamps) return active ? Math.max(0, now - fallbackStartedAt) : undefined;
  const startedAt = Date.parse(timestamps.createdAt);
  const completedAt = timestamps.completedAt
    ? Date.parse(timestamps.completedAt)
    : active
      ? now
      : NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return undefined;
  return Math.max(0, completedAt - startedAt);
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return "—";
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}

function formatTokens(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1_000) return value.toLocaleString();
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
}

function formatDbu(value: number | undefined): string {
  if (value === undefined) return "—";
  return `${value < 0.001 ? value.toFixed(6) : value.toFixed(4)} DBU`;
}

function formatUsd(value: number | undefined): string {
  if (value === undefined) return "—";
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

function activityTurnMetrics(
  activity: SelectedModelActivity,
  message: Pick<UIMessage, "metadata">,
  active: boolean,
  now: number,
  fallbackStartedAt: number,
): SelectedModelTurnMetrics {
  const dbu = activity.usage?.estimatedCostDbu;
  const usd = activity.usage?.estimatedCostUsd;
  const timeMs = elapsedMs(message, active, now, fallbackStartedAt);
  return {
    ...(activity.usage ? { tokens: activity.usage.usage.totalTokens } : {}),
    ...(timeMs !== undefined ? { timeMs } : {}),
    ...(dbu !== undefined ? { dbu } : {}),
    ...(usd !== undefined ? { usd } : {}),
  };
}

/** Read completed per-turn metrics from one assistant message. */
export function selectedModelTurnMetrics(
  message: SelectedModelMessage,
): SelectedModelTurnMetrics | undefined {
  const activity = selectedModelActivity(message);
  if (!activity) return undefined;
  return activityTurnMetrics(activity, message, false, 0, 0);
}

function metricValues(
  activity: SelectedModelActivity,
  message: Pick<UIMessage, "metadata">,
  active: boolean,
  now: number,
  fallbackStartedAt: number,
): MetricValues {
  const values = activityTurnMetrics(activity, message, active, now, fallbackStartedAt);
  return {
    tokens: formatTokens(values.tokens),
    time: formatDuration(values.timeMs),
    dbu: formatDbu(values.dbu),
    usd: formatUsd(values.usd),
  };
}

const metricLabel = (metric: ChatMetric): string =>
  ({ tokens: "Tokens", time: "Time", dbu: "DBU", usd: "USD" })[metric];

const MetricsTooltip = ({ values }: { values: MetricValues }) => (
  <TooltipContent>
    <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-xs">
      {ALL_METRICS.map((metric) => (
        <div key={metric} className="contents">
          <dt className="text-muted-foreground">{metricLabel(metric)}</dt>
          <dd className="text-right font-mono tabular-nums">{values[metric]}</dd>
        </div>
      ))}
    </dl>
  </TooltipContent>
);

/** Compact per-turn row for the model selected before generation begins. */
export const SelectedModelPill = ({
  activity,
  message,
  showModel = true,
  metrics,
  active = false,
  children,
}: {
  activity: SelectedModelActivity;
  message: Pick<UIMessage, "metadata">;
  showModel?: boolean;
  metrics?: ChatMetrics;
  active?: boolean;
  children?: ReactNode;
}) => {
  const selectedMetrics = normalizeChatMetrics(metrics);
  const [fallbackStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const updateTime = active && selectedMetrics.includes("time");
  useEffect(() => {
    if (!updateTime) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [updateTime]);
  if (!showModel && selectedMetrics.length === 0) return null;

  const route = activity.route;
  const values = metricValues(activity, message, active, now, fallbackStartedAt);
  const friendlyName = toModelDisplayName(route.model);
  return (
    <div
      data-slot="selected-model-pill"
      className="flex min-h-7 min-w-0 max-w-full flex-1 items-center gap-1 overflow-hidden text-xs text-muted-foreground"
    >
      {showModel ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="mr-1 flex min-w-0 items-center gap-1.5 truncate rounded-sm px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${friendlyName}: ${route.model}`}
            >
              <RouteIcon className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{friendlyName}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <span className="font-mono text-xs">{route.model}</span>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {children}
      {selectedMetrics.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className={cn(
                "ml-auto flex min-w-0 shrink-0 items-center justify-end gap-2 rounded-sm px-1 font-mono text-[10px] tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                !showModel && "w-full",
              )}
              aria-label={ALL_METRICS.map(
                (metric) => `${metricLabel(metric)} ${values[metric]}`,
              ).join(", ")}
            >
              {selectedMetrics.map((metric) => (
                <span key={metric} className="whitespace-nowrap">
                  {values[metric]}
                </span>
              ))}
            </span>
          </TooltipTrigger>
          <MetricsTooltip values={values} />
        </Tooltip>
      ) : null}
    </div>
  );
};

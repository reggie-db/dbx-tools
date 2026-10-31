import {
  MODEL_ROUTE_PART_TYPE,
  MODEL_USAGE_PART_TYPE,
  ModelRoutePartDataSchema,
  ModelUsagePartDataSchema,
  type ModelRoutePartData,
} from "@dbx-tools/shared-mastra";
import { toModelDisplayName } from "@dbx-tools/shared-model";
import type { UIMessage } from "ai";
import { RouteIcon } from "lucide-react";

/** Read the earliest available model route stored on one assistant turn. */
export function selectedModelRoute(message: UIMessage): ModelRoutePartData | undefined {
  for (const part of message.parts) {
    if (part.type === MODEL_ROUTE_PART_TYPE) {
      const parsed = ModelRoutePartDataSchema.safeParse((part as { data?: unknown }).data);
      if (parsed.success) return parsed.data;
    }
    if (part.type === MODEL_USAGE_PART_TYPE) {
      const parsed = ModelUsagePartDataSchema.safeParse((part as { data?: unknown }).data);
      if (parsed.success) return parsed.data;
    }
  }
  return undefined;
}

/** Compact per-turn row for the model selected before generation begins. */
export const SelectedModelPill = ({ route }: { route: ModelRoutePartData }) => (
  <div
    data-slot="selected-model-pill"
    className="min-w-0 max-w-full overflow-hidden rounded-md border border-border/40 bg-background/30 px-2 py-1 text-xs text-muted-foreground"
  >
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-0.5">
      <RouteIcon className="size-3 shrink-0" aria-hidden />
      <span>{toModelDisplayName(route.model)}</span>
      <span className="min-w-0 break-all font-mono text-[10px]">{route.model}</span>
    </div>
  </div>
);

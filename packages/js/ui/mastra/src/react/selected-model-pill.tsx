import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@databricks/appkit-ui/react";
import {
  MODEL_ROUTE_PART_TYPE,
  MODEL_USAGE_PART_TYPE,
  ModelRoutePartDataSchema,
  ModelUsagePartDataSchema,
  type ModelRoutePartData,
} from "@dbx-tools/shared-mastra";
import { toModelDisplayName } from "@dbx-tools/shared-model";
import type { UIMessage } from "ai";
import { ChevronDownIcon, RouteIcon } from "lucide-react";

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

/** Compact per-turn disclosure for the model selected before generation begins. */
export const SelectedModelPill = ({ route }: { route: ModelRoutePartData }) => (
  <Collapsible
    data-slot="selected-model-pill"
    className="w-fit max-w-full overflow-hidden rounded-full border border-border/60 bg-muted/35 text-xs text-muted-foreground"
  >
    <CollapsibleTrigger className="group flex max-w-full cursor-pointer items-center gap-1.5 px-2.5 py-1 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <RouteIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{toModelDisplayName(route.model)}</span>
      <ChevronDownIcon className="size-3 shrink-0 transition-transform group-data-[state=closed]:-rotate-90" />
    </CollapsibleTrigger>
    <CollapsibleContent className="max-w-72 overflow-hidden px-2.5 pb-1.5">
      <div className="break-all font-mono text-[10px]">{route.model}</div>
    </CollapsibleContent>
  </Collapsible>
);

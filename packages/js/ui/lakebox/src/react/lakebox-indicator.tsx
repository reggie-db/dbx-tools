import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@dbx-tools/ui/react";
import { MonitorIcon, ServerIcon, SquareTerminalIcon } from "lucide-react";
import { useState } from "react";
import { useLakeboxClient } from "./client.ts";
import { LakeboxMetrics } from "./lakebox-metrics.tsx";
import { StatusDot, statusLabel } from "./lakebox-panel.tsx";
import { lakeboxTransitioning, useLakebox, useLakeboxMetrics } from "./use-lakebox.ts";

/** Props for {@link LakeboxIndicator}. */
export interface LakeboxIndicatorProps {
  basePath?: string;
  className?: string;
}

/**
 * Compact Lakebox status for chat headers. Opens a popover with the user's
 * terminal and desktop plus live CPU and memory.
 */
export function LakeboxIndicator({ basePath, className }: LakeboxIndicatorProps) {
  const client = useLakeboxClient(basePath);
  const [open, setOpen] = useState(false);
  const state = useLakebox(client, open);
  const { summary } = state;
  const series = useLakeboxMetrics(client, open && summary?.status === "running");
  const launchers = summary?.services.filter(
    (service) => service.kind === "terminal" || service.kind === "desktop",
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Lakebox"
              className={cn("relative size-7 shrink-0", className)}
            >
              <ServerIcon className="size-4" />
              <StatusDot
                status={summary?.status}
                className="absolute bottom-1 right-1 size-1.5 ring-1 ring-background"
              />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Lakebox</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 space-y-3 p-3" aria-label="Lakebox">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot status={summary?.status} />
            <span className="truncate text-sm font-medium">Lakebox</span>
            <span className="text-xs text-muted-foreground">
              {statusLabel(summary?.status, state.loading)}
            </span>
            {lakeboxTransitioning(summary) ? <Spinner className="size-3" /> : null}
          </div>
        </div>
        {summary?.supported === false ? (
          <p className="text-sm text-muted-foreground">
            Lakeboxes are not available in this workspace.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {(launchers ?? []).map((service) => {
              const Icon = service.kind === "desktop" ? MonitorIcon : SquareTerminalIcon;
              const starting =
                state.busy.has(`service:${service.name}:start`) || service.state === "starting";
              return (
                <Button
                  key={service.name}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={starting || summary?.status === "stopping"}
                  onClick={() => void state.open(service)}
                >
                  {starting ? <Spinner className="size-3.5" /> : <Icon className="size-3.5" />}
                  {service.name === "desktop" ? "Desktop" : "Terminal"}
                </Button>
              );
            })}
          </div>
        )}
        {summary?.status === "running" ? <LakeboxMetrics series={series} compact /> : null}
        {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      </PopoverContent>
    </Popover>
  );
}

import type { SshMachine, SshMachineServiceKind } from "@dbx-tools/shared-databricks-sandbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
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
import {
  HeartPulseIcon,
  MonitorIcon,
  PlayIcon,
  ServerIcon,
  SquareIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SshClient } from "./client.ts";
import { resolveServiceUrl } from "./service-url.ts";

/** Props for the compact SSH machine status and control popover. */
export interface SshIndicatorProps {
  basePath?: string;
  className?: string;
}

/** Renders SSH machine status with start, stop, and open actions. */
export function SshIndicator({
  basePath = "/api/databricks-sandbox",
  className,
}: SshIndicatorProps) {
  const client = useMemo(() => new SshClient(basePath), [basePath]);
  const [open, setOpen] = useState(false);
  const [machines, setMachines] = useState<SshMachine[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const [expandedId, setExpandedId] = useState<string>();
  const [stopTarget, setStopTarget] = useState<SshMachine>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await client.listMachines();
      setSupported(response.supported);
      setMachines(response.machines);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const act = async (machine: SshMachine, action: "start" | "stop" | SshMachineServiceKind) => {
    setBusyId(machine.id);
    setError(undefined);
    try {
      if (action === "start") await client.start(machine.id);
      if (action === "stop") await client.stop(machine.id);
      if (action === "terminal" || action === "desktop" || action === "stats") {
        const service = await client.startService(machine.id, action);
        window.open(resolveServiceUrl(service.openUrl), "_blank", "noopener,noreferrer");
      }
      await refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusyId(undefined);
    }
  };

  const connected = machines.filter((machine) => machine.status === "running").length;
  const indicator = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Databricks Sandboxes"
      className={cn("relative size-7 shrink-0", className)}
    >
      <ServerIcon className="size-4" />
      <span
        className={cn(
          "absolute bottom-1 right-1 size-1.5 rounded-full ring-1 ring-background",
          error ? "bg-destructive" : connected ? "bg-emerald-500" : "bg-muted-foreground/50",
        )}
      />
    </Button>
  );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{indicator}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Databricks Sandboxes</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-80 p-0" aria-label="Databricks Sandboxes">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">Sandboxes</span>
            {loading ? (
              <Spinner className="size-3" />
            ) : (
              <span className="text-xs text-muted-foreground">{machines.length}</span>
            )}
          </div>
          {!supported ? (
            <p className="px-3 py-5 text-sm text-muted-foreground">
              Databricks Sandbox is not available in this workspace.
            </p>
          ) : machines.length === 0 && !loading ? (
            <p className="px-3 py-5 text-sm text-muted-foreground">No existing sandboxes.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto p-1">
              {machines.map((machine) => (
                <MachineRow
                  key={machine.id}
                  machine={machine}
                  expanded={expandedId === machine.id}
                  busy={busyId === machine.id}
                  onExpand={() =>
                    setExpandedId((current) => (current === machine.id ? undefined : machine.id))
                  }
                  onAction={(action) => {
                    if (action === "stop") setStopTarget(machine);
                    else void act(machine, action);
                  }}
                />
              ))}
            </div>
          )}
          {error ? <p className="border-t px-3 py-2 text-xs text-destructive">{error}</p> : null}
        </PopoverContent>
      </Popover>
      <AlertDialog
        open={Boolean(stopTarget)}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen && (!stopTarget || busyId !== stopTarget.id)) setStopTarget(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {stopTarget?.name ?? "this machine"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Stopping interrupts active desktop, terminal, and forwarded service sessions. Projects
              and machine files remain available when you restart.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(stopTarget && busyId === stopTarget.id)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(stopTarget && busyId === stopTarget.id)}
              onClick={(event) => {
                event.preventDefault();
                if (!stopTarget) return;
                void act(stopTarget, "stop").then((completed) => {
                  if (completed) setStopTarget(undefined);
                });
              }}
            >
              {stopTarget && busyId === stopTarget.id ? (
                <Spinner className="size-3.5" />
              ) : (
                <SquareIcon className="size-3.5" />
              )}
              Stop machine
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function MachineRow({
  machine,
  expanded,
  busy,
  onExpand,
  onAction,
}: {
  machine: SshMachine;
  expanded: boolean;
  busy: boolean;
  onExpand: () => void;
  onAction: (action: "start" | "stop" | SshMachineServiceKind) => void;
}) {
  const longPress = useLongPress(onExpand);
  return (
    <div className="rounded-md px-2 py-2 hover:bg-accent/60">
      <button type="button" className="flex w-full items-center gap-2 text-left" {...longPress}>
        <span className={cn("size-2 rounded-full", statusColor(machine.status))} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{machine.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{machine.status}</span>
        </span>
        {busy ? <Spinner className="size-3" /> : null}
      </button>
      {expanded ? (
        <div className="mt-2 flex flex-wrap items-center gap-1 pl-4">
          {machine.canStart ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("start")}>
              <PlayIcon className="size-3.5" /> Start
            </Button>
          ) : null}
          {machine.canStop ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("stop")}>
              <SquareIcon className="size-3.5" /> Stop
            </Button>
          ) : null}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("terminal")}>
            <SquareTerminalIcon className="size-3.5" /> Terminal
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("desktop")}>
            <MonitorIcon className="size-3.5" /> Desktop
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("stats")}>
            <HeartPulseIcon className="size-3.5" /> Stats
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressUntil = useRef(0);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const activate = () => {
    suppressUntil.current = Date.now() + 1_000;
    onLongPress();
  };
  return {
    onPointerDown: () => {
      clear();
      timer.current = setTimeout(activate, 550);
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (Date.now() < suppressUntil.current) {
        event.preventDefault();
        return;
      }
      onLongPress();
    },
    onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (Date.now() >= suppressUntil.current) onLongPress();
    },
  };
}

function statusColor(status: SshMachine["status"]): string {
  if (status === "running") return "bg-emerald-500";
  if (status === "starting" || status === "stopping") return "bg-amber-500";
  if (status === "error") return "bg-destructive";
  return "bg-muted-foreground/40";
}

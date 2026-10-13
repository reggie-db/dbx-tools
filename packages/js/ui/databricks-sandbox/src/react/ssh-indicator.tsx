import type { SshMachine } from "@dbx-tools/shared-databricks-sandbox";
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
import { ServerIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BUILT_IN_SERVICE_CONTROLS,
  BuiltInServiceLauncher,
  type BuiltInServiceLauncherProps,
} from "./built-in-service-launcher.tsx";
import { useSshClient } from "./client.ts";
import { MachinePowerButton } from "./machine-power-control.tsx";

/** Props for the compact SSH machine status and control popover. */
export interface SshIndicatorProps {
  basePath?: string;
  className?: string;
}

/** Renders SSH machine status with start, stop, and open actions. */
export function SshIndicator({ basePath, className }: SshIndicatorProps) {
  const client = useSshClient(basePath);
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

  useEffect(() => {
    if (!open || !machines.some(machineIsTransitioning)) return;
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(interval);
  }, [machines, open, refresh]);

  const act = async (machine: SshMachine, action: "start" | "stop") => {
    setBusyId(machine.id);
    setError(undefined);
    try {
      if (action === "start") await client.start(machine.id);
      if (action === "stop") await client.stop(machine.id);
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
                  busy={busyId === machine.id || machineIsTransitioning(machine)}
                  onExpand={() =>
                    setExpandedId((current) => (current === machine.id ? undefined : machine.id))
                  }
                  onAction={(action) => {
                    if (action === "stop") setStopTarget(machine);
                    else void act(machine, action);
                  }}
                  client={client}
                  onServiceSnapshot={(snapshot) =>
                    setMachines((current) =>
                      current.map((candidate) =>
                        candidate.id === machine.id
                          ? {
                              ...candidate,
                              services: candidate.services.map((currentService) =>
                                currentService.kind === snapshot.kind ? snapshot : currentService,
                              ),
                            }
                          : candidate,
                      ),
                    )
                  }
                  onServiceBusyChange={(busy) => setBusyId(busy ? machine.id : undefined)}
                  onServiceError={setError}
                  onServiceSettled={refresh}
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
  client,
  onServiceSnapshot,
  onServiceBusyChange,
  onServiceError,
  onServiceSettled,
}: {
  machine: SshMachine;
  expanded: boolean;
  busy: boolean;
  onExpand: () => void;
  onAction: (action: "start" | "stop") => void;
  client: ReturnType<typeof useSshClient>;
  onServiceSnapshot: BuiltInServiceLauncherProps["onSnapshot"];
  onServiceBusyChange: NonNullable<BuiltInServiceLauncherProps["onBusyChange"]>;
  onServiceError: BuiltInServiceLauncherProps["onError"];
  onServiceSettled: NonNullable<BuiltInServiceLauncherProps["onSettled"]>;
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
          {BUILT_IN_SERVICE_CONTROLS.map(({ kind }) => (
            <BuiltInServiceLauncher
              key={kind}
              client={client}
              machine={machine}
              kind={kind}
              disabled={machine.status !== "running"}
              onSnapshot={onServiceSnapshot}
              onBusyChange={onServiceBusyChange}
              onError={onServiceError}
              onSettled={onServiceSettled}
            />
          ))}
          <MachinePowerButton
            machine={machine}
            busy={busy}
            onStart={() => onAction("start")}
            onStop={() => onAction("stop")}
          />
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

function machineIsTransitioning(machine: SshMachine): boolean {
  return (
    machine.status === "starting" ||
    machine.status === "stopping" ||
    machine.services.some((service) => service.state === "starting") ||
    machine.projects.some((project) => project.state === "starting")
  );
}

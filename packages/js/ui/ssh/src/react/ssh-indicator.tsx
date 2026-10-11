import type { SshMachine } from "@dbx-tools/shared-ssh";
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
import { ExternalLinkIcon, PlayIcon, ServerIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SshClient } from "./client.ts";

/** Props for the compact SSH machine status and control popover. */
export interface SshIndicatorProps {
  basePath?: string;
  defaultRemotePort?: number;
  className?: string;
}

/** Renders SSH machine status with start, stop, and open actions. */
export function SshIndicator({
  basePath = "/api/ssh",
  defaultRemotePort = 3000,
  className,
}: SshIndicatorProps) {
  const client = useMemo(() => new SshClient(basePath), [basePath]);
  const [open, setOpen] = useState(false);
  const [machines, setMachines] = useState<SshMachine[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const [expandedId, setExpandedId] = useState<string>();
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

  const act = async (machine: SshMachine, action: "start" | "stop" | "open") => {
    setBusyId(machine.id);
    setError(undefined);
    try {
      if (action === "start") await client.start(machine.id);
      if (action === "stop") await client.stop(machine.id);
      if (action === "open") {
        const route =
          machine.routes[0] ??
          (await client.addRoute({ machineId: machine.id, remotePort: defaultRemotePort }));
        window.open(route.path, "_blank", "noopener,noreferrer");
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
      aria-label="SSH machines"
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
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{indicator}</PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>SSH machines</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-0" aria-label="SSH machines">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">SSH machines</span>
          {loading ? (
            <Spinner className="size-3" />
          ) : (
            <span className="text-xs text-muted-foreground">{machines.length}</span>
          )}
        </div>
        {!supported ? (
          <p className="px-3 py-5 text-sm text-muted-foreground">
            SSH is not available in this workspace.
          </p>
        ) : machines.length === 0 && !loading ? (
          <p className="px-3 py-5 text-sm text-muted-foreground">No existing SSH machines.</p>
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
                onAction={(action) => void act(machine, action)}
              />
            ))}
          </div>
        )}
        {error ? <p className="border-t px-3 py-2 text-xs text-destructive">{error}</p> : null}
      </PopoverContent>
    </Popover>
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
  onAction: (action: "start" | "stop" | "open") => void;
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
        <div className="mt-2 flex items-center gap-1 pl-4">
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
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("open")}>
            <ExternalLinkIcon className="size-3.5" /> Open
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

import {
  SSH_MACHINE_SERVICES,
  type SshMachine,
  type SshMachineService,
  type SshMachineServiceKind,
} from "@dbx-tools/shared-databricks-sandbox";
import {
  Button,
  ButtonGroup,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  useIsMobile,
} from "@dbx-tools/ui/react";
import {
  ChevronDownIcon,
  FileTextIcon,
  HeartPulseIcon,
  MonitorIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SshClient } from "./client.ts";
import { resolveServiceUrl } from "./service-url.ts";

const SERVICE_ICONS: Record<SshMachineServiceKind, LucideIcon> = {
  terminal: SquareTerminalIcon,
  desktop: MonitorIcon,
  stats: HeartPulseIcon,
};

export const BUILT_IN_SERVICE_CONTROLS = SSH_MACHINE_SERVICES.map((service) => ({
  ...service,
  Icon: SERVICE_ICONS[service.kind],
}));

export interface BuiltInServiceLauncherProps {
  client: SshClient;
  machine: SshMachine;
  kind: SshMachineServiceKind;
  disabled?: boolean;
  onSnapshot: (snapshot: SshMachineService) => void;
  onBusyChange?: (busy: boolean) => void;
  onError: (message: string | undefined) => void;
  onActivate?: () => void;
  onSelectLogs?: () => void;
  onSettled?: () => void | Promise<void>;
}

export interface BuiltInServiceLogProps {
  service: SshMachineService;
}

/** Returns the one built-in service log selected for a machine. */
export function selectedBuiltInServiceLog(
  machine: SshMachine,
  selectedKind?: SshMachineServiceKind,
): SshMachineService | undefined {
  if (!selectedKind) return undefined;
  return machine.services.find((service) => service.kind === selectedKind);
}

/** Renders a built-in service log inside its owning machine row. */
export function BuiltInServiceLog({ service }: BuiltInServiceLogProps) {
  const definition = BUILT_IN_SERVICE_CONTROLS.find(
    (candidate) => candidate.kind === service.kind,
  )!;
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [service.log]);

  return (
    <section aria-label={`${definition.label} logs`} className="border-t bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2 sm:px-4">
        <span className="text-xs font-medium text-zinc-100">{definition.label} logs</span>
        <span className="text-xs text-zinc-400">{service.state}</span>
      </div>
      <pre
        ref={logRef}
        className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-4 text-zinc-100 sm:px-4"
      >
        {service.log || service.error || `${definition.label} has no recorded output.`}
      </pre>
    </section>
  );
}

/** @internal Waits for a service lifecycle stream before opening its ready route. */
export async function openBuiltInServiceWhenReady(
  snapshots: AsyncIterable<SshMachineService>,
  label: string,
  onSnapshot: (snapshot: SshMachineService) => void,
  open: (path: string) => unknown,
): Promise<SshMachineService> {
  let finalSnapshot: SshMachineService | undefined;
  for await (const snapshot of snapshots) {
    finalSnapshot = snapshot;
    onSnapshot(snapshot);
    if (snapshot.state === "error") {
      throw new Error(snapshot.error || `${label} did not become ready.`);
    }
    if (snapshot.state !== "ready") continue;
    if (open(snapshot.openUrl) === null) {
      throw new Error(`${label} is ready. Tap it again to open.`);
    }
    return snapshot;
  }
  throw new Error(finalSnapshot?.error || `${label} did not become ready.`);
}

export function BuiltInServiceLauncher({
  client,
  machine,
  kind,
  disabled = false,
  onSnapshot,
  onBusyChange,
  onError,
  onActivate,
  onSelectLogs,
  onSettled,
}: BuiltInServiceLauncherProps) {
  const isMobile = useIsMobile();
  const service = machine.services.find((candidate) => candidate.kind === kind);
  const definition = BUILT_IN_SERVICE_CONTROLS.find((candidate) => candidate.kind === kind)!;
  const Icon = definition.Icon;
  const [busy, setBusy] = useState(false);
  const longPress = useLongPress(() => onSelectLogs?.());

  const launch = async () => {
    if (disabled || busy) return;
    onActivate?.();
    if (service?.state === "ready") {
      window.open(resolveServiceUrl(service.openUrl), "_blank", "noopener,noreferrer");
      return;
    }
    setBusy(true);
    onBusyChange?.(true);
    onError(undefined);
    try {
      await openBuiltInServiceWhenReady(
        client.startService(machine.id, kind),
        definition.label,
        onSnapshot,
        (path) => window.open(resolveServiceUrl(path), "_blank", "noopener,noreferrer"),
      );
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
      await onSettled?.();
    }
  };

  const primary = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className={isMobile ? "shrink-0 px-2" : "shrink-0"}
      aria-label={`${service?.state === "ready" ? "Open" : "Start"} ${definition.label}`}
      disabled={disabled || busy}
      onClick={(event) => {
        if (longPress.shouldSuppressClick()) {
          event.preventDefault();
          return;
        }
        void launch();
      }}
      {...(isMobile ? longPress.handlers : {})}
    >
      {busy || service?.state === "starting" ? (
        <Spinner className="size-3.5" />
      ) : (
        <Icon className="size-3.5" />
      )}
      <span className={isMobile ? "sr-only" : undefined}>{definition.label}</span>
    </Button>
  );

  if (isMobile) return primary;

  return (
    <ButtonGroup>
      {primary}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-8 px-0"
            aria-label={`${definition.label} options`}
            disabled={disabled}
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onSelectLogs}>
            <FileTextIcon className="size-3.5" />
            Logs
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressClick = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };
  return {
    handlers: {
      onPointerDown: () => {
        suppressClick.current = false;
        clear();
        timer.current = setTimeout(() => {
          suppressClick.current = true;
          onLongPress();
        }, 500);
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
    },
    shouldSuppressClick: () => {
      const suppress = suppressClick.current;
      suppressClick.current = false;
      return suppress;
    },
  };
}

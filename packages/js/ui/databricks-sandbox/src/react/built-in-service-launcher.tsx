import {
  SSH_MACHINE_SERVICES,
  type SshMachine,
  type SshMachineService,
  type SshMachineServiceKind,
} from "@dbx-tools/shared-databricks-sandbox";
import { Button, ButtonGroup, cn, Spinner, useIsMobile } from "@dbx-tools/ui/react";
import {
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

/** Visual and accessible status metadata for built-in service controls. */
const SERVICE_STATUS = {
  stopped: { label: "Not installed", className: "bg-muted-foreground/40" },
  starting: { label: "Not installed", className: "bg-muted-foreground/40" },
  ready: { label: "Installed", className: "bg-emerald-500" },
  error: { label: "Unhealthy", className: "bg-destructive" },
} as const satisfies Record<SshMachineService["state"], { label: string; className: string }>;

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
  logsOpen?: boolean;
  onSelectLogs?: () => void;
  onHideLogs?: () => void;
  onSettled?: () => void | Promise<void>;
}

export interface BuiltInServiceLogProps {
  service: SshMachineService;
}

/** Trailing lifecycle log panel shared by built-in services and projects. */
export interface InstallLogPanelProps {
  label: string;
  state?: string;
  log?: string;
  error?: string;
}

/** Returns the one built-in service log selected for a machine. */
export function selectedBuiltInServiceLog(
  machine: SshMachine,
  selectedKind?: SshMachineServiceKind,
): SshMachineService | undefined {
  if (!selectedKind) return undefined;
  return machine.services.find((candidate) => candidate.kind === selectedKind);
}

/** Which built-in service log is visible for a machine. Logs stay closed until chosen. */
export interface BuiltInServiceLogSelection {
  kind: SshMachineServiceKind;
}

/** Renders a saved install log inside its owning machine or project row. */
export function InstallLogPanel({ label, state, log, error }: InstallLogPanelProps) {
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  return (
    <section aria-label={`${label} install logs`} className="border-t bg-zinc-950">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2 sm:px-4">
        <span className="text-xs font-medium text-zinc-100">{label} install logs</span>
        {state ? <span className="text-xs text-zinc-400">{state}</span> : null}
      </div>
      <pre
        ref={logRef}
        className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-4 text-zinc-100 sm:px-4"
      >
        {log || error || `${label} has no recorded output.`}
      </pre>
    </section>
  );
}

/** Renders a built-in service log inside its owning machine row. */
export function BuiltInServiceLog({ service }: BuiltInServiceLogProps) {
  const definition = BUILT_IN_SERVICE_CONTROLS.find(
    (candidate) => candidate.kind === service.kind,
  )!;
  return (
    <InstallLogPanel
      label={definition.label}
      state={service.state}
      log={service.log}
      error={service.error}
    />
  );
}

/** @internal Waits for a service lifecycle stream to report a ready route. */
export async function waitForBuiltInServiceReady(
  snapshots: AsyncIterable<SshMachineService>,
  label: string,
  onSnapshot: (snapshot: SshMachineService) => void,
): Promise<SshMachineService> {
  let finalSnapshot: SshMachineService | undefined;
  for await (const snapshot of snapshots) {
    finalSnapshot = snapshot;
    onSnapshot(snapshot);
    if (snapshot.state === "error") {
      throw new Error(snapshot.error || `${label} did not become ready.`);
    }
    if (snapshot.state !== "ready") continue;
    return snapshot;
  }
  throw new Error(finalSnapshot?.error || `${label} did not become ready.`);
}

/** Installs a built-in service and opens it only after the lifecycle stream is ready. */
export async function startAndOpenBuiltInService(options: {
  snapshots: AsyncIterable<SshMachineService>;
  label: string;
  onSnapshot: (snapshot: SshMachineService) => void;
  openTab?: (url: string) => Window | null;
}): Promise<SshMachineService> {
  const ready = await waitForBuiltInServiceReady(
    options.snapshots,
    options.label,
    options.onSnapshot,
  );
  const open =
    options.openTab ?? ((url: string) => window.open(url, "_blank", "noopener,noreferrer"));
  open(resolveServiceUrl(ready.openUrl));
  return ready;
}

export function BuiltInServiceLauncher({
  client,
  machine,
  kind,
  disabled = false,
  onSnapshot,
  onBusyChange,
  onError,
  logsOpen = false,
  onSelectLogs,
  onHideLogs,
  onSettled,
}: BuiltInServiceLauncherProps) {
  const isMobile = useIsMobile();
  const service = machine.services.find((candidate) => candidate.kind === kind);
  const definition = BUILT_IN_SERVICE_CONTROLS.find((candidate) => candidate.kind === kind)!;
  const Icon = definition.Icon;
  const [busy, setBusy] = useState(false);
  const status = SERVICE_STATUS[service?.state ?? "stopped"];
  const installing = busy || service?.state === "starting";
  const canSelectLogs =
    onSelectLogs !== undefined &&
    (installing ||
      service?.state === "ready" ||
      service?.state === "error" ||
      Boolean(service?.log));

  const launch = async () => {
    if (disabled || busy) return;
    setBusy(true);
    onBusyChange?.(true);
    onError(undefined);
    let ready: SshMachineService | undefined;
    try {
      ready = await waitForBuiltInServiceReady(
        client.startService(machine.id, kind),
        definition.label,
        onSnapshot,
      );
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
      await onSettled?.();
    }
    if (!ready) return;
    window.open(resolveServiceUrl(ready.openUrl), "_blank", "noopener,noreferrer");
  };

  const primaryLabel = <span className={isMobile ? "sr-only" : undefined}>{definition.label}</span>;
  const statusIndicator = (
    <span
      aria-hidden="true"
      title={`${definition.label}: ${status.label}`}
      className={cn("size-1.5 shrink-0 rounded-full", status.className)}
    />
  );
  const primary =
    service?.state === "ready" ? (
      <Button
        size="sm"
        variant="outline"
        className={isMobile ? "shrink-0 px-2" : "shrink-0"}
        aria-label={`Open ${definition.label} (${status.label})`}
        title={`${definition.label}: ${status.label}`}
        disabled={disabled}
        asChild
      >
        <a
          href={resolveServiceUrl(service.openUrl)}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={disabled}
          tabIndex={disabled ? -1 : undefined}
          onClick={(event) => {
            if (!disabled) return;
            event.preventDefault();
          }}
        >
          <Icon className="size-3.5" />
          {primaryLabel}
          {statusIndicator}
        </a>
      </Button>
    ) : (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={isMobile ? "shrink-0 px-2" : "shrink-0"}
        aria-label={`Start ${definition.label} (${status.label})`}
        title={`${definition.label}: ${status.label}`}
        disabled={disabled || busy}
        onClick={() => void launch()}
      >
        <Icon className="size-3.5" />
        {primaryLabel}
        {statusIndicator}
      </Button>
    );

  const canToggleLogs = logsOpen ? onHideLogs !== undefined : canSelectLogs;
  if (!canToggleLogs) return primary;

  return (
    <ButtonGroup>
      {primary}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={cn("w-8 px-0", logsOpen && "bg-muted shadow-inner")}
        aria-label={logsOpen ? `Hide ${definition.label} logs` : `Show ${definition.label} logs`}
        aria-pressed={logsOpen}
        title={logsOpen ? "Hide logs" : "Show logs"}
        disabled={disabled}
        onClick={logsOpen ? onHideLogs : onSelectLogs}
      >
        {installing ? <Spinner className="size-3.5" /> : <FileTextIcon className="size-3.5" />}
      </Button>
    </ButtonGroup>
  );
}

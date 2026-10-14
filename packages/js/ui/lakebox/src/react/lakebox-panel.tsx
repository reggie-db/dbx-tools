import type { LakeboxService, LakeboxStatus, LakeboxSummary } from "@dbx-tools/shared-lakebox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Spinner,
  cn,
} from "@dbx-tools/ui/react";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  MonitorIcon,
  PlayIcon,
  SquareIcon,
  SquareTerminalIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLakeboxClient, type LakeboxClient } from "./client.ts";
import { LakeboxMetrics } from "./lakebox-metrics.tsx";
import { useLakebox, useLakeboxMetrics, type LakeboxState } from "./use-lakebox.ts";

const SERVICE_ICONS: Partial<Record<LakeboxService["kind"], LucideIcon>> = {
  terminal: SquareTerminalIcon,
  desktop: MonitorIcon,
};

/** Props for {@link LakeboxPanel}. */
export interface LakeboxPanelProps {
  basePath?: string;
  className?: string;
}

/** Full Lakebox surface: status, power, the current user's services, and metrics. */
export function LakeboxPanel({ basePath, className }: LakeboxPanelProps) {
  const client = useLakeboxClient(basePath);
  const state = useLakebox(client);
  const { summary } = state;
  const running = summary?.status === "running";
  const series = useLakeboxMetrics(client, running);
  const [confirm, setConfirm] = useState<{ action: "stop" } | { action: "remove"; name: string }>();

  if (summary && !summary.supported) {
    return (
      <Card className={className}>
        <CardContent className="py-8 text-sm text-muted-foreground">
          Lakeboxes are not available in this workspace.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {state.error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
        >
          {state.error}
        </div>
      ) : null}
      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot status={summary?.status} />
            <CardTitle className="truncate text-sm">{summary?.name ?? "Lakebox"}</CardTitle>
            <Badge variant="secondary">{statusLabel(summary?.status, state.loading)}</Badge>
          </div>
          <PowerButton state={state} onStop={() => setConfirm({ action: "stop" })} />
        </CardHeader>
        {summary ? (
          <CardContent className="space-y-0 p-0">
            <p className="truncate border-t px-3 py-2 text-xs text-muted-foreground sm:px-4">
              Signed in as <span className="font-mono">{summary.user.name}</span>
              {summary.idleTimeoutSeconds
                ? `, stops after ${formatDuration(summary.idleTimeoutSeconds)} idle`
                : null}
            </p>
            <ul className="divide-y border-t">
              {summary.services.map((service) => (
                <ServiceRow
                  key={service.name}
                  client={client}
                  service={service}
                  state={state}
                  onRemove={() => setConfirm({ action: "remove", name: service.name })}
                />
              ))}
            </ul>
            {running ? (
              <section aria-label="Lakebox metrics" className="border-t px-3 py-3 sm:px-4">
                <LakeboxMetrics series={series} />
              </section>
            ) : null}
          </CardContent>
        ) : (
          <CardContent className="flex min-h-16 items-center justify-center gap-2 border-t text-sm text-muted-foreground">
            <Spinner className="size-4" />
            <span>Loading</span>
          </CardContent>
        )}
      </Card>
      <ConfirmDialog
        confirm={confirm}
        summary={summary}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          const current = confirm;
          setConfirm(undefined);
          if (current?.action === "stop") void state.stop();
          if (current?.action === "remove") void state.removeService(current.name);
        }}
      />
    </div>
  );
}

function ServiceRow({
  client,
  service,
  state,
  onRemove,
}: {
  client: LakeboxClient;
  service: LakeboxService;
  state: LakeboxState;
  onRemove: () => void;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const starting = state.busy.has(`service:${service.name}:start`) || service.state === "starting";
  const stopping = state.busy.has(`service:${service.name}:stop`);
  const removing = state.busy.has(`service:${service.name}:remove`);
  const busy = starting || stopping || removing;
  const Icon = SERVICE_ICONS[service.kind];
  const lakeboxBusy = state.busy.has("lakebox:stop") || state.summary?.status === "stopping";
  return (
    <li className="min-w-0" aria-busy={busy || undefined}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {Icon ? (
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : null}
          <span className="truncate text-sm font-medium">{service.name}</span>
          <Badge variant={service.state === "error" ? "destructive" : "outline"} className="gap-1">
            {starting ? <Spinner className="size-3" /> : null}
            {starting ? "starting" : service.state}
          </Badge>
          {service.image ? (
            <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">
              {service.image}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {service.route ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || lakeboxBusy}
              onClick={() => void state.open(service)}
            >
              {starting ? (
                <Spinner className="size-3.5" />
              ) : (
                <ExternalLinkIcon className="size-3.5" />
              )}
              Open
            </Button>
          ) : service.state !== "ready" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || lakeboxBusy}
              onClick={() => void state.startService(service.name)}
            >
              <PlayIcon className="size-3.5" />
              Start
            </Button>
          ) : null}
          {service.state === "ready" ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`Stop ${service.name}`}
              title="Stop"
              disabled={busy}
              onClick={() => void state.stopService(service.name)}
            >
              {stopping ? <Spinner className="size-4" /> : <SquareIcon className="size-4" />}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(logsOpen && "bg-muted shadow-inner")}
            aria-label={logsOpen ? `Hide ${service.name} log` : `Show ${service.name} log`}
            aria-pressed={logsOpen}
            title={logsOpen ? "Hide log" : "Show log"}
            disabled={state.summary?.status !== "running"}
            onClick={() => setLogsOpen((open) => !open)}
          >
            <FileTextIcon className="size-4" />
          </Button>
          {service.kind === "image" ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              aria-label={`Remove ${service.name}`}
              title="Remove"
              disabled={busy}
              onClick={onRemove}
            >
              {removing ? <Spinner className="size-4" /> : <Trash2Icon className="size-4" />}
            </Button>
          ) : null}
        </div>
        {service.error ? (
          <p className="w-full break-words text-xs text-destructive">{service.error}</p>
        ) : null}
      </div>
      {logsOpen ? <ServiceLog client={client} name={service.name} live={starting} /> : null}
    </li>
  );
}

/** Bounded service log, refreshed while the service starts. */
function ServiceLog({
  client,
  name,
  live,
}: {
  client: LakeboxClient;
  name: string;
  live: boolean;
}) {
  const [log, setLog] = useState<string>();
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      client
        .serviceLogs(name, {}, controller.signal)
        .then(setLog)
        .catch(() => undefined);
    void load();
    const interval = live ? window.setInterval(load, 1_500) : undefined;
    return () => {
      controller.abort();
      if (interval) window.clearInterval(interval);
    };
  }, [client, name, live]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    setCopied(false);
  }, [log]);
  const output = log === undefined ? "Loading log" : log || `${name} has no recorded output.`;
  return (
    <section aria-label={`${name} log`} className="border-t bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5 sm:px-4">
        <span className="text-xs font-medium text-zinc-100">{name} log</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          aria-label={`Copy ${name} log`}
          title={copied ? "Copied" : "Copy log"}
          onClick={() => void navigator.clipboard.writeText(output).then(() => setCopied(true))}
        >
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
        </Button>
      </div>
      <pre
        ref={logRef}
        className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-4 text-zinc-100 sm:px-4"
      >
        {output}
      </pre>
    </section>
  );
}

/** Start or Stop for the shared Lakebox. */
export function PowerButton({
  state,
  onStop,
  compact = false,
}: {
  state: LakeboxState;
  onStop: () => void;
  compact?: boolean;
}) {
  const status = state.summary?.status;
  const changing =
    state.busy.has("lakebox:start") ||
    state.busy.has("lakebox:stop") ||
    status === "starting" ||
    status === "stopping";
  if (state.summary?.canStop) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="shrink-0 text-destructive hover:text-destructive"
        disabled={changing}
        onClick={onStop}
      >
        {changing ? <Spinner className="size-3.5" /> : <SquareIcon className="size-3.5" />}
        {compact ? null : "Stop"}
      </Button>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="shrink-0"
      disabled={changing || !state.summary?.canStart}
      onClick={() => void state.start()}
    >
      {changing ? <Spinner className="size-3.5" /> : <PlayIcon className="size-3.5" />}
      {compact ? null : status === "missing" ? "Create" : "Start"}
    </Button>
  );
}

/** Confirmation for actions that interrupt other sessions or delete data. */
export function ConfirmDialog({
  confirm,
  summary,
  onCancel,
  onConfirm,
}: {
  confirm: { action: "stop" } | { action: "remove"; name: string } | undefined;
  summary: LakeboxSummary | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={Boolean(confirm)} onOpenChange={(open) => (open ? undefined : onCancel())}>
      {confirm ? (
        <AlertDialogContent className="w-[calc(100vw-2rem)] max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm.action === "stop"
                ? `Stop ${summary?.name ?? "the Lakebox"}?`
                : `Remove ${confirm.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm.action === "stop"
                ? "Stopping interrupts terminals, desktops, and services for every user of this app. Files and saved services remain and restart on the next start."
                : `This stops ${confirm.name} and deletes its saved definition and image files. Files in your home directory remain.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onConfirm}
            >
              {confirm.action === "stop" ? "Stop Lakebox" : "Remove service"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
}

/** Lifecycle color dot. */
export function StatusDot({ status, className }: { status?: LakeboxStatus; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2.5 shrink-0 rounded-full",
        status === "running"
          ? "bg-emerald-500"
          : status === "starting" || status === "stopping"
            ? "bg-amber-500"
            : status === "error"
              ? "bg-destructive"
              : "bg-muted-foreground/40",
        className,
      )}
    />
  );
}

/** Human label for a lifecycle state. */
export function statusLabel(status: LakeboxStatus | undefined, loading: boolean): string {
  if (!status) return loading ? "loading" : "unknown";
  return status === "missing" ? "not created" : status;
}

function formatDuration(seconds: number): string {
  if (seconds % 3_600 === 0) return `${seconds / 3_600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

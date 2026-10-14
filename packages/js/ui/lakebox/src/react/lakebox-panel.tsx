import type { LakeboxService, LakeboxStatus } from "@dbx-tools/shared-lakebox";
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
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  MonitorIcon,
  PlayIcon,
  SquareIcon,
  SquareTerminalIcon,
  Settings2Icon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLakeboxClient, type LakeboxClient } from "./client.ts";
import { LakeboxMetrics } from "./lakebox-metrics.tsx";
import { resolveServiceUrl } from "./service-url.ts";
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

/** Full Lakebox surface: status, the current user's services, and metrics. */
export function LakeboxPanel({ basePath, className }: LakeboxPanelProps) {
  const client = useLakeboxClient(basePath);
  const state = useLakebox(client);
  const { summary } = state;
  const running = summary?.status === "running";
  const series = useLakeboxMetrics(client, running);
  const [removeService, setRemoveService] = useState<string>();

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
        <CardHeader className="flex flex-row items-center gap-3 space-y-0 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot status={summary?.status} />
            <CardTitle className="truncate text-sm">Lakebox</CardTitle>
            <Badge variant="secondary">{statusLabel(summary?.status, state.loading)}</Badge>
          </div>
        </CardHeader>
        {summary ? (
          <CardContent className="space-y-0 p-0">
            {summary.servicesStale ? (
              <p className="border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground sm:px-4">
                {summary.servicesObservedAt
                  ? `Last known services from ${new Date(summary.servicesObservedAt).toLocaleString()}. Service status is not live.`
                  : "Saved services will appear after the Lakebox runs once."}
              </p>
            ) : null}
            {running ? (
              <section aria-label="Lakebox metrics" className="border-t px-3 py-3 sm:px-4">
                <LakeboxMetrics series={series} />
              </section>
            ) : null}
            <ul className="divide-y border-t">
              {summary.services.map((service) => (
                <ServiceRow
                  key={service.name}
                  client={client}
                  service={service}
                  state={state}
                  onRemove={() => setRemoveService(service.name)}
                />
              ))}
            </ul>
          </CardContent>
        ) : (
          <CardContent className="flex min-h-16 items-center justify-center gap-2 border-t text-sm text-muted-foreground">
            <Spinner className="size-4" />
            <span>Loading</span>
          </CardContent>
        )}
      </Card>
      <RemoveServiceDialog
        name={removeService}
        onCancel={() => setRemoveService(undefined)}
        onConfirm={() => {
          const name = removeService;
          setRemoveService(undefined);
          if (name) void state.removeService(name);
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
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const starting = state.busy.has(`service:${service.name}:start`) || service.state === "starting";
  const stopping = state.busy.has(`service:${service.name}:stop`);
  const removing = state.busy.has(`service:${service.name}:remove`);
  const busy = starting || stopping || removing;
  const Icon = SERVICE_ICONS[service.kind];
  const lakeboxBusy = state.summary?.status === "stopping";
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
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(configurationOpen && "bg-muted shadow-inner")}
            aria-label={
              configurationOpen
                ? `Hide ${service.name} configuration`
                : `Show ${service.name} configuration`
            }
            aria-expanded={configurationOpen}
            title={configurationOpen ? "Hide configuration" : "Show configuration"}
            onClick={() => setConfigurationOpen((open) => !open)}
          >
            {configurationOpen ? (
              <ChevronDownIcon className="size-4" />
            ) : (
              <Settings2Icon className="size-4" />
            )}
          </Button>
          {!service.route && service.state !== "ready" ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label={`Start ${service.name}`}
              title="Start"
              disabled={busy || lakeboxBusy}
              onClick={() => void state.startService(service.name)}
            >
              <PlayIcon className="size-3.5" />
            </Button>
          ) : null}
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
          {service.kind !== "image" && service.state === "ready" ? (
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
          {service.route ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label={starting ? `Opening ${service.name}` : `Open ${service.name}`}
              title={starting ? "Opening" : "Open"}
              disabled={busy || lakeboxBusy}
              onClick={() => void state.open(service)}
            >
              {starting ? (
                <Spinner className="size-3.5" />
              ) : (
                <ExternalLinkIcon className="size-3.5" />
              )}
            </Button>
          ) : null}
        </div>
        {service.error ? (
          <p className="w-full break-words text-xs text-destructive">{service.error}</p>
        ) : null}
      </div>
      {configurationOpen ? <ServiceConfiguration service={service} /> : null}
      {logsOpen ? <ServiceLog client={client} name={service.name} live={starting} /> : null}
    </li>
  );
}

/** Safe, user-visible service configuration without environment values. */
function ServiceConfiguration({ service }: { service: LakeboxService }) {
  const openUrl = service.openUrl ? resolveServiceUrl(service.openUrl) : undefined;
  const fields = [
    ["Kind", service.kind],
    ...(service.image ? [["Image", service.image]] : []),
    ...(service.openPath ? [["Open path", service.openPath]] : []),
    ["Route path", service.path],
    ["Loopback", `127.0.0.1:${service.port}`],
  ] as const;
  return (
    <section
      aria-label={`${service.name} configuration`}
      className="border-t bg-muted/20 px-3 py-3 sm:px-4"
    >
      <dl className="grid min-w-0 gap-x-4 gap-y-2 text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
        {fields.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-medium text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-all font-mono text-foreground">{value}</dd>
          </div>
        ))}
        {openUrl ? (
          <div className="contents">
            <dt className="font-medium text-muted-foreground">Open URL</dt>
            <dd className="min-w-0 break-all font-mono">
              <a
                href={openUrl}
                target="_blank"
                rel="noreferrer"
                className="text-blue-700 underline decoration-blue-700/40 underline-offset-2 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200"
              >
                {openUrl}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
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

/** Confirmation for deleting one saved custom service. */
function RemoveServiceDialog({
  name,
  onCancel,
  onConfirm,
}: {
  name: string | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={Boolean(name)} onOpenChange={(open) => (open ? undefined : onCancel())}>
      {name ? (
        <AlertDialogContent className="w-[calc(100vw-2rem)] max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{`Remove ${name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {`This stops ${name} and deletes its saved definition and image files. Files in your home directory remain.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onConfirm}
            >
              Remove service
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

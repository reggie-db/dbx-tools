import type { SandboxStats as SandboxStatsValue } from "@dbx-tools/shared-databricks-sandbox";
import { Button, Card, CardContent, CardHeader, CardTitle, Spinner, cn } from "@dbx-tools/ui/react";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SshClient } from "./client.ts";

/** Props for the native Databricks Sandbox health overview. */
export interface SandboxStatsProps {
  machineId: string;
  basePath?: string;
  className?: string;
  refreshIntervalMs?: number;
}

/** Displays a compact, polling health overview without installing software in the Sandbox. */
export function SandboxStats({
  machineId,
  basePath = "/api/databricks-sandbox",
  className,
  refreshIntervalMs = 5_000,
}: SandboxStatsProps) {
  const client = useMemo(() => new SshClient(basePath), [basePath]);
  const [stats, setStats] = useState<SandboxStatsValue>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        setStats(await client.stats(machineId, signal));
        setError(undefined);
      } catch (caught) {
        if (!signal?.aborted) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [client, machineId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), refreshIntervalMs);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [refresh, refreshIntervalMs]);

  return (
    <div className={cn("h-full overflow-auto p-4 md:p-6", className)}>
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{machineId}</h1>
            <p className="text-xs text-muted-foreground">
              {stats
                ? `Updated ${new Date(stats.sampledAt).toLocaleTimeString()}`
                : "Machine health"}
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>
            {loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
            Refresh
          </Button>
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}

        {stats ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="Memory"
              value={`${stats.memory.usedPercent.toFixed(1)}%`}
              detail={`${formatBytes(stats.memory.usedBytes)} of ${formatBytes(stats.memory.totalBytes)}`}
              percent={stats.memory.usedPercent}
            />
            <MetricCard
              title="Disk"
              value={`${stats.disk.usedPercent.toFixed(1)}%`}
              detail={`${formatBytes(stats.disk.usedBytes)} of ${formatBytes(stats.disk.totalBytes)}`}
              percent={stats.disk.usedPercent}
            />
            <MetricCard
              title="Load"
              value={stats.loadAverage[0].toFixed(2)}
              detail={`${stats.cpuCount} logical CPUs`}
            />
            <MetricCard
              title="Uptime"
              value={formatDuration(stats.uptimeSeconds)}
              detail={`5m ${stats.loadAverage[1].toFixed(2)} · 15m ${stats.loadAverage[2].toFixed(2)}`}
            />
          </div>
        ) : loading ? (
          <div className="flex min-h-48 items-center justify-center">
            <Spinner />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MetricCard({
  title,
  value,
  detail,
  percent,
}: {
  title: string;
  value: string;
  detail: string;
  percent?: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {percent === undefined ? null : (
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

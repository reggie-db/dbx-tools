import type { LakeboxMetricsSnapshot } from "@dbx-tools/shared-lakebox";
import { cn } from "@dbx-tools/ui/react";

/** Props for {@link LakeboxMetrics}. */
export interface LakeboxMetricsProps {
  series: readonly LakeboxMetricsSnapshot[];
  /** Compact renders CPU and memory only. */
  compact?: boolean;
  className?: string;
}

/**
 * Machine-level CPU, memory, storage, and network metrics for the Lakebox.
 * Values are shared by every user of the Lakebox; no process data is shown.
 */
export function LakeboxMetrics({ series, compact = false, className }: LakeboxMetricsProps) {
  const latest = series.at(-1);
  if (!latest) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)} role="status">
        Collecting metrics
      </p>
    );
  }
  const memoryPercent = percent(latest.memory.usedBytes, latest.memory.totalBytes);
  const storagePercent = percent(latest.storage.usedBytes, latest.storage.totalBytes);
  return (
    <dl
      className={cn(
        "grid gap-3",
        compact ? "grid-cols-2" : "grid-cols-2 lg:grid-cols-4",
        className,
      )}
    >
      <Metric
        label="CPU"
        value={`${Math.round(latest.cpu.usedPercent)}%`}
        detail={`${latest.cpu.cores} cores, load ${latest.cpu.load1.toFixed(2)}`}
        percent={latest.cpu.usedPercent}
        trend={series.map((sample) => sample.cpu.usedPercent)}
      />
      <Metric
        label="Memory"
        value={`${Math.round(memoryPercent)}%`}
        detail={`${formatBytes(latest.memory.usedBytes)} of ${formatBytes(latest.memory.totalBytes)}`}
        percent={memoryPercent}
        trend={series.map((sample) => percent(sample.memory.usedBytes, sample.memory.totalBytes))}
      />
      {compact ? null : (
        <>
          <Metric
            label="Storage"
            value={`${Math.round(storagePercent)}%`}
            detail={`${formatBytes(latest.storage.usedBytes)} of ${formatBytes(latest.storage.totalBytes)}`}
            percent={storagePercent}
          />
          <Metric
            label="Network"
            value={`${formatBytes(latest.network.rxBytesPerSecond)}/s`}
            detail={`in, ${formatBytes(latest.network.txBytesPerSecond)}/s out`}
            trend={series.map(
              (sample) => sample.network.rxBytesPerSecond + sample.network.txBytesPerSecond,
            )}
          />
        </>
      )}
    </dl>
  );
}

function Metric({
  label,
  value,
  detail,
  percent: fraction,
  trend,
}: {
  label: string;
  value: string;
  detail: string;
  percent?: number;
  trend?: readonly number[];
}) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold tabular-nums">{value}</span>
          {trend && trend.length > 1 ? <Sparkline values={trend} /> : null}
        </div>
        {fraction !== undefined ? (
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="meter"
            aria-label={`${label} usage`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction)}
          >
            <div
              className={cn(
                "h-full rounded-full",
                fraction >= 90 ? "bg-destructive" : fraction >= 75 ? "bg-amber-500" : "bg-primary",
              )}
              style={{ width: `${Math.min(100, Math.max(0, fraction))}%` }}
            />
          </div>
        ) : null}
        <p className="truncate text-xs text-muted-foreground tabular-nums">{detail}</p>
      </dd>
    </div>
  );
}

function Sparkline({ values }: { values: readonly number[] }) {
  const width = 56;
  const height = 16;
  const max = Math.max(...values, 1);
  const step = width / Math.max(values.length - 1, 1);
  const points = values
    .map(
      (entry, index) =>
        `${(index * step).toFixed(1)},${(height - (entry / max) * height).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 text-primary"
      aria-hidden="true"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

function percent(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0;
}

/** Formats a byte count with binary units. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

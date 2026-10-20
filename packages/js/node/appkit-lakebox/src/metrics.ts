import { EventEmitter } from "node:events";
import { log, toError } from "@dbx-tools/shared-core";
import type { LakeboxMetricsSnapshot } from "@dbx-tools/shared-lakebox";

const logger = log.logger("appkit-lakebox:metrics");
const DEFAULT_CAPACITY = 120;

/** Raw cumulative counters read from one sample. */
export interface LakeboxCounters {
  at: number;
  cores: number;
  cpuBusy: number;
  cpuTotal: number;
  load1: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  storageTotalBytes: number;
  storageUsedBytes: number;
  rxBytes: number;
  txBytes: number;
}

/** Events emitted by {@link LakeboxMetrics}. */
export interface LakeboxMetricsEvents {
  snapshot: [LakeboxMetricsSnapshot];
}

/**
 * In-process metrics emitter for the app Lakebox.
 *
 * Sampling runs only between {@link start} and {@link stop}, which the runtime
 * ties to the Lakebox running state. Samples contain machine-level CPU,
 * memory, persistent storage, and network counters; they never contain
 * process names, arguments, environment, or per-process usage.
 */
export class LakeboxMetrics extends EventEmitter<LakeboxMetricsEvents> {
  private readonly samples: LakeboxMetricsSnapshot[] = [];
  private previous?: LakeboxCounters;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;

  /** Creates a stopped emitter that reads raw counters with `read`. */
  constructor(
    private readonly read: (signal: AbortSignal) => Promise<string>,
    private readonly intervalMs: number,
    private readonly capacity = DEFAULT_CAPACITY,
  ) {
    super();
  }

  /** Whether sampling is active. */
  get running(): boolean {
    return this.controller !== undefined;
  }

  /** Recent samples, oldest first. */
  series(): readonly LakeboxMetricsSnapshot[] {
    return [...this.samples];
  }

  /** Seeds one validated sample without starting the recurring sampler or emitting an event. */
  seed(output: string, at = Date.now()): LakeboxMetricsSnapshot {
    const snapshot = this.record(parseLakeboxCounters(output, at), false);
    return snapshot;
  }

  /** Starts sampling. Repeated calls are ignored. */
  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    void this.tick(this.controller.signal);
  }

  /** Stops sampling and clears the series. */
  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.previous = undefined;
    this.samples.length = 0;
  }

  private async tick(signal: AbortSignal): Promise<void> {
    try {
      const counters = parseLakeboxCounters(await this.read(signal));
      if (signal.aborted) return;
      this.record(counters, true);
    } catch (error) {
      if (!signal.aborted) {
        logger.debug("Lakebox metrics sample failed", { error: toError(error) });
      }
    }
    if (signal.aborted) return;
    this.timer = setTimeout(() => void this.tick(signal), this.intervalMs);
    this.timer.unref?.();
  }

  private record(counters: LakeboxCounters, emit: boolean): LakeboxMetricsSnapshot {
    const snapshot = toSnapshot(counters, this.previous);
    this.previous = counters;
    this.samples.push(snapshot);
    if (this.samples.length > this.capacity) this.samples.shift();
    if (emit) this.emit("snapshot", snapshot);
    return snapshot;
  }
}

/**
 * Parses the package-owned metrics command output.
 *
 * @throws When a required counter is missing.
 */
export function parseLakeboxCounters(output: string, at = Date.now()): LakeboxCounters {
  const lines = new Map<string, number[]>();
  for (const line of output.split("\n")) {
    const [key, ...values] = line.trim().split(/\s+/);
    if (key) lines.set(key.replace(/:$/, ""), values.map(Number));
  }
  const value = (key: string, index = 0): number => {
    const entry = lines.get(key)?.[index];
    if (entry === undefined || !Number.isFinite(entry)) {
      throw new Error(`Lakebox metrics output is missing ${key}`);
    }
    return entry;
  };
  const cpu = lines.get("cpu") ?? [];
  const idle = (cpu[3] ?? 0) + (cpu[4] ?? 0);
  const total = cpu
    .slice(0, 8)
    .reduce((sum, entry) => sum + (Number.isFinite(entry) ? entry : 0), 0);
  return {
    at,
    cores: value("cores"),
    cpuBusy: total - idle,
    cpuTotal: total,
    load1: value("load"),
    memoryTotalBytes: value("MemTotal") * 1024,
    memoryAvailableBytes: value("MemAvailable") * 1024,
    storageTotalBytes: value("storage", 0),
    storageUsedBytes: value("storage", 1),
    rxBytes: value("network", 0),
    txBytes: value("network", 1),
  };
}

/** Converts cumulative counters to one snapshot using the previous sample for rates. */
export function toSnapshot(
  current: LakeboxCounters,
  previous?: LakeboxCounters,
): LakeboxMetricsSnapshot {
  const seconds = previous ? Math.max((current.at - previous.at) / 1_000, 0.001) : 0;
  const cpuTotal = previous ? current.cpuTotal - previous.cpuTotal : 0;
  const cpuBusy = previous ? current.cpuBusy - previous.cpuBusy : 0;
  const rate = (now: number, before: number | undefined) =>
    previous && before !== undefined ? Math.max(0, (now - before) / seconds) : 0;
  return {
    at: new Date(current.at).toISOString(),
    cpu: {
      cores: current.cores,
      usedPercent: cpuTotal > 0 ? clamp((cpuBusy / cpuTotal) * 100) : 0,
      load1: current.load1,
    },
    memory: {
      totalBytes: current.memoryTotalBytes,
      usedBytes: Math.max(0, current.memoryTotalBytes - current.memoryAvailableBytes),
    },
    storage: { totalBytes: current.storageTotalBytes, usedBytes: current.storageUsedBytes },
    network: {
      rxBytesPerSecond: rate(current.rxBytes, previous?.rxBytes),
      txBytesPerSecond: rate(current.txBytes, previous?.txBytes),
    },
  };
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

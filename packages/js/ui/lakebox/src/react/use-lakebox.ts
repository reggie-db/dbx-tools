import type {
  LakeboxMetricsSnapshot,
  LakeboxService,
  LakeboxSummary,
} from "@dbx-tools/shared-lakebox";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LakeboxClient } from "./client.ts";
import { resolveServiceUrl } from "./service-url.ts";

const ACTIVE_REFRESH_MS = 3_000;
const IDLE_REFRESH_MS = 20_000;
const METRICS_CAPACITY = 60;

/** Lakebox state and actions shared by the panel and the indicator. */
export interface LakeboxState {
  summary?: LakeboxSummary;
  loading: boolean;
  error?: string;
  /** Operations in flight, keyed by `lakebox:<action>` or `service:<name>:<action>`. */
  busy: ReadonlySet<string>;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Starts a service when needed and opens it in a new tab. */
  open: (service: LakeboxService) => Promise<void>;
  startService: (name: string) => Promise<void>;
  stopService: (name: string) => Promise<void>;
  removeService: (name: string) => Promise<void>;
  clearError: () => void;
}

/** Returns whether the Lakebox or one of its services is changing state. */
export function lakeboxTransitioning(summary: LakeboxSummary | undefined): boolean {
  return Boolean(
    summary &&
    (summary.status === "starting" ||
      summary.status === "stopping" ||
      summary.services.some((service) => service.state === "starting")),
  );
}

/**
 * Loads the current user's Lakebox summary, refreshes it while visible, and
 * exposes lifecycle and service actions. Polling is faster while anything is
 * starting or stopping.
 */
export function useLakebox(client: LakeboxClient, enabled = true): LakeboxState {
  const [summary, setSummary] = useState<LakeboxSummary>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      setSummary(await client.status());
      setError(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const transitioning = lakeboxTransitioning(summary);
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = window.setInterval(tick, transitioning ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, refresh, transitioning]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setBusy((current) => new Set(current).add(key));
      setError(undefined);
      try {
        await action();
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        await refresh();
      }
    },
    [refresh],
  );

  const updateService = useCallback((service: LakeboxService) => {
    setSummary((current) =>
      current
        ? {
            ...current,
            services: current.services.some((candidate) => candidate.name === service.name)
              ? current.services.map((candidate) =>
                  candidate.name === service.name ? service : candidate,
                )
              : [...current.services, service],
          }
        : current,
    );
  }, []);

  return {
    summary,
    loading,
    ...(error ? { error } : {}),
    busy,
    refresh,
    start: () =>
      run("lakebox:start", async () => {
        setSummary((current) => (current ? { ...current, status: "starting" } : current));
        setSummary(await client.start());
      }),
    stop: () =>
      run("lakebox:stop", async () => {
        setSummary((current) => (current ? { ...current, status: "stopping" } : current));
        setSummary(await client.stop());
      }),
    open: (service) => {
      if (service.state === "ready" && service.openUrl) {
        window.open(resolveServiceUrl(service.openUrl), "_blank", "noopener,noreferrer");
        return Promise.resolve();
      }
      const pending = window.open("about:blank", "_blank");
      if (pending) pending.opener = null;
      return run(`service:${service.name}:start`, async () => {
        updateService({ ...service, state: "starting" });
        const started = await client.startService(service.name);
        updateService(started);
        if (started.state !== "ready" || !started.openUrl) {
          pending?.close();
          throw new Error(started.error ?? `${service.name} did not become ready`);
        }
        const url = resolveServiceUrl(started.openUrl);
        if (pending) pending.location.replace(url);
        else window.open(url, "_blank", "noopener,noreferrer");
      });
    },
    startService: (name) =>
      run(`service:${name}:start`, async () => updateService(await client.startService(name))),
    stopService: (name) =>
      run(`service:${name}:stop`, async () => updateService(await client.stopService(name))),
    removeService: (name) =>
      run(`service:${name}:remove`, async () => {
        await client.removeService(name);
      }),
    clearError: () => setError(undefined),
  };
}

/**
 * Streams metrics while `enabled`, keeping a bounded recent series. The server
 * samples only while the Lakebox runs and at least one stream is open.
 */
export function useLakeboxMetrics(
  client: LakeboxClient,
  enabled: boolean,
): readonly LakeboxMetricsSnapshot[] {
  const [series, setSeries] = useState<readonly LakeboxMetricsSnapshot[]>([]);
  useEffect(() => {
    if (!enabled) {
      setSeries([]);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const response of client.metricsStream(controller.signal)) {
          setSeries((current) => [...current, ...response.series].slice(-METRICS_CAPACITY));
        }
      } catch {
        // The stream closes when the Lakebox stops or the page navigates away.
      }
    })();
    return () => controller.abort();
  }, [client, enabled]);
  return series;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

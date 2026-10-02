import { useCallback, useEffect, useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";

import {
  commands,
  events,
  type AuthStatus,
  type DesktopStatus,
  type MetricsSnapshot_Deserialize,
  type ModelSnapshot_Deserialize,
  type ProfileSummary,
  type RuntimeSelection,
} from "./bindings.ts";

type CommandResult<T> = { status: "ok"; data: T } | { status: "error"; error: string };

const EMPTY_METRICS: MetricsSnapshot_Deserialize = {
  mode: "off",
  controlsEnabled: false,
  generatedAtMs: 0,
  uptimeSeconds: 0,
  summary: {
    connections: 0,
    activeRequests: 0,
    activeStreams: 0,
    requestsPerMinute: 0,
    tokensPerMinute: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    p99LatencyMs: 0,
    rate429Percent: 0,
    activeModels: 0,
    totalRequests: 0,
    totalRateLimited: 0,
    totalFallbacks: 0,
    cooldownKeys: 0,
    rateLimitWaiters: 0,
    probeKeys: 0,
    waitCancellations: 0,
    cooldownReleases: 0,
  },
  history: [],
  rollupHistory: [],
  models: [],
  reasoningLevels: [],
  rateLimitEvents: [],
  retention: {
    detailedResolutionSeconds: 5,
    detailedSeconds: 3_600,
    rollupResolutionSeconds: 60,
    rollupSeconds: 86_400,
    modelSeriesLimit: 32,
    targetBytes: 0,
    estimatedBytes: 0,
    processLocal: true,
  },
};

function data<T>(result: CommandResult<T>): T {
  if (result.status === "error") throw new Error(result.error);
  return result.data;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(value >= 99.95 ? 0 : 1)}%`;
}

function successRate(model: ModelSnapshot_Deserialize): number {
  if (!model.requests) return 100;
  return ((model.requests - model.errors) * 100) / model.requests;
}

function limiterState(model: ModelSnapshot_Deserialize): {
  label: string;
  tone: "healthy" | "cooldown" | "waiting";
} {
  if (model.capacityWaiters + model.cooldownWaiters > 0) {
    return {
      label: `${model.capacityWaiters + model.cooldownWaiters} waiting`,
      tone: "waiting",
    };
  }
  if (model.cooldownKeys > 0) {
    return {
      label: `Cooldown ${Math.ceil(model.maxRemainingCooldownMs / 1_000)}s`,
      tone: "cooldown",
    };
  }
  if (model.limiter === "enforced") {
    return { label: `Limited ${model.penaltyBasisPoints / 100}%`, tone: "cooldown" };
  }
  return { label: "Healthy", tone: "healthy" };
}

function Logo() {
  return (
    <svg className="brand-icon" viewBox="0 0 64 64" role="img" aria-label="dbx tools">
      <rect width="64" height="64" rx="12" fill="#F9F7F4" />
      <g shapeRendering="crispEdges">
        <path
          d="M4 28h8v8H4zm8 0h8v16h-8zm8-8h8v16h-8zm8 8h8v8h-8zm8-8h8v16h-8zm8 8h8v16h-8zm8 0h4v8h-4z"
          fill="#FF3621"
        />
        <path d="M4 28h8v8H4zm52 0h4v8h-4z" fill="#98102A" />
        <path d="M28 28h8v8h-8z" fill="#FF5F46" />
      </g>
    </svg>
  );
}

export function App() {
  const [desktop, setDesktop] = useState<DesktopStatus>();
  const [metrics, setMetrics] = useState<MetricsSnapshot_Deserialize>(EMPTY_METRICS);
  const [auth, setAuth] = useState<AuthStatus>();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [busyModel, setBusyModel] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [desktopStatus, snapshot, authStatus, profileList] = await Promise.all([
        commands.getDesktopStatus(),
        commands.getMetrics(null),
        commands.getAuthStatus(),
        commands.listProfiles(false),
      ]);
      setDesktop(data(desktopStatus));
      setMetrics(data(snapshot));
      setAuth(data(authStatus));
      setProfiles(data(profileList).profiles);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    let unlisten: (() => void) | undefined;
    void events.metricsUpdated
      .listen((event) => {
        setMetrics(event.payload.snapshot);
      })
      .then((dispose) => {
        unlisten = dispose;
      });
    return () => unlisten?.();
  }, [load]);

  const switchProfile = async (value: string) => {
    const selection: RuntimeSelection = value
      ? { kind: "profile", profile: value }
      : { kind: "ambient" };
    try {
      setAuth(data(await commands.switchRuntime(selection)));
      setMetrics(data(await commands.getMetrics(null)));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const controlModel = async (model: ModelSnapshot_Deserialize, action: "cancel" | "retry") => {
    setBusyModel(model.model);
    try {
      if (action === "cancel") {
        data(await commands.cancelModelWaits({ model: model.model }));
      } else {
        data(await commands.retryModelNow({ model: model.model }));
      }
      setMetrics(data(await commands.getMetrics(null)));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyModel(undefined);
    }
  };

  const visibleModels = useMemo(
    () =>
      metrics.models.filter((model) => {
        const matchesSearch = model.model.toLowerCase().includes(search.trim().toLowerCase());
        if (!matchesSearch) return false;
        const tone = limiterState(model).tone;
        return stateFilter === "all" || stateFilter === tone;
      }),
    [metrics.models, search, stateFilter],
  );

  const history = metrics.history.length ? metrics.history : metrics.rollupHistory;
  const trafficOption = useMemo(
    () => ({
      animationDuration: 280,
      color: ["#0E538B"],
      grid: { left: 42, right: 18, top: 18, bottom: 28 },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: history.map((bucket) =>
          new Date(bucket.startedAtMs).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        ),
        axisLine: { lineStyle: { color: "#E4E2DD" } },
        axisLabel: { color: "#618794", fontSize: 10 },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        splitLine: { lineStyle: { color: "#E4E2DD" } },
        axisLabel: { color: "#618794", fontSize: 10 },
      },
      series: [
        {
          name: "Requests",
          type: "line",
          smooth: 0.35,
          showSymbol: false,
          data: history.map((bucket) => bucket.requests),
          lineStyle: { width: 3 },
          areaStyle: { color: "rgba(14, 83, 139, 0.10)" },
        },
      ],
    }),
    [history],
  );

  const reasoning = metrics.reasoningLevels.filter((level) => level.requests > 0);
  const reasoningOption = useMemo(
    () => ({
      animationDuration: 280,
      color: ["#0E538B", "#00A972", "#C26A00", "#618794"],
      tooltip: { trigger: "item" },
      series: [
        {
          type: "pie",
          radius: ["56%", "78%"],
          center: ["50%", "50%"],
          label: { show: false },
          data: reasoning.map((level) => ({ name: level.level, value: level.requests })),
        },
      ],
    }),
    [reasoning],
  );

  if (loading) return <main className="loading">Loading Model Proxy...</main>;

  const totalReasoning = reasoning.reduce((total, level) => total + level.requests, 0);
  const success =
    metrics.summary.totalRequests === 0
      ? 100
      : ((metrics.summary.totalRequests -
          metrics.models.reduce((total, model) => total + model.errors, 0)) *
          100) /
        metrics.summary.totalRequests;

  return (
    <main className="app">
      <header className="app-header">
        <div className="brand">
          <Logo />
          <div>
            <h1 className="brand-title">Model Proxy</h1>
            <div className="brand-subtitle">Local model gateway</div>
          </div>
        </div>
        <div className="header-controls">
          <div className="status-pill">
            <span className={`status-dot ${desktop?.running ? "running" : "stopped"}`} />
            {desktop?.running ? `Running on ${desktop.address ?? "local"}` : "Unavailable"}
          </div>
          <div className="profile-field">
            <label htmlFor="profile">Databricks profile</label>
            <select
              id="profile"
              value={auth?.runtime.selection.kind === "profile" ? auth.runtime.profile : ""}
              disabled={!auth?.runtime.switchingEnabled}
              onChange={(event) => void switchProfile(event.target.value)}
            >
              <option value="">Ambient ({auth?.runtime.profile ?? "automatic"})</option>
              {profiles.map((profile) => (
                <option key={profile.name} value={profile.name}>
                  {profile.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="kpi-grid" aria-label="Proxy overview">
        <Kpi
          label="Requests"
          value={formatCount(metrics.summary.totalRequests)}
          note="Current runtime"
        />
        <Kpi
          label="Success rate"
          value={formatPercent(success)}
          note={`${formatCount(metrics.models.reduce((total, model) => total + model.errors, 0))} errors`}
          tone="success"
        />
        <Kpi
          label="P50 latency"
          value={formatDuration(metrics.summary.p50LatencyMs)}
          note={`P95 ${formatDuration(metrics.summary.p95LatencyMs)}`}
        />
        <Kpi
          label="Active limits"
          value={formatCount(metrics.summary.cooldownKeys)}
          note={`${formatCount(metrics.summary.rateLimitWaiters)} requests waiting`}
          tone="warning"
        />
      </section>

      <section className="chart-grid">
        <article className="card chart-card">
          <div className="section-heading">
            <div>
              <h2 className="section-title">Traffic</h2>
              <div className="section-subtitle">
                Last {metrics.retention.detailedSeconds / 60} minutes
              </div>
            </div>
          </div>
          <ReactECharts className="chart" option={trafficOption} notMerge lazyUpdate />
        </article>
        <article className="card chart-card">
          <div>
            <h2 className="section-title">Reasoning usage</h2>
            <div className="section-subtitle">By request setting</div>
          </div>
          <div className="reasoning-layout">
            <ReactECharts
              className="reasoning-chart"
              option={reasoningOption}
              notMerge
              lazyUpdate
            />
            <div className="legend">
              {reasoning.length ? (
                reasoning.map((level, index) => (
                  <div className="legend-row" key={level.level}>
                    <span className="legend-label">
                      <span
                        className="legend-swatch"
                        style={{
                          background: ["#0E538B", "#00A972", "#C26A00", "#618794"][index % 4],
                        }}
                      />
                      {level.level}
                    </span>
                    <strong>{formatPercent((level.requests * 100) / totalReasoning)}</strong>
                  </div>
                ))
              ) : (
                <div className="section-subtitle">No reasoning data yet</div>
              )}
            </div>
          </div>
        </article>
      </section>

      <section className="card table-card">
        <div className="table-toolbar">
          <div>
            <h2 className="section-title">Model performance</h2>
            <div className="section-subtitle">
              Live model health, throughput, and local rate-limit state
            </div>
          </div>
          <div className="table-filters">
            <input
              className="search-field"
              aria-label="Search models"
              placeholder="Search models"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              className="state-filter"
              aria-label="Filter limiter state"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value)}
            >
              <option value="all">All states</option>
              <option value="healthy">Healthy</option>
              <option value="cooldown">Cooldown</option>
              <option value="waiting">Waiting</option>
            </select>
          </div>
        </div>
        <div className="table-wrap">
          <table className="model-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Requests</th>
                <th>Success</th>
                <th>P50</th>
                <th>Tokens in / out</th>
                <th>Rate limit</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleModels.map((model) => {
                const limiter = limiterState(model);
                const busy = busyModel === model.model;
                return (
                  <tr key={model.model}>
                    <td className="model-name">{model.model}</td>
                    <td>{formatCount(model.requests)}</td>
                    <td>{formatPercent(successRate(model))}</td>
                    <td>{formatDuration(model.p50LatencyMs)}</td>
                    <td className="token-cell">
                      {formatCount(model.inputTokens)} / {formatCount(model.outputTokens)}
                    </td>
                    <td>
                      <span className="limiter-pill">
                        <span className={`limiter-dot ${limiter.tone}`} />
                        {limiter.label}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        {model.cooldownKeys > 0 ? (
                          <button
                            className="action-button"
                            disabled={busy}
                            onClick={() => void controlModel(model, "retry")}
                          >
                            Retry now
                          </button>
                        ) : null}
                        {model.capacityWaiters + model.cooldownWaiters > 0 ? (
                          <button
                            className="action-button danger"
                            disabled={busy}
                            onClick={() => void controlModel(model, "cancel")}
                          >
                            Cancel waits
                          </button>
                        ) : null}
                        {!model.cooldownKeys && !(model.capacityWaiters + model.cooldownWaiters) ? (
                          <span className="section-subtitle">-</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!visibleModels.length ? (
                <tr>
                  <td className="empty-cell" colSpan={7}>
                    No models match the current filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Kpi({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "success" | "warning";
}) {
  return (
    <article className="kpi-card">
      <span className={`kpi-accent ${tone ?? ""}`} />
      <div>
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">{value}</div>
        <div className="kpi-note">{note}</div>
      </div>
    </article>
  );
}

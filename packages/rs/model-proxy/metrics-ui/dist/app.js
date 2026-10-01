(() => {
  "use strict";

  const dashboard = document.querySelector(".dashboard");
  const liveStatus = document.querySelector("#live-status");
  const liveLabel = liveStatus.querySelector("span");
  const liveIcon = liveStatus.querySelector("img");
  const modelFilter = document.querySelector("#model-filter");
  const outcomeFilter = document.querySelector("#outcome-filter");
  const notice = document.querySelector("#notice");
  const widgetTooltip = document.querySelector("#widget-tooltip");

  const state = {
    rangeHours: 1,
    model: "all",
    outcome: "all",
    hidden: document.hidden,
    snapshot: null,
    epochOffsetMs: Date.now(),
    reconnectAttempt: 0,
    reconnectTimer: null,
    eventSource: null,
    snapshotRequest: 0,
  };
  const charts = new Map();

  const statusAssets = {
    live: "/metrics/assets/status-live-8.svg",
    reconnecting: "/metrics/assets/status-danger-8.svg",
  };

  const layoutStorageKey = "dbx-tools.model-proxy.metrics-layout.v4";
  const defaultLayout = Array.from(document.querySelectorAll(".grid-stack-item[gs-id]"), (item) => ({
    id: item.getAttribute("gs-id"),
    x: Number(item.getAttribute("gs-x")),
    y: Number(item.getAttribute("gs-y")),
    w: Number(item.getAttribute("gs-w")),
    h: Number(item.getAttribute("gs-h")),
  }));

  function readStoredLayout(value) {
    try {
      const layout = JSON.parse(value ?? localStorage.getItem(layoutStorageKey));
      if (!Array.isArray(layout) || layout.length > 32) {
        return null;
      }
      const known = new Set(
        Array.from(document.querySelectorAll(".grid-stack-item[gs-id]"), (item) =>
          item.getAttribute("gs-id"),
        ),
      );
      const valid = layout
        .map((item) => {
          const fallback = defaultLayout.find((candidate) => candidate.id === item?.id);
          return fallback
            ? {
                id: item.id,
                x: item.x ?? fallback.x,
                y: item.y ?? fallback.y,
                w: item.w ?? fallback.w,
                h: item.h ?? fallback.h,
              }
            : null;
        })
        .filter(
          (item) =>
            known.has(item?.id) &&
            ["x", "y", "w", "h"].every((field) => Number.isInteger(item[field])) &&
            item.x >= 0 &&
            item.y >= 0 &&
            item.w > 0 &&
            item.h > 0,
        );
      return valid.length ? valid : null;
    } catch {
      return null;
    }
  }

  function applyInitialLayout(layout) {
    layout?.forEach((item) => {
      const element = document.querySelector(`.grid-stack-item[gs-id="${CSS.escape(item.id)}"]`);
      if (!element) {
        return;
      }
      ["x", "y", "w", "h"].forEach((field) => {
        element.setAttribute(`gs-${field}`, String(item[field]));
      });
    });
  }

  applyInitialLayout(readStoredLayout());

  const grid = window.GridStack?.init({
    column: 12,
    cellHeight: 68,
    margin: 5,
    animate: true,
    float: false,
    alwaysShowResizeHandle: "mobile",
    columnOpts: {
      breakpoints: [
        { w: 700, c: 1, layout: "list" },
        { w: 1100, c: 6, layout: "moveScale" },
      ],
    },
  });
  if (!grid) {
    notice.textContent = "Dashboard layout controls could not be loaded.";
  }

  function saveLayout() {
    if (!grid) {
      return;
    }
    const layout = grid
      .save(false, false, undefined, 12)
      .filter((item) => item.id)
      .map((item) => {
        const fallback = defaultLayout.find((candidate) => candidate.id === item.id);
        return {
          id: item.id,
          x: item.x ?? fallback?.x ?? 0,
          y: item.y ?? fallback?.y ?? 0,
          w: item.w ?? item.minW ?? fallback?.w ?? 1,
          h: item.h ?? item.minH ?? fallback?.h ?? 1,
        };
      });
    try {
      localStorage.setItem(layoutStorageKey, JSON.stringify(layout));
    } catch {
      notice.textContent = "Widget layout could not be saved in browser storage.";
    }
  }

  grid?.on("change", saveLayout);
  document.querySelector("#layout-reset").addEventListener("click", () => {
    if (!grid) {
      return;
    }
    grid.load(
      defaultLayout.map((item) => ({ ...item })),
      false,
    );
    try {
      localStorage.setItem(layoutStorageKey, JSON.stringify(defaultLayout));
    } catch {
      notice.textContent = "Default widget layout could not be saved in browser storage.";
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== layoutStorageKey || !grid) {
      return;
    }
    const layout = readStoredLayout(event.newValue);
    if (layout) {
      grid.load(layout, false);
    }
  });

  function setLiveState(value, label) {
    liveStatus.dataset.state = value;
    liveIcon.src = statusAssets[value];
    liveLabel.textContent = label;
    const description =
      value === "live" ? "Metrics stream connected" : "Metrics stream disconnected";
    liveStatus.dataset.tooltip = description;
    liveStatus.setAttribute("aria-label", description);
  }

  let tooltipTimer = null;
  let tooltipOwner = null;

  function showTooltip(target) {
    window.clearTimeout(tooltipTimer);
    tooltipOwner?.setAttribute("aria-expanded", "false");
    tooltipOwner = target;
    target.setAttribute("aria-expanded", "true");
    widgetTooltip.textContent = target.dataset.tooltip;
    widgetTooltip.hidden = false;
    const widgetRect = target.getBoundingClientRect();
    const tooltipRect = widgetTooltip.getBoundingClientRect();
    const left = Math.min(
      window.innerWidth - tooltipRect.width - 12,
      Math.max(12, widgetRect.left + (widgetRect.width - tooltipRect.width) / 2),
    );
    const above = widgetRect.top - tooltipRect.height - 10;
    widgetTooltip.style.left = `${left}px`;
    widgetTooltip.style.top = `${above >= 12 ? above : widgetRect.bottom + 10}px`;
  }

  function hideTooltip() {
    window.clearTimeout(tooltipTimer);
    tooltipTimer = null;
    tooltipOwner?.setAttribute("aria-expanded", "false");
    tooltipOwner = null;
    widgetTooltip.hidden = true;
  }

  function scheduleTooltip(target) {
    window.clearTimeout(tooltipTimer);
    tooltipTimer = window.setTimeout(() => showTooltip(target), 500);
  }

  document.querySelectorAll(".grid-stack-item-content[data-tooltip]").forEach((widget) => {
    const description = widget.dataset.tooltip;
    widget.removeAttribute("data-tooltip");
    widget.removeAttribute("tabindex");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "widget-info";
    button.setAttribute("aria-label", "About this metric");
    button.setAttribute("aria-expanded", "false");
    button.dataset.tooltip = description;
    button.dataset.tooltipTrigger = "click";
    button.innerHTML =
      '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7h.01"/></svg>';
    (widget.querySelector(".panel-heading") ?? widget).append(button);
  });

  document.querySelectorAll("[data-tooltip]").forEach((target) => {
    if (target.dataset.tooltipTrigger === "click") {
      target.addEventListener("click", (event) => {
        event.stopPropagation();
        if (tooltipOwner === target && !widgetTooltip.hidden) {
          hideTooltip();
        } else {
          showTooltip(target);
        }
      });
      return;
    }
    target.addEventListener("pointerenter", () => scheduleTooltip(target));
    target.addEventListener("pointerleave", hideTooltip);
    target.addEventListener("focus", () => scheduleTooltip(target));
    target.addEventListener("blur", hideTooltip);
  });
  document.addEventListener("click", (event) => {
    if (tooltipOwner && !tooltipOwner.contains(event.target)) {
      hideTooltip();
    }
  });
  grid?.on("dragstart resizestart", hideTooltip);

  function formatNumber(value) {
    return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
      Number(value || 0),
    );
  }

  function formatInteger(value) {
    return new Intl.NumberFormat("en").format(Number(value || 0));
  }

  function formatDuration(milliseconds) {
    const value = Number(milliseconds || 0);
    if (value >= 1000) {
      return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s`;
    }
    return `${Math.round(value)}ms`;
  }

  function formatUptime(seconds) {
    const value = Math.max(0, Number(seconds || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const remainder = Math.floor(value % 60);
    return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
  }

  function selectedBuckets(snapshot, selectedModel) {
    const source =
      state.rangeHours <= 1
        ? (selectedModel?.history ?? snapshot.history)
        : (selectedModel?.rollupHistory ?? snapshot.rollupHistory);
    const boundary = Math.max(0, snapshot.generatedAtMs - state.rangeHours * 60 * 60 * 1000);
    return source.filter((bucket) => bucket.startedAtMs >= boundary);
  }

  function sumBuckets(buckets, field) {
    return buckets.reduce((total, bucket) => total + Number(bucket[field] || 0), 0);
  }

  function chartColor(variable, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback;
  }

  function formatAxisTime(seconds) {
    const date = new Date(seconds * 1000);
    if (state.rangeHours >= 24) {
      return new Intl.DateTimeFormat([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
    }
    return new Intl.DateTimeFormat([], {
      hour: "2-digit",
      minute: "2-digit",
      ...(state.rangeHours <= 0.25 ? { second: "2-digit" } : {}),
    }).format(date);
  }

  function chartBounds() {
    const maximum = Date.now() / 1000;
    return { min: maximum - state.rangeHours * 60 * 60, max: maximum };
  }

  function chartDimensions(element) {
    return {
      width: Math.max(280, Math.floor(element.clientWidth || 720)),
      height: Math.max(140, Math.floor(element.clientHeight || 190)),
    };
  }

  function createChart(id, series, valueFormatter) {
    const element = document.querySelector(`#${id}`);
    if (!element || typeof window.uPlot !== "function") {
      return null;
    }
    const foreground = chartColor("--dashboard-muted", "#496A75");
    const border = chartColor("--brand-border", "#E4E2DD");
    const font = `10px ${chartColor("--brand-font-sans", "sans-serif")}`;
    const options = {
      ...chartDimensions(element),
      padding: [10, 12, 0, 0],
      legend: { show: false },
      cursor: {
        drag: { setScale: false, x: false, y: false },
        points: { size: 8, width: 2 },
      },
      scales: {
        x: { time: true, auto: false },
        y: { auto: false },
      },
      axes: [
        {
          stroke: foreground,
          font,
          gap: 8,
          size: 42,
          grid: { stroke: border, width: 1 },
          ticks: { stroke: border, width: 1 },
          values: (_chart, values) => values.map(formatAxisTime),
        },
        {
          stroke: foreground,
          font,
          gap: 8,
          size: 66,
          grid: { stroke: border, width: 1 },
          ticks: { stroke: border, width: 1 },
          values: (_chart, values) => values.map(valueFormatter),
        },
      ],
      series: [
        {},
        ...series.map((item) => ({
          label: item.label,
          stroke: item.color,
          width: 2,
          points: { show: false },
          value: (_chart, value) => (value == null ? "—" : valueFormatter(value)),
        })),
      ],
    };
    const chart = new window.uPlot(options, [[], ...series.map(() => [])], element);
    const resize = () => {
      const size = chartDimensions(element);
      if (chart.width !== size.width || chart.height !== size.height) {
        chart.setSize(size);
      }
    };
    const observer = new ResizeObserver(() => window.requestAnimationFrame(resize));
    observer.observe(element);
    const record = { chart, observer, element };
    charts.set(id, record);
    return record;
  }

  function ensureCharts() {
    if (typeof window.uPlot !== "function") {
      notice.textContent = "Time-series charts could not be loaded.";
      return false;
    }
    const blue = chartColor("--brand-primary-hover", "#0E538B");
    const green = chartColor("--brand-accent", "#00A972");
    const muted = chartColor("--brand-muted", "#618794");
    const warning = chartColor("--dashboard-warning", "#955100");
    if (!charts.has("request-chart")) {
      createChart(
        "request-chart",
        [
          { label: "Requests", color: blue },
          { label: "Upstream 429s", color: warning },
        ],
        (value) => formatNumber(value),
      );
    }
    if (!charts.has("token-chart")) {
      createChart(
        "token-chart",
        [
          { label: "Input tokens", color: green },
          { label: "Output tokens", color: blue },
        ],
        (value) => formatNumber(value),
      );
    }
    if (!charts.has("latency-chart")) {
      createChart(
        "latency-chart",
        [
          { label: "Average", color: muted },
          { label: "Maximum", color: warning },
        ],
        formatDuration,
      );
    }
    return charts.size === 3;
  }

  function updateChart(id, data) {
    const record = charts.get(id);
    if (!record) {
      return;
    }
    const values = data.slice(1).flatMap((series) => series.filter((value) => value != null));
    const maximum = Math.max(1, ...values);
    record.chart.batch(() => {
      record.chart.setData(data, false);
      record.chart.setScale("y", { min: 0, max: maximum * 1.08 });
      record.chart.setScale("x", chartBounds());
    });
  }

  function bucketResolutionSeconds(snapshot) {
    return state.rangeHours <= 1
      ? snapshot.retention.detailedResolutionSeconds
      : snapshot.retention.rollupResolutionSeconds;
  }

  function bucketRate(bucket, field, resolutionSeconds) {
    return (Number(bucket[field] || 0) * 60) / Math.max(1, resolutionSeconds);
  }

  function renderSummary(snapshot, buckets, selectedModel) {
    const summary = snapshot.summary;
    const minuteBuckets = buckets.filter(
      (bucket) => bucket.startedAtMs >= snapshot.generatedAtMs - 60_000,
    );
    const requestCount = sumBuckets(buckets, "requests");
    const rateLimited = sumBuckets(buckets, "rateLimited");
    const errors = sumBuckets(buckets, "errors");
    const errorPercent = requestCount ? (errors * 100) / requestCount : 0;
    const minuteRateLimited = sumBuckets(minuteBuckets, "rateLimited");
    document.querySelector("#active-requests").textContent =
      formatInteger(summary.activeRequests);
    document.querySelector("#connection-detail").textContent =
      `${formatInteger(summary.connections)} open sockets · ${formatInteger(summary.activeStreams)} streams`;
    document.querySelector("#requests-minute").textContent = formatInteger(
      selectedModel ? sumBuckets(minuteBuckets, "requests") : summary.requestsPerMinute,
    );
    document.querySelector("#total-requests").textContent =
      `${formatInteger(selectedModel?.requests ?? summary.totalRequests)} since process start`;
    document.querySelector("#tokens-minute").textContent = formatNumber(
      selectedModel
        ? sumBuckets(minuteBuckets, "inputTokens") + sumBuckets(minuteBuckets, "outputTokens")
        : summary.tokensPerMinute,
    );
    document.querySelector("#p95-latency").textContent = formatDuration(
      selectedModel ? selectedModel.p95LatencyMs : summary.p95LatencyMs,
    );
    document.querySelector("#p50-latency").textContent =
      `p50 ${formatDuration(selectedModel ? selectedModel.p50LatencyMs : summary.p50LatencyMs)} · p99 ${formatDuration(selectedModel ? selectedModel.p99LatencyMs : summary.p99LatencyMs)}`;
    document.querySelector("#rate-429").textContent = `${formatInteger(minuteRateLimited)}/min`;
    document.querySelector("#rate-429-count").textContent =
      `${formatInteger(rateLimited)} in selected range`;
    document.querySelector("#error-rate").textContent = `${errorPercent.toFixed(2)}%`;
    document.querySelector("#error-count").textContent =
      `${formatInteger(errors)} errors in selected range`;
  }

  function renderCharts(snapshot, buckets, selectedModel) {
    if (!ensureCharts()) {
      return;
    }
    const minuteBuckets = buckets.filter(
      (bucket) => bucket.startedAtMs >= snapshot.generatedAtMs - 60_000,
    );
    const resolutionSeconds = bucketResolutionSeconds(snapshot);
    const requestField =
      state.outcome === "errors"
        ? "errors"
        : state.outcome === "rate-limited"
          ? "rateLimited"
          : "requests";
    const requestValue = (bucket) => {
      if (state.outcome === "success") {
        return Math.max(0, Number(bucket.requests || 0) - Number(bucket.errors || 0));
      }
      return Number(bucket[requestField] || 0);
    };
    const requestRate =
      state.outcome === "success"
        ? Math.max(0, sumBuckets(minuteBuckets, "requests") - sumBuckets(minuteBuckets, "errors"))
        : sumBuckets(minuteBuckets, requestField);
    const tokenRate = selectedModel
      ? sumBuckets(minuteBuckets, "inputTokens") + sumBuckets(minuteBuckets, "outputTokens")
      : snapshot.summary.tokensPerMinute;
    const requestLabels = {
      all: "All requests",
      success: "Successful requests",
      errors: "Failed requests",
      "rate-limited": "Upstream 429s",
    };
    document.querySelector("#request-chart-value").textContent =
      state.outcome === "rate-limited"
        ? `${formatInteger(requestRate)} signals/min`
        : `${formatInteger(requestRate)} rpm`;
    document.querySelector("#request-series-label").textContent = requestLabels[state.outcome];
    document.querySelector("#request-429-legend").hidden = state.outcome === "rate-limited";
    document.querySelector("#token-chart-value").textContent = `${formatNumber(tokenRate)} tpm`;
    document.querySelector("#latency-chart-value").textContent =
      `p95 ${formatDuration(selectedModel?.p95LatencyMs ?? snapshot.summary.p95LatencyMs)}`;
    const timestamps = buckets.map(
      (bucket) => (state.epochOffsetMs + Number(bucket.startedAtMs || 0)) / 1000,
    );
    updateChart("request-chart", [
      timestamps,
      buckets.map((bucket) => (requestValue(bucket) * 60) / Math.max(1, resolutionSeconds)),
      buckets.map((bucket) =>
        state.outcome === "rate-limited"
          ? null
          : bucketRate(bucket, "rateLimited", resolutionSeconds),
      ),
    ]);
    updateChart("token-chart", [
      timestamps,
      buckets.map((bucket) => bucketRate(bucket, "inputTokens", resolutionSeconds)),
      buckets.map((bucket) => bucketRate(bucket, "outputTokens", resolutionSeconds)),
    ]);
    updateChart("latency-chart", [
      timestamps,
      buckets.map((bucket) => Number(bucket.averageLatencyMs || 0)),
      buckets.map((bucket) => Number(bucket.maximumLatencyMs || 0)),
    ]);
  }

  function updateModelOptions(models) {
    const existing = new Set(Array.from(modelFilter.options).map((option) => option.value));
    models.forEach((model) => {
      if (existing.has(model.model)) {
        return;
      }
      const option = document.createElement("option");
      option.value = model.model;
      option.textContent = model.model;
      modelFilter.append(option);
    });
    if (state.model !== "all" && !models.some((model) => model.model === state.model)) {
      state.model = "all";
      modelFilter.value = "all";
    }
  }

  function cell(value, className, stateName) {
    const element = document.createElement("td");
    element.textContent = value;
    if (className) {
      element.className = className;
    }
    if (stateName) {
      element.dataset.state = stateName;
    }
    return element;
  }

  const reasoningLabels = {
    default: "Provider default",
    none: "Reasoning off",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Maximum",
    adaptive: "Adaptive",
    enabled: "Enabled (provider-defined)",
  };

  function reasoningLabel(level) {
    return reasoningLabels[level] ?? level;
  }

  function dominantReasoning(levels) {
    if (!levels?.length) {
      return "—";
    }
    const dominant = levels.reduce((current, candidate) =>
      Number(candidate.requests || 0) > Number(current.requests || 0) ? candidate : current,
    );
    return reasoningLabel(dominant.level);
  }

  function renderReasoning(snapshot, selectedModel) {
    const levels = selectedModel?.reasoningLevels ?? snapshot.reasoningLevels ?? [];
    const total = levels.reduce((sum, level) => sum + Number(level.requests || 0), 0);
    const list = document.querySelector("#reasoning-levels");
    list.replaceChildren();
    if (!total) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "Waiting for model traffic";
      list.append(empty);
      document.querySelector("#reasoning-total").textContent = "No model requests";
      return;
    }
    [...levels]
      .sort(
        (left, right) =>
          Number(right.requests || 0) - Number(left.requests || 0) ||
          reasoningLabel(left.level).localeCompare(reasoningLabel(right.level)),
      )
      .forEach((level) => {
        const requests = Number(level.requests || 0);
        const percent = (requests * 100) / total;
        const row = document.createElement("li");
        const heading = document.createElement("div");
        const label = document.createElement("span");
        label.textContent = reasoningLabel(level.level);
        const value = document.createElement("strong");
        value.textContent = `${formatInteger(requests)} · ${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
        heading.append(label, value);
        const track = document.createElement("div");
        track.className = "reasoning-track";
        const fill = document.createElement("span");
        fill.style.width = `${Math.max(1, percent)}%`;
        track.append(fill);
        row.append(heading, track);
        list.append(row);
      });
    document.querySelector("#reasoning-total").textContent =
      `${formatInteger(total)} classified requests`;
  }

  function renderModels(snapshot) {
    updateModelOptions(snapshot.models);
    let models =
      state.model === "all"
        ? snapshot.models
        : snapshot.models.filter((model) => model.model === state.model);
    if (state.outcome === "errors") {
      models = models.filter((model) => Number(model.errors || 0) > 0);
    } else if (state.outcome === "rate-limited") {
      models = models.filter((model) => Number(model.rateLimited || 0) > 0);
    } else if (state.outcome === "success") {
      models = models.filter(
        (model) => Number(model.requests || 0) > Number(model.errors || 0),
      );
    }
    const body = document.querySelector("#models-body");
    body.replaceChildren();
    if (!models.length) {
      const row = document.createElement("tr");
      const empty = cell("Waiting for model traffic", "empty");
      empty.colSpan = 13;
      row.append(empty);
      body.append(row);
    } else {
      models.forEach((model) => {
        const row = document.createElement("tr");
        row.append(
          cell(model.model),
          cell(formatInteger(model.requests)),
          cell(formatDuration(model.p50LatencyMs)),
          cell(formatDuration(model.p95LatencyMs)),
          cell(formatDuration(model.p99LatencyMs)),
          cell(formatNumber(model.inputTokens + model.outputTokens)),
          cell(formatInteger(model.errors)),
          cell(formatInteger(model.rateLimited)),
          cell(formatInteger(model.retries)),
          cell(formatDuration(Number(model.queueWaitMs || 0) / Math.max(1, model.requests || 0))),
          cell(formatInteger(model.queueDepthMax || 0)),
          cell(dominantReasoning(model.reasoningLevels), "reasoning-setting"),
          cell(model.limiter, "limiter", model.limiter),
        );
        body.append(row);
      });
    }
    document.querySelector("#model-count").textContent =
      `${formatInteger(models.length)} shown · ${formatInteger(snapshot.models.length)} tracked`;
  }

  function transitionAsset(kind) {
    if (["activated", "tightened", "reactivated"].includes(kind)) {
      return "/metrics/assets/status-danger-8.svg";
    }
    if (["relaxed", "probation"].includes(kind)) {
      return "/metrics/assets/status-warning-8.svg";
    }
    return "/metrics/assets/status-info-8.svg";
  }

  function renderTimeline(snapshot) {
    const timeline = document.querySelector("#timeline");
    timeline.replaceChildren();
    const events = snapshot.rateLimitEvents.filter(
      (event) => state.model === "all" || event.model === state.model,
    );
    if (!events.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "No rate-limit transitions in retained history";
      timeline.append(empty);
      return;
    }
    events.forEach((event) => {
      const row = document.createElement("li");
      const icon = document.createElement("img");
      icon.src = transitionAsset(event.transition.kind);
      icon.alt = "";
      const detail = document.createElement("div");
      const title = document.createElement("strong");
      const timestamp = new Date(state.epochOffsetMs + event.atMs);
      title.textContent =
        `${timestamp.toLocaleTimeString([], { hour12: false })}  ${event.transition.kind}`;
      const description = document.createElement("span");
      description.textContent =
        `${event.model} · budget ${formatNumber(event.transition.effectiveInputBudget)}`;
      detail.append(title, description);
      row.append(icon, detail);
      timeline.append(row);
    });
  }

  function renderFooter(snapshot) {
    const retained = snapshot.retention.estimatedBytes / (1024 * 1024);
    const target = snapshot.retention.targetBytes / (1024 * 1024);
    const workspace = snapshot.workspace?.id ? `workspace ${snapshot.workspace.id} · ` : "";
    const updatedAt = new Date(state.epochOffsetMs + snapshot.generatedAtMs).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    document.querySelector("#retention-status").textContent =
      `Collecting · process uptime ${formatUptime(snapshot.uptimeSeconds)} · memory ${retained.toFixed(1)} MiB / ${target.toFixed(0)} MiB`;
    document.querySelector("#retention-detail").textContent =
      `${workspace}${snapshot.retention.detailedResolutionSeconds}s detail · ${snapshot.retention.rollupResolutionSeconds}s rollup · updated ${updatedAt}`;
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    state.epochOffsetMs = Date.now() - Number(snapshot.generatedAtMs || 0);
    if (state.hidden) {
      return;
    }
    const selectedModel =
      state.model === "all"
        ? null
        : snapshot.models.find((model) => model.model === state.model) || null;
    const buckets = selectedBuckets(snapshot, selectedModel);
    renderSummary(snapshot, buckets, selectedModel);
    renderCharts(snapshot, buckets, selectedModel);
    renderModels(snapshot);
    renderReasoning(snapshot, selectedModel);
    renderTimeline(snapshot);
    renderFooter(snapshot);
    dashboard.setAttribute("aria-busy", "false");
    notice.textContent = "";
  }

  async function loadSnapshot() {
    const request = ++state.snapshotRequest;
    const query = state.model === "all" ? "" : `?model=${encodeURIComponent(state.model)}`;
    const response = await fetch(`/metrics/snapshot${query}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Snapshot request failed with ${response.status}`);
    }
    const snapshot = await response.json();
    if (request === state.snapshotRequest) {
      render(snapshot);
    }
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) {
      return;
    }
    const delay = Math.min(30_000, 1_000 * 2 ** state.reconnectAttempt);
    state.reconnectAttempt += 1;
    setLiveState("reconnecting", "Reconnecting");
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      connectEvents();
    }, delay);
  }

  function connectEvents() {
    if (state.eventSource) {
      state.eventSource.close();
    }
    const source = new EventSource("/metrics/events");
    state.eventSource = source;
    source.addEventListener("open", () => {
      state.reconnectAttempt = 0;
      setLiveState("live", "Live");
    });
    source.addEventListener("snapshot", (event) => {
      try {
        const snapshot = JSON.parse(event.data);
        if (state.model === "all") {
          render(snapshot);
        } else {
          updateModelOptions(snapshot.models);
          loadSnapshot().catch(() => {
            notice.textContent = "Selected model history could not be refreshed.";
          });
        }
      } catch {
        notice.textContent = "A metrics update could not be decoded.";
      }
    });
    source.addEventListener("error", () => {
      source.close();
      scheduleReconnect();
    });
  }

  window.setInterval(() => {
    if (state.hidden) {
      return;
    }
    const bounds = chartBounds();
    charts.forEach(({ chart }) => chart.setScale("x", bounds));
  }, 1_000);

  document.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      state.rangeHours = Number(button.dataset.range);
      document.querySelectorAll("[data-range]").forEach((candidate) => {
        candidate.setAttribute(
          "aria-pressed",
          String(candidate.dataset.range === button.dataset.range),
        );
      });
      if (state.snapshot) {
        render(state.snapshot);
      }
    });
  });

  modelFilter.addEventListener("change", () => {
    state.model = modelFilter.value;
    loadSnapshot().catch((error) => {
      notice.textContent = error.message;
    });
  });

  outcomeFilter.addEventListener("change", () => {
    state.outcome = outcomeFilter.value;
    if (state.snapshot) {
      render(state.snapshot);
    }
  });

  document.addEventListener("visibilitychange", () => {
    state.hidden = document.hidden;
    if (!state.hidden && state.snapshot) {
      render(state.snapshot);
    }
  });

  loadSnapshot()
    .then(connectEvents)
    .catch((error) => {
      notice.textContent = error.message;
      scheduleReconnect();
    });
})();

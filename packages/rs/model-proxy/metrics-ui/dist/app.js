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
    rangeHours: 6,
    model: "all",
    outcome: "all",
    hidden: document.hidden,
    snapshot: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    eventSource: null,
    snapshotRequest: 0,
  };

  const statusAssets = {
    live: "/metrics/assets/status-live-8.svg",
    reconnecting: "/metrics/assets/status-danger-8.svg",
  };

  const layoutStorageKey = "dbx-tools.model-proxy.metrics-layout.v2";
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
    widget.append(button);
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
      state.rangeHours === 1
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

  function drawLines(element, buckets, series) {
    const width = 720;
    const height = 190;
    const padding = 8;
    const values = series.flatMap((item) => buckets.map(item.value));
    const maximum = Math.max(1, ...values);
    element.replaceChildren();
    element.setAttribute("viewBox", `0 0 ${width} ${height}`);
    element.setAttribute("preserveAspectRatio", "none");

    [0.25, 0.5, 0.75].forEach((ratio) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.classList.add("chart-grid");
      line.setAttribute("x1", String(padding));
      line.setAttribute("x2", String(width - padding));
      line.setAttribute("y1", String(height - padding - ratio * (height - padding * 2)));
      line.setAttribute("y2", String(height - padding - ratio * (height - padding * 2)));
      element.append(line);
    });

    series.forEach((item, seriesIndex) => {
      const amounts = buckets.map(item.value);
      if (!amounts.length) {
        return;
      }
      const points = amounts.map((amount, index) => {
        const x =
          padding + (index / Math.max(amounts.length - 1, 1)) * (width - padding * 2);
        const y = height - padding - (amount / maximum) * (height - padding * 2);
        return [x, y];
      });
      const pathData = points
        .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`)
        .join(" ");
      if (seriesIndex === 0) {
        const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
        area.classList.add("chart-area");
        area.setAttribute(
          "d",
          `${pathData} L${points.at(-1)[0].toFixed(2)} ${height - padding} L${points[0][0].toFixed(2)} ${height - padding} Z`,
        );
        area.setAttribute("fill", item.color);
        element.append(area);
      }
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add("chart-line");
      path.setAttribute("d", pathData);
      path.setAttribute("stroke", item.color);
      element.append(path);

      const pointStep = Math.max(1, Math.ceil(points.length / 18));
      points.forEach(([x, y], index) => {
        if (index % pointStep !== 0 && index !== points.length - 1) {
          return;
        }
        const point = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        point.classList.add("chart-point");
        point.setAttribute("cx", x.toFixed(2));
        point.setAttribute("cy", y.toFixed(2));
        point.setAttribute("r", "3");
        point.setAttribute("stroke", item.color);
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = `${item.label}: ${formatInteger(amounts[index])}`;
        point.append(title);
        element.append(point);
      });
    });
  }

  function renderSummary(snapshot, buckets, selectedModel) {
    const summary = snapshot.summary;
    const minuteBuckets = buckets.filter(
      (bucket) => bucket.startedAtMs >= snapshot.generatedAtMs - 60_000,
    );
    const requestCount = sumBuckets(buckets, "requests");
    const rateLimited = sumBuckets(buckets, "rateLimited");
    const ratePercent = requestCount ? (rateLimited * 100) / requestCount : 0;
    document.querySelector("#connections").textContent = formatInteger(summary.connections);
    document.querySelector("#active-requests").textContent =
      `${formatInteger(summary.activeRequests)} active requests`;
    document.querySelector("#requests-minute").textContent = formatInteger(
      selectedModel ? sumBuckets(minuteBuckets, "requests") : summary.requestsPerMinute,
    );
    document.querySelector("#total-requests").textContent =
      `${formatInteger(summary.totalRequests)} since process start`;
    document.querySelector("#tokens-minute").textContent = formatNumber(
      selectedModel
        ? sumBuckets(minuteBuckets, "inputTokens") + sumBuckets(minuteBuckets, "outputTokens")
        : summary.tokensPerMinute,
    );
    document.querySelector("#p95-latency").textContent = formatDuration(
      selectedModel ? selectedModel.p95LatencyMs : summary.p95LatencyMs,
    );
    document.querySelector("#p50-latency").textContent =
      `p50 ${formatDuration(selectedModel ? selectedModel.p50LatencyMs : summary.p50LatencyMs)}`;
    document.querySelector("#rate-429").textContent = `${ratePercent.toFixed(2)}%`;
    document.querySelector("#rate-429-count").textContent =
      `${formatInteger(rateLimited)} in selected range`;
    document.querySelector("#active-models").textContent = formatInteger(summary.activeModels);
  }

  function renderCharts(snapshot, buckets, selectedModel) {
    const minuteBuckets = buckets.filter(
      (bucket) => bucket.startedAtMs >= snapshot.generatedAtMs - 60_000,
    );
    const requestRate = selectedModel
      ? sumBuckets(minuteBuckets, "requests")
      : snapshot.summary.requestsPerMinute;
    const tokenRate = selectedModel
      ? sumBuckets(minuteBuckets, "inputTokens") + sumBuckets(minuteBuckets, "outputTokens")
      : snapshot.summary.tokensPerMinute;
    const blue = chartColor("--brand-primary-hover", "#0E538B");
    const green = chartColor("--brand-accent", "#00A972");
    const muted = chartColor("--brand-muted", "#618794");
    const warning = chartColor("--dashboard-warning", "#955100");
    const requestValue = (bucket) => {
      if (state.outcome === "errors") {
        return Number(bucket.errors || 0);
      }
      if (state.outcome === "rate-limited") {
        return Number(bucket.rateLimited || 0);
      }
      if (state.outcome === "success") {
        return Math.max(
          0,
          Number(bucket.requests || 0) -
            Number(bucket.errors || 0) -
            Number(bucket.rateLimited || 0),
        );
      }
      return Number(bucket.requests || 0);
    };
    document.querySelector("#request-chart-value").textContent = `${formatInteger(requestRate)} rpm`;
    document.querySelector("#request-chart-subtitle").textContent =
      `${outcomeFilter.options[outcomeFilter.selectedIndex].text.toLowerCase()} · 429 highlighted`;
    document.querySelector("#token-chart-value").textContent = `${formatNumber(tokenRate)} tpm`;
    document.querySelector("#latency-chart-value").textContent =
      `p95 ${formatDuration(selectedModel?.p95LatencyMs ?? snapshot.summary.p95LatencyMs)}`;
    drawLines(document.querySelector("#request-chart"), buckets, [
      { label: state.outcome, value: requestValue, color: blue },
      {
        label: "429",
        value: (bucket) => Number(bucket.rateLimited || 0),
        color: warning,
      },
    ]);
    drawLines(document.querySelector("#token-chart"), buckets, [
      {
        label: "input tokens",
        value: (bucket) => Number(bucket.inputTokens || 0),
        color: green,
      },
      {
        label: "output tokens",
        value: (bucket) => Number(bucket.outputTokens || 0),
        color: blue,
      },
    ]);
    drawLines(document.querySelector("#latency-chart"), buckets, [
      {
        label: "average latency",
        value: (bucket) => Number(bucket.averageLatencyMs || 0),
        color: muted,
      },
      {
        label: "maximum latency",
        value: (bucket) => Number(bucket.maximumLatencyMs || 0),
        color: warning,
      },
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
        (model) =>
          Number(model.requests || 0) >
          Number(model.errors || 0) + Number(model.rateLimited || 0),
      );
    }
    const body = document.querySelector("#models-body");
    body.replaceChildren();
    if (!models.length) {
      const row = document.createElement("tr");
      const empty = cell("Waiting for model traffic", "empty");
      empty.colSpan = 10;
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
          cell(formatInteger(model.retries)),
          cell(`${formatDuration(model.queueWaitMs)} / ${formatInteger(model.queueDepthMax || 0)}`),
          cell(model.limiter, "limiter", model.limiter),
        );
        body.append(row);
      });
    }
    document.querySelector("#model-count").textContent =
      `${formatInteger(models.length)} shown · ${formatInteger(snapshot.models.length)} active`;
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
      const timestamp = new Date(Date.now() - snapshot.generatedAtMs + event.atMs);
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
    document.querySelector("#retention-status").textContent =
      `Collecting · process uptime ${formatUptime(snapshot.uptimeSeconds)} · memory ${retained.toFixed(1)} MiB / ${target.toFixed(0)} MiB`;
    document.querySelector("#retention-detail").textContent =
      `${workspace}${snapshot.retention.detailedResolutionSeconds}s resolution · 1h detail · 24h rollup`;
  }

  function render(snapshot) {
    state.snapshot = snapshot;
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

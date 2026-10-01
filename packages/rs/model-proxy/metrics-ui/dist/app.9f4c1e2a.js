(() => {
  "use strict";

  const dashboard = document.querySelector(".dashboard");
  const liveStatus = document.querySelector("#live-status");
  const liveLabel = liveStatus.querySelector("span");
  const liveIcon = liveStatus.querySelector("img");
  const pauseToggle = document.querySelector("#pause-toggle");
  const detailToggle = document.querySelector("#detail-toggle");
  const modelFilter = document.querySelector("#model-filter");
  const notice = document.querySelector("#notice");

  const state = {
    rangeHours: 6,
    model: "all",
    paused: false,
    hidden: document.hidden,
    snapshot: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    eventSource: null,
  };

  const statusAssets = {
    live: "/metrics/assets/status-live-8.svg",
    paused: "/metrics/assets/status-warning-8.svg",
    reconnecting: "/metrics/assets/status-danger-8.svg",
  };

  function setLiveState(value, label) {
    liveStatus.dataset.state = value;
    liveIcon.src = statusAssets[value];
    liveLabel.textContent = label;
    document.querySelector("#timeline-status").textContent = label;
  }

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

  function selectedBuckets(snapshot) {
    const source = state.rangeHours === 1 ? snapshot.history : snapshot.rollupHistory;
    const boundary = Math.max(0, snapshot.generatedAtMs - state.rangeHours * 60 * 60 * 1000);
    return source.filter((bucket) => bucket.startedAtMs >= boundary);
  }

  function sumBuckets(buckets, field) {
    return buckets.reduce((total, bucket) => total + Number(bucket[field] || 0), 0);
  }

  function drawBars(element, buckets, value, color) {
    const width = 720;
    const height = 190;
    const values = buckets.map(value);
    const maximum = Math.max(1, ...values);
    const gap = 3;
    const barWidth = Math.max(1, (width - gap * Math.max(values.length - 1, 0)) / values.length);
    element.replaceChildren();
    element.setAttribute("viewBox", `0 0 ${width} ${height}`);
    element.setAttribute("preserveAspectRatio", "none");
    values.forEach((amount, index) => {
      const barHeight = Math.max(amount > 0 ? 2 : 0, (amount / maximum) * (height - 12));
      const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bar.setAttribute("x", String(index * (barWidth + gap)));
      bar.setAttribute("y", String(height - barHeight));
      bar.setAttribute("width", String(barWidth));
      bar.setAttribute("height", String(barHeight));
      bar.setAttribute("rx", "2");
      bar.setAttribute("fill", color);
      bar.setAttribute("opacity", String(0.35 + (index / Math.max(values.length - 1, 1)) * 0.65));
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = formatInteger(amount);
      bar.append(title);
      element.append(bar);
    });
  }

  function renderSummary(snapshot, buckets, selectedModel) {
    const summary = snapshot.summary;
    const requestCount = sumBuckets(buckets, "requests");
    const rateLimited = sumBuckets(buckets, "rateLimited");
    const ratePercent = requestCount ? (rateLimited * 100) / requestCount : 0;
    document.querySelector("#connections").textContent = formatInteger(summary.connections);
    document.querySelector("#active-requests").textContent =
      `${formatInteger(summary.activeRequests)} active requests`;
    document.querySelector("#requests-minute").textContent = formatInteger(
      selectedModel ? selectedModel.requests : summary.requestsPerMinute,
    );
    document.querySelector("#total-requests").textContent =
      `${formatInteger(summary.totalRequests)} since process start`;
    document.querySelector("#tokens-minute").textContent = formatNumber(
      selectedModel
        ? selectedModel.inputTokens + selectedModel.outputTokens
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

  function renderCharts(snapshot, buckets) {
    const requestRate = snapshot.summary.requestsPerMinute;
    const tokenRate = snapshot.summary.tokensPerMinute;
    document.querySelector("#request-chart-value").textContent = `${formatInteger(requestRate)} rpm`;
    document.querySelector("#token-chart-value").textContent = `${formatNumber(tokenRate)} tpm`;
    document.querySelector("#latency-chart-value").textContent =
      `p95 ${formatDuration(snapshot.summary.p95LatencyMs)}`;
    drawBars(
      document.querySelector("#request-chart"),
      buckets,
      (bucket) => Number(bucket.requests || 0),
      "#0E538B",
    );
    drawBars(
      document.querySelector("#token-chart"),
      buckets,
      (bucket) => Number(bucket.inputTokens || 0) + Number(bucket.outputTokens || 0),
      "#00A972",
    );
    drawBars(
      document.querySelector("#latency-chart"),
      buckets,
      (bucket) => Number(bucket.averageLatencyMs || 0),
      "#618794",
    );
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
    const models =
      state.model === "all"
        ? snapshot.models
        : snapshot.models.filter((model) => model.model === state.model);
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
    document.querySelector("#retention-status").textContent =
      `Collecting · process uptime ${formatUptime(snapshot.uptimeSeconds)} · memory ${retained.toFixed(1)} MiB / ${target.toFixed(0)} MiB`;
    document.querySelector("#retention-detail").textContent =
      `${snapshot.retention.detailedResolutionSeconds}s resolution · 1h detail · 24h rollup · process-local`;
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    if (state.paused || state.hidden) {
      return;
    }
    const buckets = selectedBuckets(snapshot);
    const selectedModel =
      state.model === "all"
        ? null
        : snapshot.models.find((model) => model.model === state.model) || null;
    renderSummary(snapshot, buckets, selectedModel);
    renderCharts(snapshot, buckets);
    renderModels(snapshot);
    renderTimeline(snapshot);
    renderFooter(snapshot);
    dashboard.setAttribute("aria-busy", "false");
    notice.textContent = "";
  }

  async function loadSnapshot() {
    const response = await fetch("/metrics/snapshot", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Snapshot request failed with ${response.status}`);
    }
    render(await response.json());
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
      setLiveState(state.paused ? "paused" : "live", state.paused ? "Paused" : "Live");
    });
    source.addEventListener("snapshot", (event) => {
      try {
        render(JSON.parse(event.data));
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
    if (state.snapshot) {
      render(state.snapshot);
    }
  });

  pauseToggle.addEventListener("click", () => {
    state.paused = !state.paused;
    pauseToggle.setAttribute("aria-pressed", String(state.paused));
    pauseToggle.textContent = state.paused ? "Resume live" : "Pause live";
    setLiveState(state.paused ? "paused" : "live", state.paused ? "Paused" : "Live");
    if (!state.paused && state.snapshot) {
      render(state.snapshot);
    }
  });

  detailToggle.addEventListener("click", () => {
    const compact = dashboard.dataset.detail !== "compact";
    dashboard.dataset.detail = compact ? "compact" : "full";
    detailToggle.setAttribute("aria-pressed", String(compact));
    detailToggle.textContent = compact ? "Full detail" : "Compact";
  });

  document.addEventListener("visibilitychange", () => {
    state.hidden = document.hidden;
    if (!state.hidden && state.snapshot && !state.paused) {
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

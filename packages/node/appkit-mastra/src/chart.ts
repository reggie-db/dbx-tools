/**
 * Chart planner + chart cache.
 *
 * Self-contained chart subsystem with two layers:
 *
 *   1. Inner planner agent (private). Pure dataset-in /
 *      `EChartsOption`-out brain. Driven by {@link prepareChart};
 *      callers never instantiate it directly.
 *   2. {@link prepareChart}: orchestration on top of the planner.
 *      Mints a `chartId`, caches an empty `{ chartId }` record
 *      synchronously, then resolves the dataset and runs the
 *      planner in the background. The terminal entry settles with
 *      either `result` (success) or `error` (failure). Both
 *      undefined means the entry is still processing.
 *
 * The cache surface ({@link fetchChart}) is the only state the
 * HTTP route and the chart-producing tools share. `prepareChart`
 * is dataset-agnostic - callers supply a `resolveData` callback
 * that fetches the rows however they like (Genie statement, inline
 * dataset, custom API). The module has no knowledge of Genie or
 * statement ids; those concerns live in the tools that wrap it.
 *
 * Wire-format schemas live in `@dbx-tools/shared-mastra` so
 * the demo client and any other UI consumer share the exact same
 * shape this module reads and writes.
 *
 * @module
 */

import { AppKitError, CacheManager, ExecutionError } from "@databricks/appkit";
import { async, error, hash, json, log, string, type BrandContext } from "@dbx-tools/shared-core";
import { marker, wire, type Chart, type ChartResult } from "@dbx-tools/shared-mastra";
import { model } from "@dbx-tools/shared-model";
import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { resolveUserKey, type MastraPluginConfig } from "./config.ts";
import { buildModel } from "./model.ts";

const logger = log.logger("mastra/chart");

/* ------------------------------ constants ------------------------------ */

/**
 * TTL for cached chart entries. One hour balances "long enough for
 * the host UI to fetch the chart well after the model finished
 * talking" against "short enough that abandoned chart ids don't
 * pin storage". Matches the typical Databricks OBO token lifetime
 * so any data re-resolution stays inside the original auth window.
 */
const CHART_CACHE_TTL_SEC = 60 * 60;

/** Cache namespace; keeps the chart keyspace tidy. */
const CHART_CACHE_NAMESPACE = "mastra:chart";

/** Default server-side long-poll budget for {@link fetchChart}. */
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

/** Default inter-poll sleep for {@link fetchChart}. */
const DEFAULT_FETCH_INTERVAL_MS = 250;

/** Stable text stored on a chart entry whose planner run failed. */
const CHART_FAILED_MESSAGE = "Chart generation failed";

/* ------------------------------- schemas ------------------------------- */

/**
 * One series data point. Wide variant set so the planner agent can
 * faithfully pass through whatever the SQL row set contained
 * (numbers, stringified numbers, nulls for missing measurements,
 * `[x, y]` tuples for scatter, `[x, y, value]` triples for heatmap,
 * `{name, value}` slices for pie / funnel / treemap) without the
 * structured-output guard rejecting the whole plan.
 *
 * Three layers of tolerance:
 *
 *   1. {@link z.preprocess} normalizes wire shapes BEFORE union
 *      dispatch: stringified numbers parse to numbers, finite
 *      checks reject `NaN` / `Infinity`, 2-/3-element arrays coerce
 *      tuple components, and `{value}` objects with missing /
 *      stringified `value` get coerced or rejected uniformly.
 *      Anything not handleable becomes `null`.
 *   2. The union accepts `null` as a first-class variant. Echarts
 *      renders null as a gap on bar / line / area (which is the
 *      right visual signal for "missing reading"). Scatter, heatmap,
 *      and slice charts filter nulls in {@link planToEchartsOption}
 *      because Echarts crashes on null tuples / slices.
 *   3. {@link z.union#catch} backstops the whole thing: if
 *      preprocess somehow produces a shape that still doesn't
 *      match any variant, the bad item becomes `null` instead of
 *      taking down the entire chart with a
 *      `Structured output validation failed` error.
 */
const chartDataPointSchema = z
  .preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      if (typeof v === "string") {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }
      // Scatter `[x, y]` or heatmap `[xIndex, yIndex, value]`. Coerce
      // stringified components; reject if any component is non-finite.
      if (Array.isArray(v) && (v.length === 2 || v.length === 3)) {
        const nums = v.map((c) => (typeof c === "number" ? c : Number(c)));
        return nums.every((n) => Number.isFinite(n)) ? nums : null;
      }
      if (typeof v === "object" && v !== null && "value" in v) {
        const obj = v as { name?: unknown; value: unknown };
        const val = typeof obj.value === "number" ? obj.value : Number(obj.value);
        if (!Number.isFinite(val)) return null;
        // Coerce numeric / boolean / nullish names to strings so a
        // pie slice keyed on a year (`2024`) or category id is
        // accepted without round-tripping through the catch arm.
        const rawName = obj.name;
        const name = typeof rawName === "string" ? rawName : rawName == null ? "" : String(rawName);
        return { name, value: val };
      }
      return null;
    },
    z.union([
      z.number(),
      z.null(),
      // `[x, y]` scatter or `[x, y, value]` heatmap cell. Modelled as a
      // length-constrained homogeneous array rather than `z.tuple`:
      // Zod emits a tuple as JSON Schema 2020-12 `prefixItems`, and
      // Databricks' Gemini endpoints reject a `response_json_schema`
      // containing it ("must be a boolean or an object", since
      // `items` is absent). `minItems` / `maxItems` + `items` is what
      // every provider understands.
      z.array(z.number()).min(2).max(3),
      z.object({ name: z.string(), value: z.number() }),
    ]),
  )
  .catch(null);

/** Per-series mark type used by `combo` charts (bar + line overlay). */
const seriesMarkTypeSchema = z
  .union([z.literal("bar"), z.literal("line"), z.literal("area")])
  .describe(
    "Mark type for this series. Required for `combo` (mix bar and line/area); ignored for other chart types.",
  );

/**
 * Compact, model-friendly representation of an Echarts spec. The
 * planner agent emits this; {@link planToEchartsOption} expands it
 * into a real `EChartsOption` JSON. Two layers because letting the
 * model fill in a fully-typed `EChartsOption` is brittle (hundreds
 * of optional fields, deep unions, version-dependent shapes). A
 * small "chart plan" schema is much more reliable for a fast model
 * and keeps animation / tooltip / styling defaults consistent
 * across charts.
 */
export const chartPlanSchema = z.object({
  chartType: wire.ChartTypeSchema,
  title: z
    .string()
    .optional()
    .describe(
      string.toDescription(`
        Short title shown above the chart. Optional; defaults to the
        \`title\` argument the caller passed in.
      `),
    ),
  xAxisLabel: z
    .string()
    .optional()
    .describe(
      string.toDescription(`
        Axis label for the primary (usually bottom / value) axis.
        Used for bar / horizontalBar / line / area / combo / waterfall
        / scatter / heatmap; ignored for pie / funnel / treemap / radar.
      `),
    ),
  yAxisLabel: z
    .string()
    .optional()
    .describe(
      string.toDescription(`
        Axis label for the secondary (usually left) axis. Used for
        bar / horizontalBar / line / area / combo / waterfall /
        scatter / heatmap; ignored for pie / funnel / treemap / radar.
      `),
    ),
  categories: z
    .array(z.string())
    .optional()
    .describe(
      string.toDescription(`
        Primary category labels. For \`bar\` / \`horizontalBar\` /
        \`line\` / \`area\` / \`combo\` / \`waterfall\`: one label per
        data point. For \`heatmap\`: x-axis categories. For \`radar\`:
        indicator names. Omit for \`scatter\` (\`[x, y]\` tuples) and
        slice charts (\`pie\` / \`funnel\` / \`treemap\`, each slice
        carries its own \`name\`).
      `),
    ),
  yCategories: z
    .array(z.string())
    .optional()
    .describe(
      string.toDescription(`
        Y-axis (row) labels for \`heatmap\`. Optional - when omitted the
        row labels come from the series names, which is the preferred
        way to build a heatmap. Omit for every other chart type.
      `),
    ),
  series: z
    .array(
      z.object({
        name: z.string().describe(
          string.toDescription(`
            Legend name for this series.
          `),
        ),
        type: seriesMarkTypeSchema.optional(),
        yAxisIndex: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe(
            "Which y-axis to bind (0 = left, 1 = right). Use on `combo` when series have different units or scales.",
          ),
        data: z.array(chartDataPointSchema).describe(
          string.toDescription(`
            Data points. For category charts (\`bar\` / \`horizontalBar\`
            / \`line\` / \`area\` / \`combo\` / \`waterfall\` / \`radar\`),
            an array of numbers aligned to \`categories\`; for
            \`waterfall\` those numbers are signed deltas (one series
            only - never a cumulative base series). For \`heatmap\`,
            one series per matrix row, holding that row's numbers
            aligned to \`categories\`. For \`scatter\`, an array of
            \`[x, y]\` numeric tuples. For \`pie\` / \`funnel\` /
            \`treemap\`, an array of \`{name, value}\` objects.
          `),
        ),
      }),
    )
    .default([])
    .describe(
      string.toDescription(`
        One or more series to plot. Required for every chart type
        except \`custom\`, which carries its series inside \`option\`.
        Slice charts (\`pie\` / \`funnel\` / \`treemap\`) and
        \`waterfall\` / \`heatmap\` use exactly one series; \`bar\` /
        \`line\` / \`area\` / \`combo\` / \`radar\` / \`scatter\` can
        carry multiple series.
      `),
    ),
  option: z
    .string()
    .optional()
    .describe(
      string.toDescription(`
        Required for \`custom\`, ignored for every other chart type. A
        COMPLETE Echarts option, as a JSON object encoded in a string:
        \`series\` (each with its own \`type\` and that series' own data
        shape) plus whatever else the chart needs - a coordinate system,
        \`visualMap\`, axes. Plain JSON values only, never a JavaScript
        function. A centered title is filled in when the object omits
        one.
      `),
    ),
});

type ChartPlan = z.infer<typeof chartPlanSchema>;

/**
 * Canonical planner input shape. Tools that source rows from an
 * inline dataset (`render_data`) use it as their `inputSchema`
 * verbatim; tools that resolve rows from a remote (`prepare_chart`
 * over a Genie statement) `omit({ data })` and `extend` with their
 * own identifier field, so the field-level `.describe()` text
 * stays a single source of truth. Server-only - the UI never
 * sees a planner request, only the resolved {@link Chart}.
 */
export const chartPlannerRequestSchema = z.object({
  title: z.string().describe(
    string.toDescription(`
        Concise title shown above the chart (e.g. "Top 10 SKUs by Revenue").
      `),
  ),
  description: z
    .string()
    .optional()
    .describe(
      string.toDescription(`
        One-line intent the chart-planner uses when picking a chart type
        and axis encodings (e.g. "compare quarterly revenue across
        regions", "highlight the steep drop after position 5"). Not shown
        to the user.
      `),
    ),
  data: z
    .array(z.record(z.string(), z.unknown()))
    .nonempty("Data must contain at least one row")
    .readonly()
    .describe(
      string.toDescription(`
        Tabular dataset to chart. One object per row, keyed by column
        name. Values may be strings, numbers, booleans, or null. The
        chart-planner decides which columns are categories vs. numeric
        series. Cap at a few hundred rows for legibility; sample /
        aggregate larger datasets first.
      `),
    ),
});

export type ChartPlannerRequest = z.infer<typeof chartPlannerRequestSchema>;

/**
 * Agent-facing result of either chart-producing tool.
 *
 * `marker` is deliberately redundant with `chartId`: the host still keys the
 * cache by id, while the model gets the exact opaque token to copy into prose
 * and has no reason to invent or retype a UUID.
 */
export const chartToolOutputSchema = wire.ChartSchema.pick({ chartId: true }).extend({
  marker: z
    .string()
    .describe(
      "Exact embed marker. Copy this complete value verbatim onto its own line; never construct a marker from chartId.",
    ),
});

/** Result returned synchronously while chart planning continues in the background. */
export type ChartToolOutput = z.infer<typeof chartToolOutputSchema>;

/* --------------------------- planner instructions --------------------------- */

/**
 * Format {@link wire.ChartTypeSchema}'s variants as a single
 * human-friendly string of `` `<value>` for <description> ``
 * clauses joined by semicolons, drawn from each variant's own
 * `.describe()` so the planner prompt stays in lock-step with
 * the schema by construction.
 */
function formatChartTypePicker(): string {
  return wire.ChartTypeSchema.options
    .map((opt) => `\`${opt.value}\` for ${opt.description ?? ""}`)
    .join("; ");
}

/**
 * System prompt for the inner chart-planning agent. Tuned for a
 * fast-tier model (Haiku, GPT-5-mini, Gemini Flash Lite).
 */
const CHART_PLANNER_INSTRUCTIONS = string.toDescription(`
  You design Apache Echarts visualizations. The user gives you a
  tabular dataset (rows of objects) plus a title and an optional
  description of the intent. You produce a small chart plan (chart
  type, axis labels, categories, series) that best conveys the data.

  Decision guide. Pick the chart type whose data shape matches the
  dataset and the user's intent: ${formatChartTypePicker()}.

  When in doubt between bar and line, prefer bar for unordered
  categories and line for ordered ones (dates, time buckets, ranks).
  Prefer \`horizontalBar\` when category labels are long. Prefer
  \`combo\` when one measure is a count/volume and another is a
  rate/trend. Prefer \`waterfall\` for bridges of signed deltas.
  Prefer \`scatter\` when correlating two numeric fields (no
  category axis). Prefer \`heatmap\` for a category x category
  matrix. Prefer \`radar\` for scoring the same entities across a
  fixed set of dimensions. Never pick pie for more than 7 slices
  (use \`treemap\` instead). Prefer \`funnel\` for ordered conversion
  stages.

  For bar / horizontalBar / line / area / combo / waterfall: pick one
  column as the category axis (usually the only string-valued column)
  and one or more numeric columns as series. Sort categories by the
  primary series value descending unless the data is naturally ordered
  (dates, ranks, funnel stages, waterfall steps). For \`combo\`, set
  each series' \`type\` to \`bar\`, \`line\`, or \`area\`, and use
  \`yAxisIndex: 1\` when a series needs a second scale.

  For waterfall, emit exactly ONE series holding the signed step values
  (deltas), one per category, in order - positive for a rise, negative
  for a drop. Do NOT add a cumulative / running-total / base series and
  do NOT convert the deltas into running totals yourself; the running
  total is computed for you, and a hand-built base series renders as a
  plain bar chart instead of a bridge.

  For pie / funnel / treemap: pick the category column for slice names
  and one numeric column for slice values. Emit a single series of
  \`{name, value}\` objects.

  For scatter: pick two numeric columns and emit \`[x, y]\` tuples in
  one or more series (one series per group if a grouping column exists).

  For heatmap: pick two category columns and one numeric measure. Put
  the x-axis categories in \`categories\`, then emit ONE SERIES PER ROW
  of the matrix - the series \`name\` is the row label and \`data\` is
  the row's numbers, one per entry in \`categories\`, in the same order.
  Do not compute cell indices.

  For radar: \`categories\` are the indicator names; each series is an
  array of numbers (one value per indicator).

  For anything the types above cannot express - a sankey, boxplot,
  candlestick, sunburst, gauge, network graph, calendar, parallel-
  coordinates plot, or any other Echarts series - use \`custom\` and
  hand-write the whole Echarts option into \`option\` as a JSON string.
  Include every part that chart needs: the series with their own
  \`type\` and data shape, plus any coordinate system, \`visualMap\`,
  or axes. Leave \`series\`, \`categories\`, and the axis labels out;
  they are ignored for \`custom\`. Prefer a listed type whenever one
  genuinely fits - \`custom\` gives up the shared tooltip, legend, and
  grid defaults, so it is the answer for an unsupported chart shape,
  not a way to restyle a supported one.

  Keep series names human-readable (use the column name; title case it
  lightly if needed). Keep titles concise; do not repeat the user's
  title in xAxisLabel / yAxisLabel.
`);

/* ----------------------------- planner agent ----------------------------- */

/**
 * One planner `Agent` per plugin config. Cached on config object
 * identity so callers can `prepareChart({ config, ... })` from a
 * hot path without paying the Agent-constructor cost every call.
 * `WeakMap` lets retired configs (e.g. test reconfigurations)
 * release their agent without manual eviction.
 */
const plannerAgents = new WeakMap<MastraPluginConfig, Agent>();

function getPlannerAgent(config: MastraPluginConfig): Agent {
  let agent = plannerAgents.get(config);
  if (!agent) {
    agent = new Agent({
      id: "chart_planner",
      name: "Chart Planner",
      description: "Picks chart type and axis encodings for a dataset.",
      instructions: CHART_PLANNER_INSTRUCTIONS,
      model: ({ requestContext }) =>
        buildModel(config, requestContext, { modelClass: model.ModelClass.ChatFast }),
    });
    plannerAgents.set(config, agent);
  }
  return agent;
}

/**
 * Run the planner against `request` and return the resolved
 * Echarts spec. Throws on planner failure - {@link prepareChart}
 * catches and stashes the error in the cache entry.
 */
async function runChartPlanner(
  config: MastraPluginConfig,
  request: ChartPlannerRequest,
  options: { requestContext?: RequestContext; abortSignal?: AbortSignal } = {},
): Promise<ChartResult> {
  const { title, description, data } = request;
  const { requestContext, abortSignal } = options;
  const prompt = string.toDescription({
    Title: title,
    ...(description ? { Description: description } : {}),
    "Dataset (JSON, one row per object)": JSON.stringify(data, null, 2),
  });
  const result = await getPlannerAgent(config).generate(prompt, {
    structuredOutput: { schema: chartPlanSchema },
    ...(requestContext ? { requestContext } : {}),
    ...(abortSignal ? { abortSignal } : {}),
  });
  const plan = chartPlanSchema.parse(result.object);
  const option = planToEchartsOption(plan, title, config.brand);
  return { chartType: plan.chartType, option };
}

/* ------------------------------ cache helpers ------------------------------ */

/**
 * Build the canonical cache key for a `chartId` owned by `userKey`.
 *
 * The identity is part of the key, not a filter applied after the read, so a
 * chart id guessed or copied from another user's transcript resolves to a
 * different key and simply misses. That miss is what the HTTP route turns into
 * a 404, which is also the answer that leaks the least.
 */
async function chartCacheKey(chartId: string, userKey: string): Promise<string> {
  return (await CacheManager.getInstance()).generateKey([CHART_CACHE_NAMESPACE, chartId], userKey);
}

/**
 * Persist a {@link Chart} entry under its `chartId`, owned by `userKey`.
 * Refreshes the TTL on every write. Cache-layer failures are logged and
 * swallowed so background runners never throw into the
 * unhandled-rejection stream.
 */
async function writeChart(entry: Chart, userKey: string): Promise<void> {
  try {
    const key = await chartCacheKey(entry.chartId, userKey);
    await CacheManager.getInstanceSync().set(key, entry, {
      ttl: CHART_CACHE_TTL_SEC,
    });
  } catch (err) {
    logger.warn("write-error", {
      chartId: entry.chartId,
      error: error.errorMessage(err),
    });
  }
}

/**
 * Look up a chart `userKey` owns. Returns `undefined` on miss, on
 * expiry, when another identity owns the id, or when the cache layer is
 * unhealthy - never throws.
 */
async function readChart(chartId: string, userKey: string): Promise<Chart | undefined> {
  try {
    const key = await chartCacheKey(chartId, userKey);
    const v = await CacheManager.getInstanceSync().get<Chart>(key);
    return v ?? undefined;
  } catch (err) {
    logger.warn("read-error", {
      chartId,
      error: error.errorMessage(err),
    });
    return undefined;
  }
}

/* --------------------------- prepareChart orchestrator --------------------------- */

/** Inputs to {@link prepareChart}. */
export interface PrepareChartOptions {
  /** Plugin config; resolves the planner agent's model. */
  config: MastraPluginConfig;
  /**
   * Identity that owns the minted chart. Only a {@link fetchChart} call
   * carrying the same key resolves it. Use {@link resolveUserKey}.
   */
  userKey: string;
  /** Display title forwarded to the planner agent. */
  title?: string;
  /** Optional intent hint forwarded to the planner agent. */
  description?: string;
  /**
   * Resolves the rows to chart. Called once, in the background.
   * Any thrown error lands in the cache as the entry's `error`
   * field (never propagated to the caller of {@link prepareChart}).
   * An empty `rows` array is rejected as `"dataset has no rows;
   * nothing to chart"`.
   */
  resolveData: (signal?: AbortSignal) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
  /**
   * Per-request `RequestContext`. Forwarded to the planner agent so
   * user-scoped model resolution (OBO) stays in effect.
   */
  requestContext?: RequestContext;
  /**
   * Cooperative cancellation. Forwarded to `resolveData` and the
   * planner agent. Note: the chart task continues running in the
   * background after the parent request ends, so external abort
   * signals are best-effort; typical use is to leave this unset
   * and let the 1h TTL cap stale entries.
   */
  signal?: AbortSignal;
}

/**
 * Mint a `chartId`, cache an empty `{ chartId }` placeholder
 * synchronously, and kick off a background task that resolves the
 * dataset and runs the planner. Returns the `chartId` once the
 * placeholder lands so the first {@link fetchChart} call always
 * sees an entry (no spurious 404 race).
 *
 * The background task swallows its own failures and writes them
 * as `error` entries, so callers never see a rejected promise.
 * Cache state machine:
 *
 *   - just after this call returns: `{ chartId }` (processing)
 *   - on planner success:           `{ chartId, result }`
 *   - on data / planner failure:    `{ chartId, error }`
 */
export async function prepareChart(opts: PrepareChartOptions): Promise<ChartToolOutput> {
  const chartId = hash.id();
  await writeChart({ chartId }, opts.userKey);
  logger.debug("queued", { chartId });
  // Fire-and-forget. Failures land in the cache as `error` entries;
  // never escape into an unhandled rejection.
  void runPrepareChart(chartId, opts);
  return { chartId, marker: marker.formatMarker("chart", chartId) };
}

async function runPrepareChart(chartId: string, opts: PrepareChartOptions): Promise<void> {
  const startedAt = Date.now();
  try {
    const data = await opts.resolveData(opts.signal);
    if (data.rows.length === 0) {
      throw new ExecutionError("Dataset has no rows; nothing to chart");
    }
    const result = await runChartPlanner(
      opts.config,
      {
        title: opts.title ?? "Chart",
        ...(opts.description ? { description: opts.description } : {}),
        data: data.rows as ChartPlannerRequest["data"],
      },
      {
        ...(opts.requestContext ? { requestContext: opts.requestContext } : {}),
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
      },
    );
    await writeChart({ chartId, result }, opts.userKey);
    logger.info("done", {
      chartId,
      chartType: result.chartType,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    logger.warn("error", { chartId, error: error.errorMessage(err) });
    // The entry's `error` is rendered in the chat, so only an AppKitError's
    // own message travels; anything else could carry upstream provider detail.
    const errText = err instanceof AppKitError ? err.message : CHART_FAILED_MESSAGE;
    await writeChart({ chartId, error: errText }, opts.userKey);
  }
}

/* ------------------------------- long-poll fetch ------------------------------- */

/** Inputs to {@link fetchChart}. */
export interface FetchChartOptions {
  /**
   * Identity the chart must belong to. A chart minted under a different key
   * is indistinguishable from an unknown id. Use {@link resolveUserKey}.
   */
  userKey: string;
  /**
   * Server-side polling budget in ms. When the entry stays in
   * the processing state past this window, the helper returns the
   * last seen value (still processing) so the client can re-poll.
   * Defaults to {@link DEFAULT_FETCH_TIMEOUT_MS} (60s).
   */
  timeoutMs?: number;
  /**
   * Poll interval in ms. Defaults to
   * {@link DEFAULT_FETCH_INTERVAL_MS} (250ms).
   */
  intervalMs?: number;
  /** External cancellation handle (e.g. request `req.signal`). */
  signal?: AbortSignal;
}

/**
 * Long-poll the chart cache until the entry settles (`result` or
 * `error` set), the entry is missing, or the server-side timeout
 * elapses.
 *
 * Returns:
 *   - the resolved {@link Chart} when it settled, errored, or
 *     stayed in processing past `timeoutMs` (so the client can
 *     re-poll);
 *   - `undefined` when the entry is missing, expired, or owned by
 *     another identity (the consumer should treat as 404).
 *
 * `signal` lets the caller cancel ahead of timeout (e.g. the HTTP
 * request closed). Cancellation propagates to the inter-poll sleep
 * so the helper returns immediately.
 */
export async function fetchChart(
  chartId: string,
  options: FetchChartOptions,
): Promise<Chart | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_FETCH_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  let last: Chart | undefined;
  while (true) {
    options.signal?.throwIfAborted();
    last = await readChart(chartId, options.userKey);
    if (!last) return undefined;
    if (last.result !== undefined || last.error !== undefined) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return last;
    await async.sleep(Math.min(intervalMs, remaining), options.signal);
  }
}

/* ----------------------------- echarts theme ----------------------------- */

/**
 * The slice of an Echarts option that carries brand identity: the series
 * color cycle and the base font stack. Derived from a {@link BrandContext}
 * by {@link brandChartTheme} and merged into every spec by
 * {@link planToEchartsOption}.
 *
 * Deliberately carries no text COLOR. A spec is planned here, on the
 * server, and read later in a browser whose light/dark theme this code
 * cannot know; baking in the brand's single (light) foreground produced
 * near-black labels that disappeared against a dark chat surface. The
 * renderer resolves chrome colors from AppKit's live CSS tokens instead
 * (`@dbx-tools/ui-mastra`'s `chart-theme` + `normalizeChartOption`),
 * leaving this theme the parts that read the same in either mode.
 */
interface ChartTheme {
  color: string[];
  textStyle: { fontFamily: string };
}

/**
 * AppKit's categorical chart palette (`--chart-cat-1` .. `--chart-cat-8` from
 * `@databricks/appkit-ui`), as hex. Server-rendered chart specs cannot read the
 * browser's CSS custom properties, so the values are mirrored here to keep a
 * generated chart visually consistent with the AppKit-styled UI around it.
 * Keep in sync with AppKit's stylesheet if it changes.
 */
const APPKIT_CHART_PALETTE = [
  "#2463EB", // blue
  "#2EB88A", // teal
  "#AB47BD", // purple
  "#F69E23", // amber
  "#DD2C4D", // rose
  "#1BA3BB", // cyan
  "#9B61D1", // lavender
  "#34B262", // emerald
] as const;

/**
 * Expand two brand hex colors into a legible categorical cycle. Echarts
 * repeats the `color` array across series / categories, so a good default
 * needs several distinct hues, not two. We seed with the brand primary and
 * accent (the identity colors) and follow with AppKit's own categorical chart
 * palette, so multi-series / many-slice charts stay readable and match the
 * surrounding AppKit UI while the first one or two marks land on-brand.
 */
function brandColorCycle(primary: string, accent: string): string[] {
  const spread = APPKIT_CHART_PALETTE;
  const seen = new Set<string>();
  return [primary, accent, ...spread].filter((c) => {
    const key = c.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Derive an Echarts {@link ChartTheme} from a brand context: the primary +
 * accent colors seed the series cycle and the sans stack becomes the base
 * font. Text colors are the renderer's job - see {@link ChartTheme}.
 */
function brandChartTheme(brand: BrandContext): ChartTheme {
  return {
    color: brandColorCycle(brand.colors.primary, brand.colors.accent),
    textStyle: { fontFamily: brand.typography.sans },
  };
}

/* ----------------------------- echarts expansion ----------------------------- */

type NamedSlice = { name: string; value: number };
type ScatterPoint = [number, number];
type HeatmapCell = [number, number, number];

/** Keep only `{name, value}` slices; drop nulls / bare numbers / tuples. */
function namedSlices(data: ChartPlan["series"][number]["data"]): NamedSlice[] {
  return data.filter(
    (d): d is NamedSlice => d !== null && typeof d === "object" && !Array.isArray(d),
  );
}

/** Keep only finite numbers (category / radar / waterfall series). */
function numericPoints(data: ChartPlan["series"][number]["data"]): number[] {
  return data.filter((d): d is number => typeof d === "number" && Number.isFinite(d));
}

/** Keep only `[x, y]` scatter tuples. */
function scatterPoints(data: ChartPlan["series"][number]["data"]): ScatterPoint[] {
  return data.filter(
    (d): d is ScatterPoint => Array.isArray(d) && d.length === 2,
  ) as ScatterPoint[];
}

/** Keep only `[xIndex, yIndex, value]` heatmap cells. */
function heatmapCells(data: ChartPlan["series"][number]["data"]): HeatmapCell[] {
  return data.filter((d): d is HeatmapCell => Array.isArray(d) && d.length === 3) as HeatmapCell[];
}

/**
 * Resolve a heatmap's cells and row labels from either shape the
 * planner may produce.
 *
 * The documented shape is ONE series of `[xIndex, yIndex, value]`
 * triples, but index arithmetic is exactly the kind of bookkeeping a
 * fast model gets wrong, and the failure is silent (every cell is
 * dropped and the grid renders empty). So the row-per-series shape it
 * already produces reliably for bar charts - one series per matrix
 * row, numbers aligned to `categories` - is accepted too and turned
 * into triples here.
 *
 * Row order reads top-to-bottom: Echarts' category y-axis counts index
 * 0 from the BOTTOM, so a row-derived matrix reverses both the axis
 * labels and the row indices, putting the first series at the top the
 * way the model listed it.
 */
function heatmapMatrix(plan: ChartPlan): { cells: HeatmapCell[]; yCategories: string[] } {
  const triples = heatmapCells(plan.series[0]?.data ?? []);
  if (triples.length > 0) {
    return { cells: triples, yCategories: plan.yCategories ?? [] };
  }
  const rows = plan.series.map((s) => ({ name: s.name, values: numericPoints(s.data) }));
  const labels = plan.yCategories ?? rows.map((r) => r.name);
  const lastRow = rows.length - 1;
  return {
    cells: rows.flatMap((row, rowIndex) =>
      row.values.map((value, columnIndex): HeatmapCell => [columnIndex, lastRow - rowIndex, value]),
    ),
    yCategories: [...labels].reverse(),
  };
}

/** Sequential light-to-brand ramp for heatmap intensity. */
const HEATMAP_RAMP = ["#EAF1FE", "#9CBDF7", "#4C86EE", "#2463EB", "#14387F"];

/** Above this many cells, printed values overlap and are suppressed. */
const HEATMAP_LABEL_MAX_CELLS = 60;

/** Rising step fill (emerald) and falling step fill (rose). */
const WATERFALL_INCREASE_COLOR = "#2EB88A";
const WATERFALL_DECREASE_COLOR = "#DD2C4D";

/** Series names the waterfall expansion emits. */
const WATERFALL_HELPER_NAME = "Running total";
const WATERFALL_INCREASE_NAME = "Increase";
const WATERFALL_DECREASE_NAME = "Decrease";

/**
 * A model asked for a bridge often builds the running total itself and
 * hands back a cumulative-base series alongside the deltas - which
 * renders as two plain bar series, not a waterfall (the base bars are
 * the tall ones). The base is recognizable by name, so it is dropped
 * here and the running total recomputed from the deltas.
 */
const WATERFALL_BASE_NAME = /\b(base|cumulative|running|helper|total|start(ing)?)\b/i;

/**
 * Pick the signed-delta series out of a waterfall plan, ignoring any
 * cumulative-base series the planner built by hand
 * ({@link WATERFALL_BASE_NAME}). Falls back to the first series when
 * every name looks like a base, since dropping them all would leave
 * nothing to plot.
 */
function waterfallDeltaSeries(
  series: ChartPlan["series"],
): ChartPlan["series"][number] | undefined {
  return series.find((s) => !WATERFALL_BASE_NAME.test(s.name)) ?? series[0];
}

/**
 * Build the stacked transparent-base + increase + decrease series that
 * Echarts uses for a waterfall (it has no native waterfall type).
 * Values are signed deltas; the transparent helper carries the running
 * total so each visible bar starts where the previous one ended.
 *
 * The helper is `silent`, so with an item-triggered tooltip it is
 * invisible to both the eye and the pointer - the alternative, an axis
 * tooltip that hides the helper row, needs a function formatter, and
 * this spec has to survive JSON serialization to the browser.
 */
function waterfallSeries(values: number[]): Array<Record<string, unknown>> {
  const helpers: number[] = [];
  const increases: Array<number | "-"> = [];
  const decreases: Array<number | "-"> = [];
  let cumulative = 0;
  for (const value of values) {
    if (value >= 0) {
      helpers.push(cumulative);
      increases.push(value);
      decreases.push("-");
    } else {
      helpers.push(cumulative + value);
      increases.push("-");
      decreases.push(-value);
    }
    cumulative += value;
  }
  const transparent = { borderColor: "transparent", color: "transparent" };
  return [
    {
      name: WATERFALL_HELPER_NAME,
      type: "bar",
      stack: "total",
      silent: true,
      itemStyle: transparent,
      emphasis: { itemStyle: transparent },
      data: helpers,
    },
    {
      name: WATERFALL_INCREASE_NAME,
      type: "bar",
      stack: "total",
      itemStyle: { color: WATERFALL_INCREASE_COLOR },
      data: increases,
    },
    {
      name: WATERFALL_DECREASE_NAME,
      type: "bar",
      stack: "total",
      itemStyle: { color: WATERFALL_DECREASE_COLOR },
      data: decreases,
    },
  ];
}

/**
 * Expand a {@link ChartPlan} into a full Echarts `EChartsOption`
 * JSON. Centralized here so the planner agent only fills in the
 * compact plan shape; tooltip / animation / color / grid defaults
 * stay consistent across charts and are easy to tune without
 * retraining model behaviour.
 *
 * When `brand` is set, the resolved spec is themed with the brand's series
 * color cycle and base text style (see {@link brandChartTheme}); otherwise
 * Echarts' defaults apply.
 */
export function planToEchartsOption(
  plan: ChartPlan,
  fallbackTitle: string,
  brand?: BrandContext,
): Record<string, unknown> {
  const baseTitle = plan.title ?? fallbackTitle;
  const grid = { left: 48, right: 24, top: 56, bottom: 48, containLabel: true };
  const theme = brand ? brandChartTheme(brand) : undefined;
  const themed = (option: Record<string, unknown>): Record<string, unknown> =>
    theme ? { ...theme, ...option } : option;
  const title = { text: baseTitle, left: "center" };
  const legend = { bottom: 0 };

  if (plan.chartType === "custom") {
    // The option arrives as a JSON STRING, not a nested object: this plan is
    // the planner's provider-enforced structured output, and a free-form
    // object becomes an unconstrained `additionalProperties` schema that
    // strict OpenAI and Gemini endpoints reject - which would break EVERY
    // chart, not just this one (same class of hazard as the `prefixItems`
    // note on `chartDataPointSchema`). A malformed string costs one chart.
    // Nothing here is eval'd; a string-valued Echarts formatter is a
    // template, not code.
    const option = json.parseRecord(plan.option);
    if (!option) {
      throw new Error('chartType "custom" needs an `option` holding a JSON object');
    }
    // Title is the one default worth filling: every other branch guarantees
    // one and the renderer reserves grid space for it. A title the model set
    // wins, as does every other field it declared.
    return themed({ title, ...option });
  }

  if (plan.chartType === "pie" || plan.chartType === "funnel" || plan.chartType === "treemap") {
    const slices = namedSlices(plan.series[0]?.data ?? []);
    const seriesType = plan.chartType;
    return themed({
      title,
      tooltip: { trigger: "item" },
      legend: seriesType === "treemap" ? undefined : legend,
      series: [
        {
          name: plan.series[0]?.name ?? baseTitle,
          type: seriesType,
          ...(seriesType === "pie" ? { radius: ["35%", "65%"] } : {}),
          ...(seriesType === "funnel" ? { sort: "descending" } : {}),
          data: slices,
        },
      ],
    });
  }

  if (plan.chartType === "scatter") {
    // Echarts crashes on null scatter points - keep only valid
    // `[x, y]` tuples. Bare numbers / objects / nulls from a
    // mismatched plan get dropped silently.
    return themed({
      title,
      tooltip: { trigger: "item" },
      legend,
      grid,
      xAxis: { type: "value", name: plan.xAxisLabel },
      yAxis: { type: "value", name: plan.yAxisLabel },
      series: plan.series.map((s) => ({
        name: s.name,
        type: "scatter",
        data: scatterPoints(s.data),
      })),
    });
  }

  if (plan.chartType === "heatmap") {
    const { cells, yCategories } = heatmapMatrix(plan);
    const values = cells.map((c) => c[2]);
    const min = values.length > 0 ? Math.min(...values) : 0;
    const max = values.length > 0 ? Math.max(...values) : 1;
    return themed({
      title,
      tooltip: { position: "top" },
      // The visualMap ramp sits below the plot, so the grid gives up
      // more bottom room than an axis-only chart needs.
      grid: { ...grid, bottom: 72 },
      xAxis: {
        type: "category",
        data: plan.categories ?? [],
        name: plan.xAxisLabel,
        splitArea: { show: true },
      },
      yAxis: {
        type: "category",
        data: yCategories,
        name: plan.yAxisLabel,
        splitArea: { show: true },
      },
      visualMap: {
        // Echarts hides every cell when min === max (a uniform matrix),
        // so a degenerate range is widened by one.
        min,
        max: max > min ? max : min + 1,
        calculable: true,
        orient: "horizontal",
        left: "center",
        bottom: 8,
        inRange: { color: HEATMAP_RAMP },
      },
      series: [
        {
          name: plan.series[0]?.name ?? baseTitle,
          type: "heatmap",
          data: cells,
          // Printed cell values are unreadable once the grid is dense.
          label: { show: cells.length <= HEATMAP_LABEL_MAX_CELLS },
          emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0, 0, 0, 0.3)" } },
        },
      ],
    });
  }

  if (plan.chartType === "radar") {
    const indicators = (plan.categories ?? []).map((name, index) => {
      const peak = Math.max(
        0,
        ...plan.series.map((s) => {
          const nums = numericPoints(s.data);
          return nums[index] ?? 0;
        }),
      );
      return { name, max: peak > 0 ? peak : 1 };
    });
    return themed({
      title,
      tooltip: { trigger: "item" },
      legend,
      radar: { indicator: indicators },
      series: [
        {
          type: "radar",
          data: plan.series.map((s) => ({
            name: s.name,
            value: numericPoints(s.data),
          })),
        },
      ],
    });
  }

  if (plan.chartType === "waterfall") {
    const values = numericPoints(waterfallDeltaSeries(plan.series)?.data ?? []);
    return themed({
      title,
      // Item-triggered so the transparent `silent` offset bars never
      // surface in a tooltip (see `waterfallSeries`).
      tooltip: { trigger: "item" },
      // Only the two visible steps belong in the legend.
      legend: { ...legend, data: [WATERFALL_INCREASE_NAME, WATERFALL_DECREASE_NAME] },
      grid,
      xAxis: {
        type: "category",
        data: plan.categories ?? [],
        name: plan.xAxisLabel,
      },
      yAxis: { type: "value", name: plan.yAxisLabel },
      series: waterfallSeries(values),
    });
  }

  if (plan.chartType === "horizontalBar") {
    return themed({
      title,
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend,
      grid,
      xAxis: { type: "value", name: plan.xAxisLabel },
      yAxis: {
        type: "category",
        data: plan.categories ?? [],
        name: plan.yAxisLabel,
      },
      series: plan.series.map((s) => ({
        name: s.name,
        type: "bar",
        data: s.data,
      })),
    });
  }

  if (plan.chartType === "combo") {
    const usesRightAxis = plan.series.some((s) => s.yAxisIndex === 1);
    return themed({
      title,
      tooltip: { trigger: "axis" },
      legend,
      grid,
      xAxis: {
        type: "category",
        data: plan.categories ?? [],
        name: plan.xAxisLabel,
      },
      yAxis: usesRightAxis
        ? [
            { type: "value", name: plan.yAxisLabel },
            { type: "value", name: undefined },
          ]
        : { type: "value", name: plan.yAxisLabel },
      series: plan.series.map((s) => {
        const mark = s.type ?? "bar";
        const seriesType = mark === "area" ? "line" : mark;
        return {
          name: s.name,
          type: seriesType,
          data: s.data,
          yAxisIndex: s.yAxisIndex ?? 0,
          smooth: seriesType === "line",
          ...(mark === "area" ? { areaStyle: {} } : {}),
        };
      }),
    });
  }

  // bar / line / area share the same axis layout.
  const isArea = plan.chartType === "area";
  const seriesType = plan.chartType === "bar" ? "bar" : "line";
  return themed({
    title,
    tooltip: { trigger: "axis" },
    legend,
    grid,
    xAxis: {
      type: "category",
      data: plan.categories ?? [],
      name: plan.xAxisLabel,
    },
    yAxis: { type: "value", name: plan.yAxisLabel },
    series: plan.series.map((s) => ({
      name: s.name,
      type: seriesType,
      data: s.data,
      smooth: seriesType === "line",
      ...(isArea ? { areaStyle: {} } : {}),
    })),
  });
}

/* ----------------------------- render_data tool ----------------------------- */

/**
 * Build the `render_data` Mastra tool bound to the given plugin
 * config. Auto-wired as a system tool on every agent (see
 * `agents.ts`); per-agent tools can shadow it by registering a
 * same-named entry.
 *
 * Thin wrapper over {@link prepareChart} for callers that already
 * have a dataset in hand. Mints a `chartId` synchronously, caches
 * an empty placeholder, and kicks off the chart-planner in the
 * background. Returns the `chartId` plus its ready-to-copy `marker`; the host
 * UI resolves that marker through the plugin's `/embed/chart/:id` route.
 *
 * For Genie statement results, prefer the Genie agent's
 * `prepare_chart` tool, which accepts a `statement_id` and
 * resolves the rows lazily.
 */
export function buildRenderDataTool(config: MastraPluginConfig) {
  return createTool({
    id: "render_data",
    description: string.toDescription([
      `
        Submit a tabular dataset for inline rendering as a chart in
        the user's view. Pass a title, the raw rows (array of objects
        keyed by column name), and an optional one-line description
        of the insight to highlight. Returns \`chartId\` plus the
        complete \`marker\`; copy the returned marker VERBATIM onto
        its own line where the chart should render. Never construct,
        alter, or invent a chart marker yourself.
      `,
      `
        Placement contract: embed the returned \`marker\` on its own
        line (blank lines above and below) wherever you want the chart
        to appear in your reply. The chart resolves
        asynchronously - the tool returns the id immediately and the
        host UI fetches the chart from the cache once the planner
        lands. You can call \`render_data\` multiple times in the
        same turn (the tool is parallel-safe) and interleave the
        markers with prose so each chart sits next to its
        commentary.
      `,
      `
        Use whenever a SQL row set, API response, or hand-built
        dataset would land better as a picture than as a list or
        table. Cap input at a few hundred rows; sample or aggregate
        larger datasets first.
      `,
    ]),
    inputSchema: chartPlannerRequestSchema,
    outputSchema: chartToolOutputSchema,
    execute: async (input, ctxRaw) => {
      const { title, description, data } = input as ChartPlannerRequest;
      const ctx = ctxRaw as { requestContext?: RequestContext } | undefined;
      return prepareChart({
        config,
        userKey: resolveUserKey(ctx?.requestContext),
        title,
        ...(description ? { description } : {}),
        resolveData: () => Promise.resolve({ rows: data }),
        ...(ctx?.requestContext ? { requestContext: ctx.requestContext } : {}),
      });
    },
  });
}

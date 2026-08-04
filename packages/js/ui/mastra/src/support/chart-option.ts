/**
 * Presentation normalizer for planner-produced Echarts specs.
 *
 * The chart planner (`@dbx-tools/appkit-mastra`) emits a JSON-safe
 * `EChartsOption` that travels through the cache and over the wire, so
 * it can't carry function-valued formatters or make width-dependent
 * layout choices. This module patches those presentation concerns back
 * in at render time - identically for the live inline chart
 * (`embed-slots`) and the print/PDF export (`export.ts`) - so both read
 * the same way:
 *
 *   - large value-axis ticks render compact (`800M`, not `800,000,000`);
 *   - value/category axis names sit in conventional positions (rotated
 *     on the left for `y`, centered below for `x`) instead of floating at
 *     the axis ends where they collide with the centered title;
 *   - category labels stay legible (shown, rotated, de-overlapped) rather
 *     than silently decimated when many bars share a narrow canvas;
 *   - the title and grid leave room for one another;
 *   - the chrome (tick labels, axis names, grid lines, tooltip) is painted
 *     in the reader's current theme, which a canvas cannot inherit from
 *     CSS the way the chart's frame does.
 *
 * Layout only fills gaps: any field the spec already sets (an explicit
 * `axisLabel.formatter`, `nameLocation`, etc.) is preserved. Chrome
 * colors are the exception - they OVERRIDE, because the whole point is
 * to replace whatever was baked in at plan time with the live theme.
 *
 * @module
 */
import { object } from "@dbx-tools/shared-core";
import type { ChartChrome } from "./chart-theme.ts";

/** Compact SI formatter shared across every value-axis tick. */
const COMPACT_NUMBER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * Format a value-axis tick compactly: `1200 -> "1.2K"`,
 * `800000000 -> "800M"`. Values below 1000 (and non-finite ones) render
 * verbatim so small-scale axes and category-like values are untouched.
 */
function compactAxisLabel(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  return Math.abs(value) < 1000 ? String(value) : COMPACT_NUMBER.format(value);
}

/** A permissive record view of an option node we patch field-by-field. */
type Obj = Record<string, unknown>;

const isObj = object.isRecord;

/** True when `title` (object or array) carries any non-empty `text`. */
function hasTitleText(title: unknown): boolean {
  const entries = Array.isArray(title) ? title : [title];
  return entries.some((t) => isObj(t) && typeof t.text === "string" && t.text.trim().length > 0);
}

/**
 * Shallow-merge `patch` over the object living at `node[key]`, treating a
 * missing or non-object value as `{}`. Sibling fields survive, so a
 * chrome color can be painted onto a node the layout pass already
 * populated (an `axisLabel` that carries a `formatter`, say).
 */
function patched(node: unknown, key: string, patch: Obj): Obj {
  const base = isObj(node) ? node : {};
  const child = isObj(base[key]) ? (base[key] as Obj) : {};
  return { ...base, [key]: { ...child, ...patch } };
}

/** {@link patched} for the `lineStyle.color` one level down. */
function lineColored(node: unknown, key: string, color: string): Obj {
  const base = isObj(node) ? node : {};
  return patched(base, key, patched(base[key], "lineStyle", { color }));
}

/** Pin a title to the top-center so it clears the plot / axis names. */
function normalizeTitle(title: unknown, chrome?: ChartChrome): unknown {
  if (Array.isArray(title)) return title.map((t) => normalizeTitle(t, chrome));
  if (!isObj(title)) return title;
  const next: Obj = { left: "center", top: 8, ...title };
  return chrome ? patched(next, "textStyle", { color: chrome.axisTitle }) : next;
}

/**
 * Ensure the grid leaves room for a top title and for rotated category
 * labels + a centered x-axis name below. `containLabel` keeps the tick
 * labels themselves inside the box; the explicit margins reserve space
 * for the title (top) and the axis name (bottom) which `containLabel`
 * does not account for.
 */
function normalizeGrid(grid: unknown, opts: { hasTitle: boolean }): unknown {
  const base = isObj(grid) ? grid : {};
  return {
    left: 12,
    right: 24,
    bottom: 24,
    ...base,
    top: base.top ?? (opts.hasTitle ? 64 : 32),
    containLabel: base.containLabel ?? true,
  };
}

/** Patch a single axis node in place-safe fashion (`x` or `y`). */
function normalizeAxis(axis: Obj, pos: "x" | "y", chrome?: ChartChrome): Obj {
  let next: Obj = { ...axis };
  const existingLabel = isObj(next.axisLabel) ? next.axisLabel : {};

  if (next.type === "value") {
    // Compact big-number ticks unless the spec pinned its own formatter.
    next.axisLabel = { formatter: compactAxisLabel, ...existingLabel };
  } else if (next.type === "category") {
    // Show every category and de-overlap rather than letting Echarts
    // drop labels on a crowded axis. Rotation is x-only: labels on a
    // category y-axis (a horizontal bar chart, a heatmap's rows) run
    // along their own row and have the full left margin to sit in, so
    // tilting them only makes them harder to read.
    next.axisLabel = {
      interval: 0,
      ...(pos === "x" ? { rotate: 30 } : {}),
      hideOverlap: true,
      ...existingLabel,
    };
  }

  // Move a set axis name to a conventional spot so it never collides
  // with the centered title (y) or floats past the last tick (x).
  if (typeof next.name === "string" && next.name.trim().length > 0) {
    next.nameLocation = next.nameLocation ?? "middle";
    if (pos === "y") {
      next.nameRotate = next.nameRotate ?? 90;
      next.nameGap = next.nameGap ?? 56;
    } else {
      next.nameGap = next.nameGap ?? 56;
    }
  }

  if (chrome) {
    // Echarts defaults every one of these to a near-black that vanishes
    // on a dark surface, so all four follow the theme together: the
    // ticks and their labels, the axis name, and the split lines.
    next = patched(next, "axisLabel", { color: chrome.axisLabel });
    next = patched(next, "nameTextStyle", { color: chrome.axisTitle });
    next = lineColored(next, "axisLine", chrome.grid);
    next = lineColored(next, "axisTick", chrome.grid);
    next = lineColored(next, "splitLine", chrome.grid);
  }
  return next;
}

/** Apply {@link normalizeAxis} across an axis field (object or array). */
function normalizeAxisField(axis: unknown, pos: "x" | "y", chrome?: ChartChrome): unknown {
  if (Array.isArray(axis)) return axis.map((a) => (isObj(a) ? normalizeAxis(a, pos, chrome) : a));
  return isObj(axis) ? normalizeAxis(axis, pos, chrome) : axis;
}

/**
 * Paint the theme onto the option nodes that are not per-axis: the base
 * text style (which legend and series labels inherit), the legend's own
 * labels, and the tooltip's surface, outline, and text.
 *
 * The base `textStyle` keeps whatever `fontFamily` the planner's brand
 * theme set - the font is brand identity and the same in either theme;
 * only the color is theme-dependent, so only the color is replaced.
 */
function normalizeChrome(option: Obj, chrome: ChartChrome): Obj {
  const next = patched(option, "textStyle", { color: chrome.axisTitle });
  // Legend and tooltip are patched only where the spec already declares
  // them: in Echarts a bare `legend: {}` is a SHOWN legend, so
  // conjuring one to hold a color would add a legend to a chart that
  // deliberately has none.
  if (isObj(next.legend)) {
    next.legend = patched(next.legend, "textStyle", { color: chrome.axisLabel });
  }
  if (isObj(next.tooltip)) {
    next.tooltip = {
      ...patched(next.tooltip, "textStyle", { color: chrome.tooltipForeground }),
      backgroundColor: chrome.tooltipBackground,
      borderColor: chrome.tooltipBorder,
    };
  }
  // A heatmap's visualMap prints its range bounds in the same near-black
  // default as the axes, so it needs the same treatment.
  if (isObj(next.visualMap)) {
    next.visualMap = patched(next.visualMap, "textStyle", { color: chrome.axisLabel });
  }
  return next;
}

/**
 * Return a render-ready copy of a planner `EChartsOption`: compact
 * value ticks, conventionally-placed axis names, legible category
 * labels, and title/grid spacing. Pure and shallow-cloning - the input
 * (which may be a shared/cached object) is never mutated. Non-object
 * input is returned untouched.
 *
 * Pass `chrome` to also color the chart for a theme (see
 * {@link ChartChrome}): the live one for an on-screen chart, or
 * `LIGHT_CHART_CHROME` for output that is always read on white, such as
 * the PDF export. Omit it and only layout is normalized, leaving
 * Echarts' own near-black defaults - legible on a light surface,
 * invisible on a dark one.
 */
export function normalizeChartOption<T>(option: T, chrome?: ChartChrome): T {
  if (!isObj(option)) return option;
  let next: Obj = { ...option };
  next.title = normalizeTitle(next.title, chrome);
  next.grid = normalizeGrid(next.grid, { hasTitle: hasTitleText(next.title) });
  next.xAxis = normalizeAxisField(next.xAxis, "x", chrome);
  next.yAxis = normalizeAxisField(next.yAxis, "y", chrome);
  if (chrome) next = normalizeChrome(next, chrome);
  return next as T;
}

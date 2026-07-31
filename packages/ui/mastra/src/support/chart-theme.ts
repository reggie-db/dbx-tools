/**
 * Live theme resolution for planner-produced Echarts specs.
 *
 * An Echarts chart draws to a canvas, so none of AppKit's CSS custom
 * properties reach it the way they reach the styled DOM around it: a
 * `.dark` root re-skins the chart's frame while the axis labels, grid
 * lines, and tooltip inside keep whatever colors were baked into the
 * spec. The planner (`@dbx-tools/appkit-mastra`) runs on the server and
 * cannot know the reader's theme at all, so the spec deliberately
 * carries only theme-INDEPENDENT identity (the brand series palette and
 * font stack) and leaves every chrome color to be resolved here.
 *
 * This module reads AppKit's chart tokens off a live element and hands
 * the result to `normalizeChartOption`, which paints them onto the axes,
 * title, legend, and tooltip. Reading from the CHART's own element
 * rather than `:root` matters because a host may scope `.dark` to a
 * subtree (an embedded chat panel inside an otherwise-light app);
 * custom properties inherit, so the chart element always sees the theme
 * that actually applies to it.
 *
 * @module
 */
import { object } from "@dbx-tools/shared-core";
import { type RefObject, useEffect, useState } from "react";

/**
 * The theme-dependent colors an Echarts spec needs, resolved from
 * AppKit's stylesheet. Deliberately chrome only - series colors are
 * brand identity and stay as the planner emitted them.
 */
export interface ChartChrome {
  /** Tick labels and legend entries. */
  axisLabel: string;
  /** Chart title and axis names - the stronger of the two foregrounds. */
  axisTitle: string;
  /** Split lines, axis lines, and ticks. */
  grid: string;
  /** Tooltip surface. */
  tooltipBackground: string;
  /** Tooltip text. */
  tooltipForeground: string;
  /** Tooltip outline. */
  tooltipBorder: string;
}

/**
 * AppKit's light-theme chart chrome (`:root` in
 * `@databricks/appkit-ui/dist/styles.css`), as literals.
 *
 * Two jobs: the fallback for every token that fails to resolve (a host
 * that never imported AppKit's stylesheet), and the fixed theme for
 * server-side rendering, where there is no document to read and the
 * output - a PDF export - is printed on white regardless of the
 * reader's theme.
 */
export const LIGHT_CHART_CHROME: ChartChrome = {
  axisLabel: "hsla(240, 4%, 46%, 1)",
  axisTitle: "hsla(240, 6%, 10%, 1)",
  grid: "hsla(240, 5%, 90%, 1)",
  tooltipBackground: "hsla(0, 0%, 100%, 1)",
  tooltipForeground: "hsla(240, 6%, 10%, 1)",
  tooltipBorder: "hsla(240, 5%, 90%, 1)",
};

/**
 * Which AppKit custom property backs each {@link ChartChrome} field.
 * The first four are AppKit's dedicated chart tokens; the tooltip's text
 * and outline reuse the generic popover/border tokens, which AppKit
 * redefines under `.dark` alongside them.
 */
const CHROME_TOKENS: Record<keyof ChartChrome, string> = {
  axisLabel: "--chart-axis-label",
  axisTitle: "--chart-axis-title",
  grid: "--chart-grid",
  tooltipBackground: "--chart-tooltip-bg",
  tooltipForeground: "--popover-foreground",
  tooltipBorder: "--border",
};

/**
 * Read AppKit's chart tokens as they resolve for `element`, falling back
 * to {@link LIGHT_CHART_CHROME} per-token when one is unset. Pass the
 * chart's own container so a theme scoped to a subtree is honored;
 * `null` (not yet mounted) reads the document root instead.
 */
export function resolveChartChrome(element: Element | null): ChartChrome {
  if (typeof window === "undefined") return LIGHT_CHART_CHROME;
  const target = element ?? document.documentElement;
  const styles = window.getComputedStyle(target);
  const chrome = { ...LIGHT_CHART_CHROME };
  for (const [field, token] of Object.entries(CHROME_TOKENS)) {
    const value = styles.getPropertyValue(token).trim();
    if (value) chrome[field as keyof ChartChrome] = value;
  }
  return chrome;
}

/** Root attributes whose change can re-theme the tokens below them. */
const THEME_ATTRIBUTES = ["class", "style", "data-theme", "data-brand"];

/**
 * Resolve the chart chrome for `ref`'s element and keep it current as
 * the theme changes.
 *
 * Two triggers, matching the two ways AppKit's stylesheet switches
 * themes: an explicit `.dark` / `.light` class (watched with a
 * `MutationObserver` on the document root, which is where hosts toggle
 * it) and the OS preference that `:root:not(.light)` falls back to
 * (watched with `matchMedia`). The resolved value is compared
 * structurally before being stored, so an unrelated attribute change
 * does not hand callers a new object and re-render every chart.
 *
 * Returns {@link LIGHT_CHART_CHROME} on the first render - the effect
 * that reads the real tokens runs after mount, by which point the chart
 * itself is usually still long-polling its spec.
 */
export function useChartChrome(ref: RefObject<Element | null>): ChartChrome {
  const [chrome, setChrome] = useState<ChartChrome>(LIGHT_CHART_CHROME);
  useEffect(() => {
    const read = () => {
      const next = resolveChartChrome(ref.current);
      setChrome((prev) => (object.deepEqual(prev, next) ? prev : next));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: THEME_ATTRIBUTES,
    });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", read);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", read);
    };
  }, [ref]);
  return chrome;
}

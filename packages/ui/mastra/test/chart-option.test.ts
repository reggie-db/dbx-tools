import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeChartOption } from "../src/support/chart-option.ts";
import { type ChartChrome, LIGHT_CHART_CHROME } from "../src/support/chart-theme.ts";

/** Distinguishable stand-in so each field can be traced to its target node. */
const CHROME: ChartChrome = {
  axisLabel: "#label",
  axisTitle: "#title",
  grid: "#grid",
  tooltipBackground: "#tipbg",
  tooltipForeground: "#tipfg",
  tooltipBorder: "#tipborder",
};

/** A spec shaped like the ones `planToEchartsOption` emits. */
const plannerOption = () => ({
  title: { text: "Quarterly Profit", left: "center" },
  tooltip: { trigger: "axis" },
  legend: { bottom: 0 },
  textStyle: { fontFamily: "DM Sans" },
  xAxis: { type: "category", data: ["Q1", "Q2"], name: "Quarter" },
  yAxis: { type: "value", name: "Amount" },
  series: [{ name: "Amount", type: "bar", data: [1, 2] }],
});

/** Narrow an option field to a record for assertions. */
const obj = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

describe("normalizeChartOption layout", () => {
  it("leaves non-object input untouched", () => {
    assert.equal(normalizeChartOption(undefined), undefined);
    assert.equal(normalizeChartOption("nope"), "nope");
  });

  it("does not mutate the cached input option", () => {
    const option = plannerOption();
    const before = structuredClone(option);
    normalizeChartOption(option, CHROME);
    assert.deepEqual(option, before);
  });

  it("compacts large value ticks and rotates crowded categories", () => {
    const out = obj(normalizeChartOption(plannerOption()));
    const yLabel = obj(obj(out.yAxis).axisLabel);
    assert.equal((yLabel.formatter as (v: number) => string)(800_000_000), "800M");
    assert.equal(obj(obj(out.xAxis).axisLabel).rotate, 30);
  });

  it("leaves category labels on a y-axis upright", () => {
    // Horizontal bars and heatmap rows put categories on the y-axis,
    // where each label owns its row and tilting only hurts legibility.
    const out = obj(
      normalizeChartOption({ yAxis: { type: "category", data: ["A long label", "B"] } }),
    );
    const label = obj(obj(out.yAxis).axisLabel);
    assert.equal(label.rotate, undefined);
    assert.equal(label.interval, 0);
    assert.equal(label.hideOverlap, true);
  });

  it("preserves a formatter the spec pinned itself", () => {
    const pinned = (v: number) => `${v}!`;
    const out = obj(
      normalizeChartOption({ yAxis: { type: "value", axisLabel: { formatter: pinned } } }),
    );
    assert.equal(obj(obj(out.yAxis).axisLabel).formatter, pinned);
  });

  it("adds no colors when no chrome is supplied", () => {
    const out = obj(normalizeChartOption(plannerOption()));
    assert.equal(obj(out.textStyle).color, undefined);
    assert.equal(obj(obj(out.yAxis).axisLabel).color, undefined);
    assert.equal(obj(out.tooltip).backgroundColor, undefined);
  });
});

describe("normalizeChartOption chrome", () => {
  it("colors ticks, axis names, and grid lines from the theme", () => {
    const out = obj(normalizeChartOption(plannerOption(), CHROME));
    const yAxis = obj(out.yAxis);
    assert.equal(obj(yAxis.axisLabel).color, CHROME.axisLabel);
    assert.equal(obj(yAxis.nameTextStyle).color, CHROME.axisTitle);
    assert.equal(obj(obj(yAxis.axisLine).lineStyle).color, CHROME.grid);
    assert.equal(obj(obj(yAxis.axisTick).lineStyle).color, CHROME.grid);
    assert.equal(obj(obj(yAxis.splitLine).lineStyle).color, CHROME.grid);
  });

  it("keeps the layout patches it colors over", () => {
    const yAxis = obj(obj(normalizeChartOption(plannerOption(), CHROME)).yAxis);
    // The value-tick formatter is applied before the chrome pass; the
    // color must merge into that node rather than replace it.
    assert.equal(typeof obj(yAxis.axisLabel).formatter, "function");
    assert.equal(yAxis.nameGap, 56);
  });

  it("colors the title, base text style, legend, and tooltip", () => {
    const out = obj(normalizeChartOption(plannerOption(), CHROME));
    assert.equal(obj(obj(out.title).textStyle).color, CHROME.axisTitle);
    assert.equal(obj(out.textStyle).color, CHROME.axisTitle);
    assert.equal(obj(obj(out.legend).textStyle).color, CHROME.axisLabel);
    assert.equal(obj(out.tooltip).backgroundColor, CHROME.tooltipBackground);
    assert.equal(obj(out.tooltip).borderColor, CHROME.tooltipBorder);
    assert.equal(obj(obj(out.tooltip).textStyle).color, CHROME.tooltipForeground);
  });

  it("keeps the brand font while replacing the baked text color", () => {
    const out = obj(
      normalizeChartOption({ textStyle: { fontFamily: "DM Sans", color: "#1B3139" } }, CHROME),
    );
    assert.deepEqual(out.textStyle, { fontFamily: "DM Sans", color: CHROME.axisTitle });
  });

  it("does not conjure a legend or tooltip the spec left out", () => {
    // A bare `legend: {}` renders a legend in Echarts, so a chart that
    // declares none must not gain one just to hold a color.
    const out = obj(normalizeChartOption({ series: [] }, CHROME));
    assert.equal(out.legend, undefined);
    assert.equal(out.tooltip, undefined);
  });

  it("colors a heatmap's visualMap bounds", () => {
    const out = obj(normalizeChartOption({ visualMap: { min: 0, max: 9 } }, CHROME));
    assert.equal(obj(obj(out.visualMap).textStyle).color, CHROME.axisLabel);
  });

  it("colors every entry of an array-valued axis", () => {
    const out = obj(
      normalizeChartOption({ yAxis: [{ type: "value" }, { type: "value" }] }, CHROME),
    );
    for (const axis of out.yAxis as Record<string, unknown>[]) {
      assert.equal(obj(axis.axisLabel).color, CHROME.axisLabel);
    }
  });

  it("exports a light chrome whose fields are all set", () => {
    for (const [field, value] of Object.entries(LIGHT_CHART_CHROME)) {
      assert.equal(typeof value, "string", `${field} should be a color string`);
      assert.ok(value.length > 0, `${field} should not be empty`);
    }
  });
});

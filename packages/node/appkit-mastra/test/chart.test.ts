import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import { chartPlanSchema, planToEchartsOption } from "../src/chart.ts";

/**
 * Walk every nested schema node, yielding each object so a test can
 * assert on keywords wherever they appear in the tree.
 */
function* nodes(schema: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(schema)) {
    for (const item of schema) yield* nodes(item);
    return;
  }
  if (typeof schema !== "object" || schema === null) return;
  const record = schema as Record<string, unknown>;
  yield record;
  for (const value of Object.values(record)) yield* nodes(value);
}

describe("chart plan JSON schema", () => {
  // Databricks' Gemini serving endpoints validate `response_json_schema`
  // and reject JSON Schema 2020-12 `prefixItems` with "schema at
  // properties.series.items.properties.data.items.anyOf.2.items must be a
  // boolean or an object". Zod emits `prefixItems` for `z.tuple`, so the
  // scatter / heatmap point must stay a length-constrained number array.
  it("emits no prefixItems, so Gemini accepts it as a response schema", () => {
    const jsonSchema = z.toJSONSchema(chartPlanSchema);
    const offenders = [...nodes(jsonSchema)].filter((node) => "prefixItems" in node);
    assert.deepEqual(offenders, []);
  });

  it("types scatter/heatmap points as a 2-or-3 number array", () => {
    const jsonSchema = z.toJSONSchema(chartPlanSchema) as Record<string, any>;
    const variants = jsonSchema.properties.series.items.properties.data.items.anyOf;
    const arrayVariant = variants.find((v: Record<string, unknown>) => v.type === "array");
    assert.deepEqual(arrayVariant, {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 3,
    });
  });
});

describe("chart data point coercion", () => {
  // `series` defaults to `[]` (a `custom` plan carries no series), so the
  // array sits one `ZodDefault` down from the object shape.
  const dataPoint = chartPlanSchema.shape.series.unwrap().element.shape.data.element;

  it("keeps the shapes a SQL row set produces", () => {
    assert.equal(dataPoint.parse(12.5), 12.5);
    assert.equal(dataPoint.parse("12.5"), 12.5);
    assert.equal(dataPoint.parse(null), null);
    assert.deepEqual(dataPoint.parse([1, 2]), [1, 2]);
    assert.deepEqual(dataPoint.parse([1, 2, 3]), [1, 2, 3]);
    assert.deepEqual(dataPoint.parse({ name: "ATL", value: 3 }), { name: "ATL", value: 3 });
  });

  it("degrades unusable values to null instead of failing the plan", () => {
    assert.equal(dataPoint.parse("not a number"), null);
    assert.equal(dataPoint.parse(Number.POSITIVE_INFINITY), null);
    assert.equal(dataPoint.parse({ nope: true }), null);
    assert.equal(dataPoint.parse([1]), null);
    assert.equal(dataPoint.parse([1, 2, 3, 4]), null);
  });
});

describe("planToEchartsOption", () => {
  it("expands scatter with [x, y] tuples on value axes", () => {
    const option = planToEchartsOption(
      {
        chartType: "scatter",
        xAxisLabel: "Price",
        yAxisLabel: "Qty",
        series: [{ name: "Points", data: [[1, 2], [3, 4], null, 12] }],
      },
      "Scatter",
    );
    const series = option.series as Array<{ type: string; data: unknown[] }>;
    assert.equal(series[0]?.type, "scatter");
    assert.deepEqual(series[0]?.data, [
      [1, 2],
      [3, 4],
    ]);
    assert.equal((option.xAxis as { type: string }).type, "value");
  });

  it("expands waterfall as stacked helper + increase + decrease bars", () => {
    const option = planToEchartsOption(
      {
        chartType: "waterfall",
        categories: ["Start", "Up", "Down"],
        series: [{ name: "Cash", data: [100, 40, -25] }],
      },
      "Bridge",
    );
    const series = option.series as Array<{ name: string; silent?: boolean; data: unknown[] }>;
    assert.equal(series.length, 3);
    assert.deepEqual(series[0]?.data, [0, 100, 115]);
    assert.deepEqual(series[1]?.data, [100, 40, "-"]);
    assert.deepEqual(series[2]?.data, ["-", "-", 25]);
    // The offset bars must not be hoverable or listed in the legend,
    // otherwise the bridge reads as a third data series.
    assert.equal(series[0]?.silent, true);
    assert.deepEqual((option.legend as { data: string[] }).data, ["Increase", "Decrease"]);
  });

  // A model asked for a bridge often builds the running total itself and
  // returns it alongside the deltas, which used to render as a plain
  // two-series bar chart (the base bars dominating the steps).
  it("ignores a hand-built cumulative base series on a waterfall", () => {
    const option = planToEchartsOption(
      {
        chartType: "waterfall",
        categories: ["A", "B", "C"],
        series: [
          { name: "Cumulative Base", data: [0, 10, 30] },
          { name: "Margin PSPW", data: [10, 20, -5] },
        ],
      },
      "Bridge",
    );
    const series = option.series as Array<{ data: unknown[] }>;
    assert.equal(series.length, 3);
    assert.deepEqual(series[0]?.data, [0, 10, 25]);
    assert.deepEqual(series[1]?.data, [10, 20, "-"]);
    assert.deepEqual(series[2]?.data, ["-", "-", 5]);
  });

  it("expands combo with mixed mark types and optional dual axis", () => {
    const option = planToEchartsOption(
      {
        chartType: "combo",
        categories: ["Q1", "Q2"],
        series: [
          { name: "Volume", type: "bar", data: [10, 20] },
          { name: "Rate", type: "line", yAxisIndex: 1, data: [0.1, 0.2] },
        ],
      },
      "Combo",
    );
    const series = option.series as Array<{ type: string; yAxisIndex: number }>;
    assert.equal(series[0]?.type, "bar");
    assert.equal(series[1]?.type, "line");
    assert.equal(series[1]?.yAxisIndex, 1);
    assert.ok(Array.isArray(option.yAxis));
  });

  it("expands heatmap with visualMap bounds from cell values", () => {
    const option = planToEchartsOption(
      {
        chartType: "heatmap",
        categories: ["Mon", "Tue"],
        yCategories: ["AM", "PM"],
        series: [
          {
            name: "Load",
            data: [
              [0, 0, 1],
              [1, 1, 9],
            ],
          },
        ],
      },
      "Heat",
    );
    assert.equal((option.series as Array<{ type: string }>)[0]?.type, "heatmap");
    assert.equal((option.visualMap as { min: number; max: number }).min, 1);
    assert.equal((option.visualMap as { min: number; max: number }).max, 9);
  });

  // Index arithmetic is the part a fast model gets wrong, and getting it
  // wrong drops every cell and renders an empty grid - so the row-per-
  // series shape it already produces for bar charts is accepted too.
  it("builds heatmap cells from one series per matrix row", () => {
    const option = planToEchartsOption(
      {
        chartType: "heatmap",
        categories: ["Mon", "Tue"],
        series: [
          { name: "AM", data: [1, 2] },
          { name: "PM", data: [3, 4] },
        ],
      },
      "Heat",
    );
    // Row order reads top-to-bottom: Echarts counts y index 0 from the
    // bottom, so the first series lands on the highest index.
    assert.deepEqual((option.series as Array<{ data: unknown[] }>)[0]?.data, [
      [0, 1, 1],
      [1, 1, 2],
      [0, 0, 3],
      [1, 0, 4],
    ]);
    assert.deepEqual((option.yAxis as { data: string[] }).data, ["PM", "AM"]);
    assert.equal((option.visualMap as { max: number }).max, 4);
  });

  it("widens a degenerate visualMap range so a uniform matrix still paints", () => {
    const option = planToEchartsOption(
      {
        chartType: "heatmap",
        categories: ["Mon"],
        series: [{ name: "AM", data: [5] }],
      },
      "Heat",
    );
    const visualMap = option.visualMap as { min: number; max: number };
    assert.equal(visualMap.min, 5);
    assert.equal(visualMap.max, 6);
  });

  it("expands funnel and treemap from named slices", () => {
    const slices = [
      { name: "Leads", value: 100 },
      { name: "Won", value: 20 },
    ];
    const funnel = planToEchartsOption(
      { chartType: "funnel", series: [{ name: "Pipe", data: slices }] },
      "Funnel",
    );
    const treemap = planToEchartsOption(
      { chartType: "treemap", series: [{ name: "Share", data: slices }] },
      "Tree",
    );
    assert.equal((funnel.series as Array<{ type: string }>)[0]?.type, "funnel");
    assert.equal((treemap.series as Array<{ type: string }>)[0]?.type, "treemap");
  });

  it("expands radar indicators from categories", () => {
    const option = planToEchartsOption(
      {
        chartType: "radar",
        categories: ["Speed", "Power"],
        series: [{ name: "A", data: [3, 8] }],
      },
      "Radar",
    );
    const indicators = (option.radar as { indicator: Array<{ name: string; max: number }> })
      .indicator;
    assert.deepEqual(indicators, [
      { name: "Speed", max: 3 },
      { name: "Power", max: 8 },
    ]);
  });

  it("expands horizontalBar with swapped axes", () => {
    const option = planToEchartsOption(
      {
        chartType: "horizontalBar",
        categories: ["Long label A", "Long label B"],
        series: [{ name: "Score", data: [1, 2] }],
      },
      "HBar",
    );
    assert.equal((option.xAxis as { type: string }).type, "value");
    assert.equal((option.yAxis as { type: string }).type, "category");
  });
});

/**
 * The `custom` escape hatch, for chart shapes the plan vocabulary cannot
 * express (sankey, boxplot, gauge, ...). The plan carries a whole Echarts
 * option instead of a series list, so what matters is that it reaches the
 * renderer intact rather than being reinterpreted by a builder branch.
 */
describe("planToEchartsOption custom charts", () => {
  const sankey = {
    series: [
      {
        type: "sankey",
        data: [{ name: "A" }, { name: "B" }],
        links: [{ source: "A", target: "B", value: 5 }],
      },
    ],
  };

  it("passes a hand-written option through untouched", () => {
    const option = planToEchartsOption(
      { chartType: "custom", series: [], option: JSON.stringify(sankey) },
      "Flow",
    );
    assert.deepEqual(option.series, sankey.series);
    // None of the cartesian scaffolding the plan branches add.
    assert.equal(option.xAxis, undefined);
    assert.equal(option.yAxis, undefined);
  });

  it("fills the caller's title only when the option omits one", () => {
    const filled = planToEchartsOption(
      { chartType: "custom", series: [], option: JSON.stringify(sankey) },
      "Flow",
    );
    assert.deepEqual(filled.title, { text: "Flow", left: "center" });

    const own = planToEchartsOption(
      {
        chartType: "custom",
        series: [],
        option: JSON.stringify({ ...sankey, title: { text: "Mine" } }),
      },
      "Flow",
    );
    assert.deepEqual(own.title, { text: "Mine" });
  });

  it("fails loudly when the option is missing or not a JSON object", () => {
    for (const option of [undefined, "", "{ not json", '"a string"', "[1, 2]"]) {
      assert.throws(
        () => planToEchartsOption({ chartType: "custom", series: [], option }, "Flow"),
        /custom/,
        `expected a throw for ${JSON.stringify(option)}`,
      );
    }
  });

  it("accepts a plan carrying no series at all", () => {
    // `custom` holds its series inside `option`, so the planner is not made
    // to invent an empty one to satisfy the schema.
    const plan = chartPlanSchema.parse({
      chartType: "custom",
      option: JSON.stringify(sankey),
    });
    assert.deepEqual(plan.series, []);
    assert.deepEqual(planToEchartsOption(plan, "Flow").series, sankey.series);
  });
});

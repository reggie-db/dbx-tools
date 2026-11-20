import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { genieVisualizationImagePath } from "@dbx-tools/shared-mastra";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GenieImageTabs } from "../src/react/_genie-image.tsx";
import { MastraPluginClient } from "../src/support/mastra-client.ts";

describe("Genie images", () => {
  it("keeps Chart and Table tabs without invoking a chart renderer", () => {
    const html = renderToStaticMarkup(
      createElement(GenieImageTabs, {
        src: "/original.png",
        data: {
          columns: ["business_week", "fuel_gallons_sold_pspw", "fuel_margin_pspw", "yoy_pct_pspw"],
          rows: [
            {
              business_week: "2026-10-04",
              fuel_gallons_sold_pspw: 125089.92,
              fuel_margin_pspw: 50280.31,
              yoy_pct_pspw: -0.038653328483108824,
            },
          ],
          rowCount: 1,
          truncated: false,
          visualization: {
            manifest: {
              schema: {
                columns: [
                  { name: "business_week", type_name: "DATE" },
                  { name: "fuel_gallons_sold_pspw", type_name: "DOUBLE" },
                  { name: "fuel_margin_pspw", type_name: "DOUBLE" },
                  { name: "yoy_pct_pspw", type_name: "DOUBLE" },
                ],
              },
            },
            result: {
              data_array: [["2026-10-04", "125089.92", "50280.31", "-0.038653328483108824"]],
            },
          },
        },
      }),
    );
    assert.match(html, />Chart</);
    assert.match(html, />Table</);
    assert.match(html, /src="\/original.png"/);
    assert.match(html, /alt="Genie query visualization"/);
    assert.match(html, /aria-label="Open Genie visualization"/);
    assert.match(html, /aria-haspopup="dialog"/);
    assert.match(html, /Loading Genie chart/);
    assert.match(html, /2026-10-04/);
    assert.match(html, /Business Week/);
    assert.match(html, /Fuel Gallons Sold PSPW/);
    assert.match(html, /Fuel Margin PSPW/);
    assert.match(html, /YoY % PSPW/);
    assert.match(html, /125,090/);
    assert.match(html, /\$50,280\.31/);
    assert.match(html, /-3\.87%/);
    assert.doesNotMatch(html, /<canvas|Change chart type/);
  });

  it("keeps the image when its query result is unavailable", () => {
    const html = renderToStaticMarkup(createElement(GenieImageTabs, { src: "/original.png" }));
    assert.match(html, /src="\/original.png"/);
    assert.match(html, /Query result unavailable/);
    assert.match(html, />Table</);
  });

  it("uses the published mount and shared image route without workspace credentials", () => {
    const reference = {
      alias: "sales",
      conversation_id: "conversation-1",
      message_id: "message-1",
      attachment_id: "visualization-1",
      statementId: "01f1d46a-94ed-1d92-932d-f8b2d193bbef",
    };
    const client = new MastraPluginClient({
      basePath: "/api/custom-mastra",
      defaultAgent: "support",
      agents: ["support"],
    });
    assert.equal(
      client.genieVisualizationImageUrl(reference),
      `${client.basePath}${genieVisualizationImagePath(reference)}`,
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { genieVisualizationImagePath } from "@dbx-tools/shared-mastra";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GenieImageTabs } from "../src/react/_genie-image.tsx";
import { MastraPluginClient } from "../src/support/mastra-client.ts";

describe("original Genie images", () => {
  it("keeps Chart and Table tabs without invoking a chart renderer", () => {
    const html = renderToStaticMarkup(
      createElement(GenieImageTabs, {
        src: "/original.png",
        data: {
          columns: ["week", "gallons"],
          rows: [{ week: "2026-10-04", gallons: 42 }],
          rowCount: 1,
          truncated: false,
          visualization: {
            manifest: {
              schema: {
                columns: [
                  { name: "week", type_name: "DATE" },
                  { name: "gallons", type_name: "DOUBLE" },
                ],
              },
            },
            result: { data_array: [["2026-10-04", "42"]] },
          },
        },
      }),
    );
    assert.match(html, />Chart</);
    assert.match(html, />Table</);
    assert.match(html, /src="\/original.png"/);
    assert.match(html, /alt="Genie query visualization"/);
    assert.match(html, /Loading Genie chart/);
    assert.match(html, /2026-10-04/);
    assert.match(html, /gallons/);
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GENIE_VISUALIZATION_MARKER,
  GenieVisualizationEmbedSchema,
  encodeGenieVisualizationEmbed,
  parseGenieVisualizationEmbed,
  genieVisualizationImagePath,
} from "../src/genie-visualization.ts";
import { parseMarkers, formatMarker } from "../src/markers.ts";
import { genieRoutePath, MASTRA_ROUTES } from "../src/routes.ts";
import { GenieChatRequestSchema } from "../src/wire.ts";

const reference = {
  alias: "sales/east",
  conversation_id: "conversation-1",
  message_id: "message-1",
  attachment_id: "viz with spaces/and]brackets",
  statementId: "01f1d46a-94ed-1d92-932d-f8b2d193bbef",
};

describe("Genie visualization references", () => {
  it("round-trips through the existing marker grammar without a cache or new chat", () => {
    const marker = parseMarkers(
      formatMarker(GENIE_VISUALIZATION_MARKER, encodeGenieVisualizationEmbed(reference)),
    )[0]!;
    assert.equal(marker.type, GENIE_VISUALIZATION_MARKER);
    assert.deepEqual(parseGenieVisualizationEmbed(marker.id), reference);
  });

  it("ignores malformed, incomplete, and remote-URL references", () => {
    for (const id of ["%", "null", encodeURIComponent("{}"), "https://example.com/chart.png"]) {
      assert.equal(parseGenieVisualizationEmbed(id), undefined);
    }
    assert.equal(
      GenieVisualizationEmbedSchema.safeParse({
        ...reference,
        statementId: "not-a-statement",
      }).success,
      false,
    );
  });

  it("derives the image URL from the shared route owner and encodes every identifier", () => {
    assert.equal(
      genieVisualizationImagePath(reference),
      genieRoutePath(
        reference.alias,
        MASTRA_ROUTES.threads,
        reference.conversation_id,
        MASTRA_ROUTES.messages,
        reference.message_id,
        MASTRA_ROUTES.attachments,
        reference.attachment_id,
        MASTRA_ROUTES.visualization,
      ),
    );
    assert.match(genieVisualizationImagePath(reference), /sales%2Feast/);
    assert.match(genieVisualizationImagePath(reference), /viz%20with%20spaces%2Fand%5Dbrackets/);
  });

  it("allows direct Genie requests to select the image renderer", () => {
    assert.deepEqual(
      GenieChatRequestSchema.parse({ question: "Show the trend", visualization: "image" }),
      { question: "Show the trend", visualization: "image" },
    );
    assert.equal(
      GenieChatRequestSchema.safeParse({ question: "Show the trend", visualization: "svg" })
        .success,
      false,
    );
  });
});

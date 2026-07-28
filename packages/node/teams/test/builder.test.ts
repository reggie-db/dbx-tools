import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { card } from "@dbx-tools/shared-teams";
import { buildAdaptiveCard, buildCardResult } from "../src/builder.ts";
import { resolveTeamsConfig } from "../src/config.ts";

describe("adaptive card builder", () => {
  it("compiles a minimal spec into a valid Adaptive Card envelope", () => {
    const document = buildAdaptiveCard({ title: "Hello" });
    assert.equal(document.type, "AdaptiveCard");
    assert.equal(document.version, card.ADAPTIVE_CARD_VERSION);
    assert.equal(document.$schema, card.ADAPTIVE_CARD_SCHEMA_URL);
    // A single bold title TextBlock, no actions.
    assert.equal(document.body.length, 1);
    assert.equal(document.body[0].type, "TextBlock");
    assert.equal(document.body[0].weight, "Bolder");
    assert.equal(document.actions, undefined);
    // The result round-trips through the shared schema.
    card.adaptiveCardSchema.parse(document);
  });

  it("emits subtitle, text, a FactSet, and OpenUrl actions when present", () => {
    const document = buildAdaptiveCard({
      title: "Deploy",
      subtitle: "prod",
      text: "Rolled out.",
      facts: [
        { title: "Version", value: "1.4.2" },
        { title: "Owner", value: "alice" },
      ],
      actions: [{ title: "View", url: "https://example.com/1" }],
    });
    const types = document.body.map((el) => el.type);
    assert.deepEqual(types, ["TextBlock", "TextBlock", "TextBlock", "FactSet"]);
    const factSet = document.body[3] as { facts: unknown[] };
    assert.equal(factSet.facts.length, 2);
    assert.equal(document.actions?.length, 1);
    assert.equal(document.actions?.[0].type, "Action.OpenUrl");
    assert.equal(document.actions?.[0].url, "https://example.com/1");
  });

  it("echoes the title in the card result", () => {
    const result = buildCardResult({ title: "Report" });
    assert.equal(result.title, "Report");
    card.cardResultSchema.parse(result);
  });
});

describe("teams config resolution", () => {
  it("defaults the card version and leaves the webhook unset", () => {
    const config = resolveTeamsConfig();
    assert.equal(config.cardVersion, card.ADAPTIVE_CARD_VERSION);
    assert.equal(config.webhookUrl, undefined);
  });

  it("accepts an absolute webhook URL and a pinned card version", () => {
    const config = resolveTeamsConfig({
      cardVersion: "1.4",
      webhookUrl: "https://example.webhook.office.com/abc",
    });
    assert.equal(config.cardVersion, "1.4");
    assert.equal(config.webhookUrl, "https://example.webhook.office.com/abc");
  });

  it("rejects a webhook URL that is not absolute", () => {
    assert.throws(() => resolveTeamsConfig({ webhookUrl: "not-a-url" }));
  });
});

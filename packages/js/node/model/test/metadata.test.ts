import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseModelCapabilities,
  parseModelRateLimits,
  parseRetiredModels,
} from "../src/_metadata-generator.ts";
import {
  modelCapabilitiesFor,
  modelMetadataFor,
  modelRateLimitsFor,
  modelReasoningLevelsFor,
  modelStatusFor,
  retiredModelNames,
} from "../src/metadata.ts";

describe("model metadata generation", () => {
  it("parses retirement tables and ignores unrelated tables", () => {
    const snapshot = parseRetiredModels(
      `<table><tr><th>Other</th></tr><tr><td>Ignore</td></tr></table>
       <table><tr><th>Partner model</th><th>Retirement date</th></tr>
       <tr><td>Anthropic Claude 3.7 Sonnet / Gemini 2.5 Pro</td><td>2026-01-01</td></tr></table>`,
      42,
    );
    assert.deepEqual(snapshot, {
      generatedAt: 42,
      models: ["Anthropic Claude 3.7 Sonnet", "Gemini 2.5 Pro"],
    });
  });

  it("parses response, image, patch, and web-search capabilities", () => {
    const responses = `<h2 id="databricks-hosted-foundation-models">Models</h2>
      <p><code>databricks-gpt-4</code> <code>databricks-gpt-5-4</code> <code>databricks-gpt-5-6-sol</code></p>
      <h2 id="supported-input-types">Inputs</h2><p>Text and image</p>
      <h2 id="limitations">Limitations</h2><p><code>apply_patch</code> is supported.</p>`;
    const webSearch = `<h2 id="supported-models">Supported models</h2>
      <h3 id="gemini-models">Gemini models</h3><p><code>databricks-gemini-3-1-pro</code></p>
      <h3 id="openai-models">OpenAI models</h3><p><code>databricks-gpt-5-4</code></p>
      <h3 id="anthropic-models-via-mcp">Anthropic models (via MCP)</h3>
      <p><code>databricks-claude-sonnet-4-6</code></p>`;
    assert.deepEqual(parseModelCapabilities(responses, webSearch, 42), {
      generatedAt: 42,
      capabilities: {
        responses: ["gpt-4", "gpt-5-4", "gpt-5-6-sol"],
        imageInput: ["gpt-4", "gpt-5-4", "gpt-5-6-sol"],
        applyPatch: ["gpt-4", "gpt-5-4", "gpt-5-6-sol"],
        webSearch: ["gemini-3-1-pro", "gpt-5-4", "gpt-5-6-sol"],
      },
    });
  });

  it("parses normalized ITPM, OTPM, and QPH limits", () => {
    const snapshot = parseModelRateLimits(
      `<table><tr><th>Model</th><th>ITPM</th><th>OTPM</th><th>QPH</th></tr>
       <tr><td>GPT 5.4 (Preview)*</td><td>1,000</td><td>200</td><td>3,600</td></tr></table>`,
      42,
    );
    assert.deepEqual(snapshot.catalogue.models["gpt-5-4"], {
      inputTokensPerMinute: 1000,
      outputTokensPerMinute: 200,
      queriesPerHour: 3600,
    });
  });
});

describe("model metadata lookup", () => {
  it("memoizes the committed retirement list", () => {
    assert.equal(retiredModelNames(), retiredModelNames());
    assert.equal(modelStatusFor("system.ai.gemini-2-5-pro").deprecated, true);
    assert.equal(modelStatusFor("databricks-gemini-3-1-pro").deprecated, false);
  });

  it("matches provider identities for capabilities and limits", () => {
    const endpoint = {
      name: "custom-gpt-endpoint",
      modelServiceName: "system.ai.gpt-5-4",
      serviceNames: { openai: "gpt-5.4" },
    };
    assert.equal(modelCapabilitiesFor(endpoint).responses, true);
    assert.equal(modelCapabilitiesFor("databricks-gpt-5-6-sol").webSearch, true);
    assert.equal(modelCapabilitiesFor("databricks-gpt-6-1-sol").webSearch, true);
    assert.equal(modelCapabilitiesFor("databricks-gpt-7-future").webSearch, true);
    assert.equal(modelCapabilitiesFor("databricks-gpt-4").webSearch, false);
    assert.equal(modelCapabilitiesFor("databricks-gpt-oss-120b").webSearch, false);
    assert.equal(modelCapabilitiesFor("steven-gpt-35-0125").webSearch, false);
    assert.equal(
      modelCapabilitiesFor({ name: "custom-gpt", modelServiceName: "system.ai.gpt-6-1-sol" })
        .webSearch,
      true,
    );
    assert.equal(modelCapabilitiesFor("system.ai.gemini-3-1-pro").webSearch, true);
    assert.equal(modelCapabilitiesFor("databricks-claude-sonnet-4-6").webSearch, false);
    assert.deepEqual(modelRateLimitsFor(endpoint), modelRateLimitsFor("gpt-5.4"));
    assert.equal(modelRateLimitsFor("system.ai.bge-large-en")?.queriesPerHour, 2_160_000);
    assert.deepEqual(modelMetadataFor(endpoint).status, { deprecated: false });
    assert.deepEqual(modelReasoningLevelsFor("databricks-grok-4-6"), [
      "low",
      "medium",
      "high",
      "extra-high",
    ]);
  });
});

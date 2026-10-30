import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  databricksGenAiCalculatorAssetUrl,
  parseDatabricksUsdPerDbu,
  parseModelCapabilities,
  parseModelParams,
  parseModelRateLimits,
  parseModelTokenPrices,
  parseModelsDev,
  parseRetiredModels,
} from "../src/_metadata-generator.ts";
import {
  estimateModelTokenPrice,
  modelCapabilitiesFor,
  modelMetadataFor,
  modelRateLimitsFor,
  modelReasoningLevelsFor,
  modelTokenPricesFor,
  modelTemperatureSupportFor,
} from "../src/metadata.ts";
import { modelStatusFor, retiredModelNames } from "../src/retirement.ts";

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

  it("parses Databricks token prices, tiers, variants, and grouped models", () => {
    const foundation = `<table>
      <tr><th>Model</th><th>Pay Per Token (DBU Per 1M Tokens)</th></tr>
      <tr><th>Input</th><th>Output</th><th>Cache read</th></tr>
      <tr><td>GLM-5.2, 5.3</td><td>20.000</td><td>62.857</td><td>3.714</td></tr>
    </table>`;
    const proprietary = `<table>
      <tr><th>Model</th><th></th><th>Standard Pay Per Token (DBU Per 1M Tokens)</th></tr>
      <tr><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Cache write (1hr)</th></tr>
      <tr><td>Claude Haiku 5.5 ⌖</td><td>Short context</td><td>1.429</td><td>7.143</td><td>0.143</td><td>1.786</td><td>2.857</td></tr>
      <tr><td>Long context</td><td>7.143</td><td>35.714</td><td>0.714</td><td>8.929</td><td>14.286</td></tr>
    </table>
    <table>
      <tr><th>Model</th><th>Priority Pay Per Token (DBU Per 1M Tokens)</th></tr>
      <tr><th>Input</th><th>Output</th><th>Cache read</th></tr>
      <tr><td>Grok 4.6*, 4.7* ⌖</td><td>35.714</td><td>107.143</td><td>8.929</td></tr>
    </table>
    <table><tr><th>Model</th><th>Batch Inference (DBU Per Hour)</th></tr>
      <tr><td>Ignore Me</td><td>100</td></tr></table>`;
    const snapshot = parseModelTokenPrices(foundation, proprietary, 42);
    assert.deepEqual(snapshot.catalogue.models["glm-5-2"], [
      {
        tier: "standard",
        condition: "default",
        inputDbuPerMillionTokens: 20,
        outputDbuPerMillionTokens: 62.857,
        cacheReadDbuPerMillionTokens: 3.714,
        cacheWriteDbuPerMillionTokens: null,
        cacheWriteOneHourDbuPerMillionTokens: null,
      },
    ]);
    assert.deepEqual(snapshot.catalogue.models["glm-5-3"], snapshot.catalogue.models["glm-5-2"]);
    assert.deepEqual(snapshot.catalogue.models["claude-5-5-haiku"], [
      {
        tier: "standard",
        condition: "short-context",
        inputDbuPerMillionTokens: 1.429,
        outputDbuPerMillionTokens: 7.143,
        cacheReadDbuPerMillionTokens: 0.143,
        cacheWriteDbuPerMillionTokens: 1.786,
        cacheWriteOneHourDbuPerMillionTokens: 2.857,
      },
      {
        tier: "standard",
        condition: "long-context",
        inputDbuPerMillionTokens: 7.143,
        outputDbuPerMillionTokens: 35.714,
        cacheReadDbuPerMillionTokens: 0.714,
        cacheWriteDbuPerMillionTokens: 8.929,
        cacheWriteOneHourDbuPerMillionTokens: 14.286,
      },
    ]);
    assert.equal(snapshot.catalogue.models["grok-4-6"]?.[0]?.tier, "priority");
    assert.deepEqual(snapshot.catalogue.models["grok-4-7"], snapshot.catalogue.models["grok-4-6"]);
    assert.equal(snapshot.catalogue.models["ignore-me"], undefined);
  });

  it("attaches Databricks default-region USD-per-DBU prices by cloud", () => {
    const foundation = `<table>
      <tr><th>Model</th><th>Pay Per Token (DBU Per 1M Tokens)</th></tr>
      <tr><th>Input</th><th>Output</th><th>Cache read</th></tr>
      <tr><td>GPT 5.4</td><td>35.714</td><td>214.286</td><td>3.571</td></tr>
      <tr><td>GPT 5.4 Mini</td><td>10</td><td>20</td><td>2</td></tr>
    </table>`;
    const calculator = `const defaults={aws:"aws--east",gcp:"gcp--south",azure:"azure--east"};
      const regions=JSON.parse('[{"key":"aws--east","cloud":"aws","rate":0.07},{"key":"azure--east","cloud":"azure","rate":0.08},{"key":"gcp--south","cloud":"gcp","rate":0.09}]');`;

    const snapshot = parseModelTokenPrices(foundation, "", 42, calculator);
    assert.deepEqual(snapshot.catalogue.models["gpt-5-4"]?.[0], {
      tier: "standard",
      condition: "default",
      inputDbuPerMillionTokens: 35.714,
      outputDbuPerMillionTokens: 214.286,
      cacheReadDbuPerMillionTokens: 3.571,
      cacheWriteDbuPerMillionTokens: null,
      cacheWriteOneHourDbuPerMillionTokens: null,
      usdPerDbu: { aws: 0.07, azure: 0.08, gcp: 0.09 },
    });
    assert.deepEqual(parseDatabricksUsdPerDbu(calculator), {
      aws: 0.07,
      azure: 0.08,
      gcp: 0.09,
    });
  });

  it("resolves the Databricks GenAI calculator Gatsby asset", () => {
    const html = `<script id="gatsby-chunk-mapping">
      window.___chunkMapping="{\\"component---src-pages-product-pricing-genai-pricing-calculator-tsx\\":[\\"/calculator.js\\"]}";
    </script>`;
    assert.equal(
      databricksGenAiCalculatorAssetUrl(
        html,
        "https://www.databricks.com/product/pricing/genai-pricing-calculator",
      ),
      "https://www.databricks.com/en-pricing-assets/calculator.js",
    );
  });

  it("normalizes models.dev capabilities and effort aliases", () => {
    const snapshot = parseModelsDev(
      {
        anthropic: {
          models: {
            "claude-fable-5-1": {
              id: "claude-fable-5-1",
              canonical_model_id: "anthropic/claude-fable-5-1",
              reasoning: true,
              reasoning_options: [
                { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
              ],
              tool_call: true,
              structured_output: true,
              temperature: false,
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
        },
        databricks: {
          models: {
            "databricks-gpt-5-4": {
              id: "databricks-gpt-5-4",
              temperature: true,
            },
            "databricks-gpt-5-5": {
              id: "databricks-gpt-5-5",
              temperature: false,
            },
          },
        },
      },
      42,
    );
    assert.deepEqual(snapshot.capabilities, {
      imageInput: ["claude-5-1-fable"],
      reasoning: ["claude-5-1-fable"],
      tools: ["claude-5-1-fable"],
      structuredOutput: ["claude-5-1-fable"],
      temperatureSupported: ["gpt-5-4"],
      temperatureUnsupported: ["gpt-5-5"],
    });
  });

  it("normalizes modelparams.dev effort fields and preview aliases", () => {
    const snapshot = parseModelParams(
      {
        models: [
          {
            provider: "openai",
            apiSurface: "openai-responses",
            model: "gpt-5.6-sol",
            params: [
              {
                path: "reasoning.effort",
                group: "reasoning",
                type: "enum",
                values: ["none", "low", "medium", "high", "xhigh", "max"],
              },
            ],
          },
          {
            provider: "google",
            apiSurface: "google-generate-content",
            model: "gemini-3.1-pro-preview",
            params: [
              {
                path: "generationConfig.thinkingConfig.thinkingLevel",
                group: "reasoning",
                type: "enum",
                values: ["low", "high"],
              },
            ],
          },
          {
            provider: "alibaba",
            apiSurface: "openai-chat-completions",
            model: "qwen3-next-80b-a3b-instruct",
            params: [
              {
                path: "extra_body.chat_template_kwargs.enable_thinking",
                group: "reasoning",
                type: "boolean",
              },
            ],
          },
        ],
      },
      42,
    );
    assert.deepEqual(snapshot.catalogue.models["gpt-5-6-sol"], [
      "low",
      "medium",
      "high",
      "extra-high",
      "max",
    ]);
    assert.deepEqual(snapshot.catalogue.models["gemini-3-1-pro"], ["low", "high"]);
    assert.ok(snapshot.catalogue.reasoning.includes("gemini-3-1-pro-preview"));
    assert.ok(!snapshot.catalogue.reasoning.includes("qwen-3-next-80b-a3b-instruct"));
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
    assert.equal(modelCapabilitiesFor("databricks-claude-sonnet-4-6").tools, true);
    assert.equal(modelCapabilitiesFor("databricks-gpt-5-5").reasoning, true);
    assert.equal(modelTemperatureSupportFor("databricks-gpt-5-4"), true);
    assert.equal(modelCapabilitiesFor("databricks-gpt-5-4").temperature, true);
    assert.equal(modelTemperatureSupportFor("databricks-gpt-5-5"), false);
    assert.equal(modelCapabilitiesFor("databricks-gpt-5-5").temperature, false);
    assert.equal(modelTemperatureSupportFor("custom-temperature-model"), undefined);
    assert.equal(modelCapabilitiesFor("custom-temperature-model").temperature, false);
    assert.deepEqual(modelRateLimitsFor(endpoint), modelRateLimitsFor("gpt-5.4"));
    assert.deepEqual(modelTokenPricesFor(endpoint), modelTokenPricesFor("gpt-5.4"));
    assert.equal(modelTokenPricesFor("databricks-gpt-5-4")?.[0]?.tier, "standard");
    assert.ok(
      modelTokenPricesFor("system.ai.claude-sonnet-4-6")?.some(
        (price) => price.cacheWriteDbuPerMillionTokens !== null,
      ),
    );
    const estimate = estimateModelTokenPrice(
      "databricks-gpt-5-4",
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      { condition: "short-context", usdPerDbu: 0.07 },
    );
    assert.equal(estimate?.model, "databricks-gpt-5-4");
    assert.equal(estimate?.rate.condition, "short-context");
    assert.ok(Math.abs((estimate?.price.dbu ?? 0) - 142.857) < 0.000_001);
    assert.ok(Math.abs((estimate?.price.usd ?? 0) - 9.999_99) < 0.000_001);
    assert.throws(() => estimateModelTokenPrice("gpt-5.4", { inputTokens: -1 }), RangeError);
    assert.throws(() => estimateModelTokenPrice("gpt-5.4", { inputTokens: 1.5 }), RangeError);
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

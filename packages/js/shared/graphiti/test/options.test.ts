import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  graphitiEnvironment,
  graphitiGatewayHealthUrl,
  graphitiOptionsFromEnvironment,
  resolveGraphitiOptions,
  serializeGraphitiOptions,
} from "../src/options.ts";

describe("Graphiti options", () => {
  it("applies the shared local gateway and model defaults", () => {
    const options = resolveGraphitiOptions();

    assert.equal(options.manageModelGateway, true);
    assert.equal(options.modelGatewayUrl, "http://127.0.0.1:4400/v1");
    assert.equal(options.model, "databricks-gpt-5-nano");
    assert.equal(options.embedderModel, "databricks-gte-large-en");
    assert.equal(options.embedderDimensions, 1024);
    assert.equal(options.openAiApiKey, "not-required");
  });

  it("normalizes external gateway values without duplicating environment policy", () => {
    const options = resolveGraphitiOptions({
      modelGatewayUrl: " https://models.example/v1/ ",
      manageModelGateway: false,
      model: "  gpt  ",
    });

    assert.equal(options.modelGatewayUrl, "https://models.example/v1");
    assert.equal(options.model, "gpt");
    assert.equal(options.openAiApiKey, "not-required");
  });

  it("produces the provider environment and health URL from the same owner", () => {
    const input = { modelGatewayPort: 4500, embedderDimensions: 768 };
    const environment = graphitiEnvironment(input);

    assert.equal(environment.OPENAI_API_URL, "http://127.0.0.1:4500/v1");
    assert.equal(environment.EMBEDDER_DIMENSIONS, "768");
    assert.equal(graphitiGatewayHealthUrl(input), "http://127.0.0.1:4500/api/healthz");
    assert.deepEqual(JSON.parse(serializeGraphitiOptions(input)), resolveGraphitiOptions(input));
  });

  it("rejects colliding Graphiti and proxy ports", () => {
    assert.throws(() => resolveGraphitiOptions({ graphitiPort: 8000, proxyPort: 8000 }));
  });

  it("parses environment names without reading process state", () => {
    assert.deepEqual(
      graphitiOptionsFromEnvironment({
        DATABRICKS_CONFIG_PROFILE: "PROFILE",
        GRAPHITI_HOME: "/graphiti",
        MODEL_GATEWAY_PORT: "4500",
        MANAGE_MODEL_GATEWAY: "false",
      }),
      {
        profile: "PROFILE",
        graphitiHome: "/graphiti",
        modelGatewayPort: 4500,
        manageModelGateway: false,
      },
    );
  });
});

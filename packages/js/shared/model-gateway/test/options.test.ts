import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ModelGatewayOptionsSchema,
  MODEL_GATEWAY_DEFAULTS,
  resolveModelGatewayCliOptions,
  resolveModelGatewayOptions,
} from "../src/options.ts";

describe("model-gateway options", () => {
  it("owns shared server defaults", () => {
    assert.deepEqual(MODEL_GATEWAY_DEFAULTS, {
      smartRouter: "auto",
      smartRouterContextTokenBudget: 4096,
      smartRouterTimeoutMs: 10000,
      smartRouterProbeRefreshIntervalMs: 3600000,
      smartRouterProbeTtlMs: 300000,
      smartRouterRouteTtlSeconds: 21600,
      preferSystemModels: false,
      listen: { scheme: "tcp", host: "localhost", port: 4000 },
      bodyLimit: "100mb",
    });
    assert.deepEqual(resolveModelGatewayOptions(), MODEL_GATEWAY_DEFAULTS);
  });

  it("coerces CLI strings and normalizes loopback hosts", () => {
    assert.deepEqual(
      resolveModelGatewayCliOptions({
        listen: " LOCALHOST:4400 ",
        profile: " PROFILE ",
      }),
      {
        smartRouter: "auto",
        smartRouterContextTokenBudget: 4096,
        smartRouterTimeoutMs: 10000,
        smartRouterProbeRefreshIntervalMs: 3600000,
        smartRouterProbeTtlMs: 300000,
        smartRouterRouteTtlSeconds: 21600,
        preferSystemModels: false,
        listen: { scheme: "tcp", host: "localhost", port: 4400 },
        profile: "PROFILE",
        bodyLimit: "100mb",
        runtimeInfo: false,
      },
    );
  });

  it("allows ephemeral embedded ports but rejects them for the CLI", () => {
    assert.equal(resolveModelGatewayOptions({ listen: 0 }).listen.port, 0);
    assert.throws(() => resolveModelGatewayCliOptions({ listen: 0 }), /Port must be an integer/);
  });

  it("shares mutually exclusive model and model-class selectors", () => {
    assert.equal(resolveModelGatewayOptions({ model: "gpt" }).model, "gpt");
    assert.equal(
      resolveModelGatewayOptions({ modelClass: "chat-balanced" }).modelClass,
      "chat-balanced",
    );
    assert.throws(
      () => resolveModelGatewayOptions({ model: "gpt", modelClass: "chat-balanced" }),
      /mutually exclusive/,
    );
  });

  it("defaults system-model preference off and allows explicit opt-in", () => {
    assert.equal(resolveModelGatewayOptions().preferSystemModels, false);
    assert.equal(resolveModelGatewayOptions({ preferSystemModels: true }).preferSystemModels, true);
  });

  it("supports auto, required, and disabled Smart Router modes", () => {
    assert.equal(resolveModelGatewayOptions().smartRouter, "auto");
    assert.equal(resolveModelGatewayOptions({ smartRouter: "true" }).smartRouter, "true");
    assert.equal(resolveModelGatewayOptions({ smartRouter: "false" }).smartRouter, "false");
    assert.throws(() => ModelGatewayOptionsSchema.parse({ smartRouter: true }));
  });

  it("rejects public listener hosts", () => {
    assert.throws(() => resolveModelGatewayOptions({ listen: "0.0.0.0:4000" }), /loopback/);
  });
});

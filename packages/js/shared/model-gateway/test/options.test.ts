import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MODEL_GATEWAY_DEFAULTS,
  resolveModelGatewayCliOptions,
  resolveModelGatewayOptions,
} from "../src/options.ts";

describe("model-gateway options", () => {
  it("owns shared server defaults", () => {
    assert.deepEqual(MODEL_GATEWAY_DEFAULTS, {
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

  it("rejects public listener hosts", () => {
    assert.throws(() => resolveModelGatewayOptions({ listen: "0.0.0.0:4000" }), /loopback/);
  });
});

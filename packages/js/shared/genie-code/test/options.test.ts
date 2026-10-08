import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GENIE_CODE_DEFAULTS, genieCodeHomeName, resolveGenieCodeOptions } from "../src/options.ts";

describe("Genie Code options", () => {
  it("defaults to the best tool-capable chat model on an ephemeral loopback listener", () => {
    assert.deepEqual(GENIE_CODE_DEFAULTS, {
      gatewayListen: { scheme: "tcp", host: "127.0.0.1", port: 0 },
    });
    assert.deepEqual(resolveGenieCodeOptions(), GENIE_CODE_DEFAULTS);
  });

  it("normalizes explicit profile, model, and listener values", () => {
    assert.deepEqual(
      resolveGenieCodeOptions({
        profile: " FEVM-REGGIE-PIERCE-AWS ",
        model: " grok ",
        gatewayListen: "localhost:4400",
      }),
      {
        profile: "FEVM-REGGIE-PIERCE-AWS",
        model: "grok",
        gatewayListen: { scheme: "tcp", host: "localhost", port: 4400 },
      },
    );
  });

  it("selects by model name or shared chat class, but not both", () => {
    assert.equal(
      resolveGenieCodeOptions({ modelClass: "chat-thinking" }).modelClass,
      "chat-thinking",
    );
    assert.throws(
      () => resolveGenieCodeOptions({ model: "gpt", modelClass: "chat-balanced" }),
      /mutually exclusive/,
    );
    assert.throws(() => resolveGenieCodeOptions({ modelClass: "embedding" as never }));
  });

  it("derives readable profile homes without losing exact-input identity", () => {
    assert.equal(
      genieCodeHomeName({
        profile: "FEVM REGGIE PIERCE AWS",
        digest: "0123456789ab",
      }),
      "fevm-reggie-pierce-aws-0123456789ab",
    );
    assert.notEqual(
      genieCodeHomeName({
        profile: "FEVM REGGIE PIERCE AWS",
        digest: "0123456789ab",
      }),
      genieCodeHomeName({
        profile: "fevm-reggie-pierce-aws",
        digest: "abcdef012345",
      }),
    );
  });

  it("rejects public gateway listeners and malformed profile hashes", () => {
    assert.throws(() => resolveGenieCodeOptions({ gatewayListen: "0.0.0.0:4000" }), /loopback/);
    assert.throws(() =>
      genieCodeHomeName({
        digest: "0123456789ab",
      } as never),
    );
    assert.throws(() =>
      genieCodeHomeName({
        profile: "PROFILE",
        digest: "short",
      }),
    );
  });
});

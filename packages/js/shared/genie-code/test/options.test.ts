import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GENIE_CODE_DEFAULTS,
  genieCodePairingName,
  resolveGenieCodeOptions,
} from "../src/options.ts";

describe("Genie Code options", () => {
  it("defaults to fuzzy GPT routing on an ephemeral loopback listener", () => {
    assert.deepEqual(GENIE_CODE_DEFAULTS, {
      model: "gpt",
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

  it("derives readable pairing names without losing exact-input identity", () => {
    assert.equal(
      genieCodePairingName({
        profile: "FEVM REGGIE PIERCE AWS",
        model: "GPT 5.6 Sol",
        digest: "0123456789ab",
      }),
      "fevm-reggie-pierce-aws-gpt-5-6-sol-0123456789ab",
    );
    assert.notEqual(
      genieCodePairingName({
        profile: "FEVM REGGIE PIERCE AWS",
        model: "GPT 5.6 Sol",
        digest: "0123456789ab",
      }),
      genieCodePairingName({
        profile: "fevm-reggie-pierce-aws",
        model: "gpt-5-6-sol",
        digest: "abcdef012345",
      }),
    );
  });

  it("rejects public gateway listeners and malformed pairing hashes", () => {
    assert.throws(() => resolveGenieCodeOptions({ gatewayListen: "0.0.0.0:4000" }), /loopback/);
    assert.throws(() =>
      genieCodePairingName({
        profile: "PROFILE",
        digest: "0123456789ab",
      } as never),
    );
    assert.throws(() =>
      genieCodePairingName({
        profile: "PROFILE",
        model: "gpt",
        digest: "short",
      }),
    );
  });
});

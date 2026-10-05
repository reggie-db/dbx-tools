import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProgram, type ModelGatewayCliDependencies } from "../src/cli.ts";

describe("model gateway CLI", () => {
  it("constructs without starting the gateway", () => {
    let started = false;
    const program = buildProgram("dbx model-gateway", {
      async start() {
        started = true;
      },
    });

    assert.match(program.helpInformation(), /--profile/);
    assert.equal(started, false);
  });

  it("starts the foreground gateway with typed options", async () => {
    const calls: Parameters<ModelGatewayCliDependencies["start"]>[0][] = [];
    await buildProgram("dbx model-gateway", {
      async start(options) {
        calls.push(options);
      },
    }).parseAsync(["--host", "localhost", "--port", "4410", "--profile", "MODEL-PROFILE"], {
      from: "user",
    });

    assert.deepEqual(calls, [{ host: "localhost", port: 4410, profile: "MODEL-PROFILE" }]);
  });

  it("rejects public binds and invalid ports", async () => {
    const dependencies: ModelGatewayCliDependencies = {
      async start() {
        throw new Error("should not start");
      },
    };
    await assert.rejects(
      () =>
        buildProgram("dbx model-gateway", dependencies).parseAsync(["--host", "0.0.0.0"], {
          from: "user",
        }),
      /loopback/,
    );
    assert.throws(
      () =>
        buildProgram("dbx model-gateway", dependencies)
          .exitOverride()
          .parse(["--port", "70000"], { from: "user" }),
      /port must be an integer/,
    );
  });
});

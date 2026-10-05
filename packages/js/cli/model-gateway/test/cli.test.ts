import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CliServiceDefinition, CliServiceLifecycle } from "@dbx-tools/cli-service";
import {
  buildProgram,
  modelGatewayServiceDefinition,
  type ModelGatewayCliDependencies,
} from "../src/cli.ts";

describe("model gateway CLI", () => {
  it("constructs without starting the gateway", () => {
    let started = false;
    const program = buildProgram("dbx model-gateway", {
      async start() {
        started = true;
      },
    });

    assert.match(program.helpInformation(), /--profile/);
    assert.match(program.helpInformation(), /service/);
    assert.equal(started, false);
  });

  it("defines a tray-only service with a models URL item", () => {
    const definition = modelGatewayServiceDefinition();

    assert.deepEqual(definition.menu, [
      {
        type: "url",
        label: "Models",
        url: "http://127.0.0.1:4400/v1/models",
      },
    ]);
    assert.match(definition.command?.entrypoint ?? "", /dbx-model-gateway\.(ts|js)$/);
  });

  it("persists service port and profile options", async () => {
    let definition: CliServiceDefinition | undefined;
    const service: CliServiceLifecycle = {
      async install() {},
      async start() {},
      async stop() {},
      async restart() {},
      async uninstall() {},
      async status() {
        return { installed: false, running: false };
      },
    };
    await buildProgram("dbx model-gateway", {
      async start() {},
      service: {
        create(value) {
          definition = value;
          return service;
        },
        write() {},
      },
    }).parseAsync(
      ["service", "install", "--no-start", "--port", "4401", "--profile", "SERVICE-PROFILE"],
      { from: "user" },
    );

    assert.deepEqual(definition?.command?.arguments?.slice(-6), [
      "--host",
      "127.0.0.1",
      "--port",
      "4401",
      "--profile",
      "SERVICE-PROFILE",
    ]);
    assert.deepEqual(definition?.menu, [
      {
        type: "url",
        label: "Models",
        url: "http://127.0.0.1:4401/v1/models",
      },
    ]);
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

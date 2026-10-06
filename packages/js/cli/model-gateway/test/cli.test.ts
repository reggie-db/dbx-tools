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

    const help = program.helpInformation();
    assert.match(help, /--listen <value>/);
    assert.match(help, /--profile <value>/);
    assert.match(help, /PROFILE/);
    assert.match(help, /--body-limit <value>/);
    assert.match(help, /BODY_LIMIT/);
    assert.match(help, /service/);
    assert.equal(started, false);
  });

  it("defines a tray-only service with a models URL item", () => {
    const definition = modelGatewayServiceDefinition();

    assert.deepEqual(definition.menu, [
      {
        type: "url",
        label: "Models",
        url: "http://localhost:4000/v1/models",
      },
    ]);
    assert.equal(definition.packageName, "@dbx-tools/cli-model-gateway");
    assert.equal(definition.id, "dbx-tools.cli-model-gateway");
    assert.equal(definition.name, "dbx model gateway");
    assert.match(definition.version ?? "", /^\d+\.\d+\.\d+/);
    assert.equal(definition.command?.entrypoint, undefined);
    assert.equal(definition.command?.executable, undefined);
    assert.deepEqual(definition.command?.environment, {
      NODE_ENV: "production",
    });
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
      ["service", "install", "--no-start", "--listen", ":4401", "--profile", "SERVICE-PROFILE"],
      { from: "user" },
    );

    assert.deepEqual(definition?.command?.arguments, [
      "--listen",
      "localhost:4401",
      "--profile",
      "SERVICE-PROFILE",
      "--body-limit",
      "100mb",
    ]);
    assert.deepEqual(definition?.menu, [
      {
        type: "url",
        label: "Models",
        url: "http://localhost:4401/v1/models",
      },
    ]);
  });

  it("starts the foreground gateway with typed options", async () => {
    const calls: Parameters<ModelGatewayCliDependencies["start"]>[0][] = [];
    await buildProgram("dbx model-gateway", {
      async start(options) {
        calls.push(options);
      },
    }).parseAsync(["--listen", "4410", "--profile", "MODEL-PROFILE"], {
      from: "user",
    });

    assert.deepEqual(calls, [
      {
        listen: { host: "localhost", port: 4410 },
        profile: "MODEL-PROFILE",
        bodyLimit: "100mb",
      },
    ]);
  });

  it("rejects public binds and invalid ports", async () => {
    const dependencies: ModelGatewayCliDependencies = {
      async start() {
        throw new Error("should not start");
      },
    };
    await assert.rejects(
      () =>
        buildProgram("dbx model-gateway", dependencies).parseAsync(["--listen", "0.0.0.0:4000"], {
          from: "user",
        }),
      /loopback/,
    );
    await assert.rejects(
      () =>
        buildProgram("dbx model-gateway", dependencies)
          .exitOverride()
          .parseAsync(["--listen", ":70000"], { from: "user" }),
      /65535/,
    );
  });
});

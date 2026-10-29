import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { CliServiceDefinition, CliServiceLifecycle } from "@dbx-tools/cli-service";
import {
  buildProgram,
  modelGatewayServiceDefinition,
  type ModelGatewayCliDependencies,
} from "../src/model-gateway/cli.ts";

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
    assert.match(help, /--model <value>/);
    assert.match(help, /--model-class <value>/);
    assert.match(help, /--smart-router <value>/);
    assert.match(help, /choices: "auto", "true", "false"/);
    assert.match(help, /--prefer-system-models/);
    assert.match(help, /--select-model-from <value>/);
    assert.match(help, /--body-limit <value>/);
    assert.match(help, /BODY_LIMIT/);
    assert.doesNotMatch(help, /bearer-token/i);
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
    assert.equal(definition.packageName, "@dbx-tools/cli");
    assert.equal(definition.command?.binName, "dbx-model-gateway");
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
      logPath() {
        return "/var/log/model-gateway.log";
      },
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
      "--smart-router",
      "auto",
      "--smart-router-timeout-ms",
      "10000",
      "--smart-router-context-token-budget",
      "4096",
      "--smart-router-probe-ttl-ms",
      "300000",
      "--smart-router-probe-refresh-interval-ms",
      "3600000",
      "--smart-router-route-ttl-seconds",
      "21600",
      "--no-prefer-system-models",
      "--listen",
      "tcp://localhost:4401",
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

  it("never serializes a bearer token into service arguments", () => {
    const definition = modelGatewayServiceDefinition({
      bearerToken: "secret",
      profile: "SERVICE-PROFILE",
    });

    assert.doesNotMatch(definition.command?.arguments?.join(" ") ?? "", /secret|bearer/i);
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
        smartRouter: "auto",
        smartRouterTimeoutMs: 10000,
        smartRouterContextTokenBudget: 4096,
        smartRouterProbeRefreshIntervalMs: 3600000,
        smartRouterProbeTtlMs: 300000,
        smartRouterRouteTtlSeconds: 21600,
        listen: { scheme: "tcp", host: "localhost", port: 4410 },
        profile: "MODEL-PROFILE",
        bodyLimit: "100mb",
        preferSystemModels: false,
      },
    ]);
  });

  it("passes the system-model preference to the foreground gateway", async () => {
    const calls: Parameters<ModelGatewayCliDependencies["start"]>[0][] = [];
    await buildProgram("dbx model-gateway", {
      async start(options) {
        calls.push(options);
      },
    }).parseAsync(["--prefer-system-models"], { from: "user" });

    assert.equal(calls[0]?.preferSystemModels, true);
  });

  it("selects from a JSON file without starting the server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-smart-router-"));
    const path = join(directory, "request.json");
    await writeFile(path, JSON.stringify({ input: "Refactor the parser" }));
    let input: unknown;
    let started = false;
    try {
      await buildProgram("dbx model-gateway", {
        async start() {
          started = true;
        },
        async select(_options, value) {
          input = value;
          return { model: "databricks-gpt-test" };
        },
      }).parseAsync(["--select-model-from", path], { from: "user" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    assert.deepEqual(input, { input: "Refactor the parser" });
    assert.equal(started, false);
  });

  it("reads the hidden bearer token only from the environment", async () => {
    const previous = {
      token: process.env.DBX_TOOLS_MODEL_GATEWAY_BEARER_TOKEN,
      listen: process.env.LISTEN,
    };
    const calls: Parameters<ModelGatewayCliDependencies["start"]>[0][] = [];
    process.env.DBX_TOOLS_MODEL_GATEWAY_BEARER_TOKEN = "environment-secret";
    process.env.LISTEN = "tcp://127.0.0.1:4312";
    try {
      await buildProgram("dbx model-gateway", {
        async start(options) {
          calls.push(options);
        },
      }).parseAsync([], { from: "user" });
    } finally {
      if (previous.token === undefined) delete process.env.DBX_TOOLS_MODEL_GATEWAY_BEARER_TOKEN;
      else process.env.DBX_TOOLS_MODEL_GATEWAY_BEARER_TOKEN = previous.token;
      if (previous.listen === undefined) delete process.env.LISTEN;
      else process.env.LISTEN = previous.listen;
    }

    assert.equal(calls[0]?.bearerToken, "environment-secret");
    assert.deepEqual(calls[0]?.listen, {
      scheme: "tcp",
      host: "127.0.0.1",
      port: 4312,
    });
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

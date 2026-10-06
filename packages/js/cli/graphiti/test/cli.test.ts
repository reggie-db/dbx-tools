import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CliServiceDefinition, CliServiceLifecycle } from "@dbx-tools/cli-service";
import { PACKAGE_VERSION } from "../index.ts";
import { buildProgram, graphitiServiceDefinition } from "../src/cli.ts";
import type { GraphitiRuntimeOptions } from "../src/runtime.ts";

describe("Graphiti CLI", () => {
  it("constructs without starting Graphiti", () => {
    const program = buildProgram();
    assert.equal(program.version(), PACKAGE_VERSION);
    assert.deepEqual(
      program.commands.map((command) => command.name()),
      ["service"],
    );
  });

  it("forwards Python arguments unchanged with the selected profile", async () => {
    let received: GraphitiRuntimeOptions | undefined;
    await buildProgram("dbx graphiti", {
      async start(options) {
        received = options;
      },
    }).parseAsync(
      [
        "--python",
        "/path with spaces/python",
        "--profile",
        "GRAPHITI-PROFILE",
        "--model",
        "my-model",
      ],
      { from: "user" },
    );
    assert.deepEqual(received, {
      python: "/path with spaces/python",
      profile: "GRAPHITI-PROFILE",
      args: ["--model", "my-model"],
    });
  });

  it("defines a Python foreground command using the shared service package", () => {
    const definition = graphitiServiceDefinition({
      python: "python3",
      profile: "GRAPHITI-PROFILE",
    });
    assert.equal(definition.packageName, "@dbx-tools/cli-graphiti");
    assert.equal(definition.command?.executable, "python3");
    assert.deepEqual(definition.command?.arguments, [
      "-m",
      "dbx_tools.graphiti",
      "start",
      "--profile",
      "GRAPHITI-PROFILE",
    ]);
    assert.match(definition.command?.environment?.MODEL_GATEWAY_COMMAND ?? "", /dbx-model-gateway/);
  });

  it("persists options through shared install without starting foreground", async () => {
    let definition: CliServiceDefinition | undefined;
    let installed = false;
    let prepared: string | undefined;
    const lifecycle: CliServiceLifecycle = {
      async install(options) {
        installed = options?.start === false;
      },
      async start() {},
      async stop() {},
      async restart() {},
      async uninstall() {},
      async status() {
        return { installed: false, running: false };
      },
    };
    await buildProgram("dbx graphiti", {
      async start() {
        assert.fail("must not start foreground during installation");
      },
      async prepare(python) {
        prepared = python;
      },
      service: {
        create(value) {
          definition = value;
          return lifecycle;
        },
        write() {},
      },
    }).parseAsync(
      [
        "service",
        "install",
        "--no-start",
        "--python",
        "python-custom",
        "--profile",
        "GRAPHITI-PROFILE",
      ],
      { from: "user" },
    );
    assert.equal(installed, true);
    assert.equal(prepared, "python-custom");
    assert.deepEqual(
      definition,
      graphitiServiceDefinition({ python: "python-custom", profile: "GRAPHITI-PROFILE" }),
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CliServiceDefinition, CliServiceLifecycle } from "@dbx-tools/cli-service";
import { GraphitiOptionsSchema as RuntimeGraphitiOptionsSchema } from "@dbx-tools/graphiti/options";
import type { GraphitiRuntimeOptions } from "@dbx-tools/graphiti/runtime";
import { PACKAGE_VERSION } from "../index.ts";
import { buildProgram, graphitiServiceDefinition } from "../src/cli.ts";
import { GRAPHITI_DEFAULTS, GraphitiOptionsSchema } from "../src/options.ts";

describe("Graphiti CLI", () => {
  it("exposes the exact shared Graphiti option schema", () => {
    assert.equal(GraphitiOptionsSchema, RuntimeGraphitiOptionsSchema);
  });

  it("constructs without starting Graphiti", () => {
    const program = buildProgram();
    const help = program.helpInformation();
    assert.equal(program.version(), PACKAGE_VERSION);
    assert.deepEqual(
      program.commands.map((command) => command.name()),
      ["service"],
    );
    assert.match(help, /--embedder-model <value>/);
    assert.match(help, /EMBEDDER_MODEL/);
    assert.match(help, /DATABRICKS_CONFIG_PROFILE/);
    assert.match(help, /MODEL_NAME/);
    assert.match(help, /--graphiti-home <value>/);
    assert.match(help, /GRAPHITI_HOME/);
    assert.match(help, /DATABASE_URL/);
    assert.doesNotMatch(help, /DBX_TOOLS_DATABASE_URL/);
    assert.doesNotMatch(help, /model-gateway/);
    assert.doesNotMatch(help, /--graphiti-args/);
  });

  it("passes shared options unchanged with the selected profile", async () => {
    let received: GraphitiRuntimeOptions | undefined;
    await buildProgram("dbx graphiti", {
      async run(options) {
        received = options;
      },
    }).parseAsync(["--profile", "GRAPHITI-PROFILE", "--model", "my-model"], { from: "user" });
    assert.deepEqual(received, {
      ...GRAPHITI_DEFAULTS,
      profile: "GRAPHITI-PROFILE",
      model: "my-model",
    });
  });

  it("defines the owning Node CLI command using the shared service package", () => {
    const definition = graphitiServiceDefinition({
      profile: "GRAPHITI-PROFILE",
    });
    assert.equal(definition.packageName, "@dbx-tools/cli-graphiti");
    assert.equal(definition.command?.executable, undefined);
    assert.deepEqual(definition.pythonPackage, {
      name: "dbx-tools-graphiti",
      python: "3.11",
      dependencies: [],
    });
    assert.ok(definition.command?.arguments?.includes("GRAPHITI-PROFILE"));
  });

  it("persists options through shared install without starting foreground", async () => {
    let definition: CliServiceDefinition | undefined;
    let installed = false;
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
      async run() {
        assert.fail("must not start foreground during installation");
      },
      service: {
        create(value) {
          definition = value;
          return lifecycle;
        },
        write() {},
      },
    }).parseAsync(["service", "install", "--no-start", "--profile", "GRAPHITI-PROFILE"], {
      from: "user",
    });
    assert.equal(installed, true);
    assert.deepEqual(definition, graphitiServiceDefinition({ profile: "GRAPHITI-PROFILE" }));
  });
});

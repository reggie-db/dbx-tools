import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GraphitiOptionsSchema as RuntimeGraphitiOptionsSchema } from "@dbx-tools/appkit-graphiti/options";
import type { GraphitiRuntimeOptions } from "@dbx-tools/appkit-graphiti/runtime";
import type { CliServiceDefinition, CliServiceLifecycle } from "@dbx-tools/cli-service";
import { serviceTrayIcon } from "@dbx-tools/cli-service/icon";
import { PACKAGE_VERSION } from "../index.ts";
import { buildProgram, graphitiServiceDefinition } from "../src/graphiti/cli.ts";
import { GRAPHITI_DEFAULTS, GraphitiOptionsSchema } from "../src/graphiti/options.ts";

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
    assert.match(help, /DATABRICKS_CONFIG_PROFILE/);
    assert.match(help, /--model-class <value>/);
    assert.match(help, /MODEL_CLASS/);
    assert.match(help, /--graphiti-home <value>/);
    assert.match(help, /GRAPHITI_HOME/);
    assert.match(help, /LAKEBASE_ENDPOINT/);
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
    }).parseAsync(["--profile", "GRAPHITI-PROFILE", "--model-class", "chat-thinking"], {
      from: "user",
    });
    assert.deepEqual(received, {
      ...GRAPHITI_DEFAULTS,
      profile: "GRAPHITI-PROFILE",
      modelClass: "chat-thinking",
    });
  });

  it("defines the owning Node CLI command using the shared service package", () => {
    const definition = graphitiServiceDefinition({
      profile: "GRAPHITI-PROFILE",
    });
    assert.equal(definition.packageName, "@dbx-tools/cli");
    assert.equal(definition.id, "dbx-tools.cli-graphiti");
    assert.equal(definition.name, "dbx graphiti");
    assert.equal(definition.icon, serviceTrayIcon("graphiti"));
    assert.equal(definition.dataDirectory, join(homedir(), ".dbx-tools", "services", "graphiti"));
    assert.equal(definition.command?.executable, undefined);
    assert.equal(definition.command?.binName, "dbx-graphiti");
    assert.deepEqual(definition.pythonPackage, {
      name: "dbx-tools-graphiti[dev]",
      python: "3.11",
      dependencies: [],
    });
    assert.ok(definition.command?.arguments?.includes("GRAPHITI-PROFILE"));
    assert.ok(definition.command?.arguments?.includes(join(homedir(), ".dbx-tools", "graphiti")));
  });

  it("installs no embedded database extra for external PostgreSQL", () => {
    const definition = graphitiServiceDefinition({
      databaseUrl: "postgresql://localhost/graphiti",
    });

    assert.equal(definition.pythonPackage?.name, "dbx-tools-graphiti");
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
      logPath() {
        return "/var/log/graphiti.log";
      },
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

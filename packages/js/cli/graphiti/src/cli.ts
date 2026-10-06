/**
 * Commander-owned Graphiti CLI and shared current-user service definition.
 *
 * This module owns every user-facing Graphiti command and option so generated
 * help and README references remain complete. Python receives one validated
 * serialized `@dbx-tools/shared-graphiti` configuration and does not parse the
 * public CLI.
 *
 * @module
 */
import { buildServiceCommand, type CliServiceCliDependencies } from "@dbx-tools/cli-service/cli";
import { defineService, type CliServiceDefinition } from "@dbx-tools/cli-service/definition";
import {
  GRAPHITI_COMMAND_ENV,
  GRAPHITI_DEFAULTS,
  GRAPHITI_OPTIONS_ENV,
  graphitiOptionOverrides,
  resolveGraphitiOptions,
  serializeGraphitiOptions,
  type GraphitiCommand,
  type GraphitiOptions,
} from "@dbx-tools/shared-graphiti";
import { Command, Option } from "commander";
import { PACKAGE_VERSION } from "../index.ts";
import {
  ensureGraphitiModelGateway,
  ensureGraphitiPython,
  runGraphiti,
  type GraphitiRuntimeOptions,
} from "./runtime.ts";

/** Injectable runtime and service lifecycle boundaries for CLI callers. */
export interface GraphitiCliDependencies {
  /** Run one Python Graphiti operation. */
  run(command: GraphitiCommand, options: GraphitiRuntimeOptions): Promise<void>;
  /** Bootstrap the matching Python runtime before service installation. */
  readonly prepare?: (python: string) => Promise<void>;
  /** Shared service command dependencies for tests and embedding. */
  readonly service?: CliServiceCliDependencies;
}

/** Runtime options persisted when installing the Graphiti desktop service. */
export type GraphitiServiceOptions = GraphitiOptions;

/** Define a Graphiti service without duplicating installation or lifecycle policy. */
export function graphitiServiceDefinition(
  options: GraphitiServiceOptions = {},
): CliServiceDefinition {
  const resolved = resolveGraphitiOptions({
    ...options,
    modelGatewayCommand: options.modelGatewayCommand ?? ensureGraphitiModelGateway(),
  });
  return defineService(import.meta.url, {
    command: {
      executable: resolved.python,
      arguments: ["-m", "dbx_tools.graphiti"],
      environment: {
        [GRAPHITI_COMMAND_ENV]: "start",
        [GRAPHITI_OPTIONS_ENV]: serializeGraphitiOptions(resolved),
      },
    },
  });
}

/** Build foreground, detached, inspection, and shared service commands. */
export function buildProgram(
  name = "dbx graphiti",
  dependencies: GraphitiCliDependencies = { run: runGraphiti },
): Command {
  const program = addGraphitiOptions(
    new Command()
      .name(name)
      .description("Run Graphiti or manage its current-user desktop service")
      .version(PACKAGE_VERSION, "-v, --version"),
  )
    .argument("[args...]", "arguments forwarded to the pinned Graphiti MCP server")
    .action(async (args: string[], _options: unknown, command: Command) => {
      await dependencies.run("start", graphitiOptions(command, args));
    });

  for (const [commandName, description] of [
    ["start", "Start Neo4j, the model gateway, and Graphiti in the foreground"],
    ["up", "Start Neo4j, the model gateway, and Graphiti in the background"],
  ] as const) {
    program.addCommand(
      new Command(commandName)
        .description(description)
        .argument("[args...]", "arguments forwarded to the pinned Graphiti MCP server")
        .action(async (args: string[], _options: unknown, command: Command) => {
          await dependencies.run(commandName, graphitiOptions(command, args));
        }),
    );
  }
  for (const [commandName, description] of [
    ["down", "Stop Graphiti, the model gateway, and Neo4j"],
    ["status", "Show native process and endpoint status"],
    ["env", "Print resolved runtime and connection settings"],
  ] as const) {
    program.addCommand(
      new Command(commandName).description(description).action(async (_options, command) => {
        await dependencies.run(commandName, graphitiOptions(command));
      }),
    );
  }

  program.hook("preAction", async (_command, action) => {
    if (action.name() === "install") {
      const options = graphitiOptions(action);
      await (dependencies.prepare ?? ensureGraphitiPython)(resolveGraphitiOptions(options).python);
    }
  });
  program.addCommand(
    buildServiceCommand(
      () => graphitiServiceDefinition(graphitiOptions(program)),
      dependencies.service,
    ),
  );
  return program;
}

function addGraphitiOptions(command: Command): Command {
  return command
    .addOption(
      new Option("--python <python>", "Python executable used to run Graphiti")
        .env("PYTHON")
        .default(GRAPHITI_DEFAULTS.python),
    )
    .addOption(
      new Option("--profile <profile>", "Databricks profile used for models and persistence").env(
        "DATABRICKS_CONFIG_PROFILE",
      ),
    )
    .addOption(
      new Option("--home <directory>", "Graphiti runtime and data directory").env(
        "DBX_GRAPHITI_HOME",
      ),
    )
    .addOption(
      new Option("--model <model>", "Fuzzy chat-model name or endpoint")
        .env("MODEL_NAME")
        .default(GRAPHITI_DEFAULTS.model),
    )
    .addOption(
      new Option("--embedder-model <model>", "Fuzzy embedding-model name or endpoint")
        .env("EMBEDDER_MODEL")
        .default(GRAPHITI_DEFAULTS.embedderModel),
    )
    .addOption(
      integerOption(
        "--embedder-dimensions <dimensions>",
        "Embedding vector dimensions",
        "EMBEDDER_DIMENSIONS",
      ).default(GRAPHITI_DEFAULTS.embedderDimensions),
    )
    .addOption(
      new Option(
        "--model-gateway-url <url>",
        "Existing OpenAI-compatible gateway URL including /v1",
      ).env("MODEL_GATEWAY_URL"),
    )
    .addOption(
      new Option("--model-gateway-host <host>", "Managed model-gateway listener host")
        .env("MODEL_GATEWAY_HOST")
        .default(GRAPHITI_DEFAULTS.modelGatewayHost),
    )
    .addOption(
      integerOption(
        "--model-gateway-port <port>",
        "Managed model-gateway listener port",
        "MODEL_GATEWAY_PORT",
      ).default(GRAPHITI_DEFAULTS.modelGatewayPort),
    )
    .addOption(
      new Option(
        "--model-gateway-command <command>",
        "Command used to start the managed model gateway",
      ).env("MODEL_GATEWAY_COMMAND"),
    )
    .addOption(
      new Option("--manage-model-gateway", "Start and stop a local model gateway").env(
        "MANAGE_MODEL_GATEWAY",
      ),
    )
    .option("--no-manage-model-gateway", "Use an existing model gateway")
    .addOption(
      new Option("--openai-api-key <key>", "API key for an external OpenAI-compatible gateway").env(
        "OPENAI_API_KEY",
      ),
    )
    .addOption(
      new Option("--structured-output-mode <mode>", "Graphiti OpenAI structured-output mode")
        .env("LLM_STRUCTURED_OUTPUT_MODE")
        .default(GRAPHITI_DEFAULTS.structuredOutputMode),
    )
    .addOption(
      new Option("--graphiti-host <host>", "Graphiti MCP listener host")
        .env("GRAPHITI_HOST")
        .default(GRAPHITI_DEFAULTS.graphitiHost),
    )
    .addOption(
      integerOption(
        "--graphiti-port <port>",
        "Graphiti MCP listener port",
        "GRAPHITI_PORT",
      ).default(GRAPHITI_DEFAULTS.graphitiPort),
    )
    .addOption(
      integerOption(
        "--proxy-port <port>",
        "AppKit reverse-proxy listener port",
        "PROXY_PORT",
      ).default(GRAPHITI_DEFAULTS.proxyPort),
    )
    .addOption(
      new Option("--journal-namespace <namespace>", "Graphiti write-journal namespace").env(
        "JOURNAL_NAMESPACE",
      ),
    )
    .addOption(
      new Option("--journal-database-url <url>", "Explicit PostgreSQL write-journal URL").env(
        "JOURNAL_DATABASE_URL",
      ),
    )
    .addOption(
      new Option("--journal-table <table>", "PostgreSQL write-journal table").env("JOURNAL_TABLE"),
    );
}

function integerOption(flags: string, description: string, environment: string): Option {
  return new Option(flags, description).env(environment).argParser((value) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${flags} must be an integer`);
    return parsed;
  });
}

function graphitiOptions(command: Command, graphitiArgs: readonly string[] = []): GraphitiOptions {
  const { openaiApiKey, ...options } = command.optsWithGlobals<
    Omit<GraphitiOptions, "graphitiArgs" | "openAiApiKey"> & { openaiApiKey?: string }
  >();
  return graphitiOptionOverrides({
    ...options,
    ...(openaiApiKey ? { openAiApiKey: openaiApiKey } : {}),
    graphitiArgs: [...graphitiArgs],
  });
}

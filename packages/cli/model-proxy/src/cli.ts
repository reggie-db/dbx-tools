/**
 * `dbx-tools-model-proxy` CLI.
 *
 * Run bare, it serves: a loopback OpenAI-compatible endpoint that fronts
 * Databricks Model Serving with fuzzy model names and per-request auth. `chat`
 * starts that same proxy and hands off to an off-the-shelf terminal client
 * wired to it. `models` lists the resolvable endpoints; `resolve` shows what a
 * fuzzy name snaps to. Auth comes from the standard Databricks SDK resolution
 * (env vars, `--profile`, or `databricks auth login`).
 *
 * Shared flags (`--profile`, `--workspace-host`, `--threshold`, …) are declared
 * on the root *and* redeclared on subcommands for help discoverability. Commander
 * parks the values on the parent when both declare the same flag, so every
 * subcommand action must read {@link Command.optsWithGlobals} - local `opts`
 * alone misses `--profile` (env `DATABRICKS_CONFIG_PROFILE` still worked because
 * the SDK reads that without the CLI flag).
 *
 * @module
 */

import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { classify, type ServingEndpointSummary } from "@dbx-tools/shared-model";
import { Command, CommanderError } from "commander";

import { DatabricksBackend, type BackendOptions } from "./backend.ts";
import { DEFAULT_BIND_HOST, DEFAULT_PORT, resolveRetryConfig } from "./defaults.ts";
import { startProxyServer } from "./server.ts";

/**
 * Default terminal client for `chat`, launched via `bunx`. OpenHarness is an
 * OpenAI-compatible TUI that reads the endpoint straight from the env we inject
 * (`LLM_PROVIDER=openai-compat` + `OPENAI_BASE_URL`), so no config step is
 * needed. Override with `--client` / `PROXY_CHAT_CLIENT`.
 */
const DEFAULT_CHAT_CLIENT = "bunx @alhazmiai/openharness";

/** Shared `--profile` / `--workspace-host` / `--threshold` flags. */
interface CommonOpts {
  profile?: string;
  workspaceHost?: string;
  threshold?: string;
}

/** Shared listen + auth flags for the proxy-starting commands. */
interface ServeOpts extends CommonOpts {
  port: string;
  host: string;
  apiKey?: string;
  /**
   * Commander's negatable-flag value for `--no-retry-429`: `true` by default,
   * `false` once the flag is passed. Off means relay upstream 429s unchanged.
   */
  retry429: boolean;
}

/** Map shared CLI flags onto {@link BackendOptions}. */
function backendOptions(opts: CommonOpts): BackendOptions {
  return {
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.workspaceHost ? { host: opts.workspaceHost } : {}),
    ...(opts.threshold !== undefined ? { threshold: Number(opts.threshold) } : {}),
  };
}

/**
 * Subcommand options merged with parent (root) options. Required for shared
 * flags that are declared on both - Commander stores them on the parent, so
 * the action's local `opts` alone omits `--profile` / `--workspace-host`.
 */
function globalOpts<T>(command: Command): T {
  return command.optsWithGlobals() as T;
}

/** Create the backend and start the proxy from the shared listen flags. */
async function startProxy(
  opts: ServeOpts,
): Promise<{ backend: DatabricksBackend; server: Server; url: string }> {
  const backend = await DatabricksBackend.create(backendOptions(opts));
  const apiKey = opts.apiKey ?? process.env.PROXY_API_KEY;
  // `--no-retry-429` (opts.retry429 === false) is the only explicit override;
  // otherwise resolveRetryConfig layers PROXY_RETRY_* env then the on-default.
  const retry = resolveRetryConfig(opts.retry429 === false ? { enabled: false } : {});
  const { server, url } = await startProxyServer(backend, {
    host: opts.host,
    port: Number(opts.port),
    retry,
    ...(apiKey ? { apiKey } : {}),
  });
  return { backend, server, url };
}

/** Shared auth / fuzzy-match flags added to the root and every subcommand. */
function addAuthOptions(command: Command): Command {
  return command
    .option("--profile <profile>", "Databricks config profile")
    .option("--workspace-host <url>", "override the Databricks workspace host")
    .option("-t, --threshold <n>", "fuzzy match threshold (0..1)");
}

/** Build the `dbx-tools-model-proxy` commander program (no side effects until parsed). */
export function buildProgram(): Command {
  // Serving is the root action, not a subcommand: the bare command runs the
  // proxy, and `chat`/`models`/`resolve` are the named detours off it.
  const program = addAuthOptions(
    new Command()
      .name("dbx-tools-model-proxy")
      .description("Local OpenAI-compatible proxy to Databricks Model Serving.")
      .option("-p, --port <port>", "port to listen on", String(DEFAULT_PORT))
      .option("-H, --host <host>", "address to bind", DEFAULT_BIND_HOST)
      .option("-k, --api-key <key>", "require this bearer token from local clients")
      .option(
        "--no-retry-429",
        "relay upstream 429s instead of retrying with backoff (default: retry)",
      ),
  ).action(async (opts: ServeOpts) => {
    const { backend, url } = await startProxy(opts);
    process.stderr.write(`model-proxy -> ${backend.host}\n`);
    process.stderr.write(`  OpenAI base URL: ${url}/v1\n`);
  });

  addAuthOptions(
    program
      .command("chat")
      .description("Start the proxy and launch a terminal chat client wired to it.")
      .option("-p, --port <port>", "proxy port", String(DEFAULT_PORT))
      .option("-H, --host <host>", "proxy bind host", DEFAULT_BIND_HOST)
      .option("-m, --model <name>", "default model (fuzzy name ok)")
      .option(
        "--no-retry-429",
        "relay upstream 429s instead of retrying with backoff (default: retry)",
      )
      .option(
        "--client <cmd>",
        "terminal chat CLI to launch (run via your shell)",
        process.env.PROXY_CHAT_CLIENT ?? DEFAULT_CHAT_CLIENT,
      ),
  ).action(async (_local: ServeOpts & { model?: string; client: string }, command: Command) => {
    const opts = globalOpts<ServeOpts & { model?: string; client: string }>(command);
    const { backend, server, url } = await startProxy(opts);
    const baseUrl = `${url}/v1`;
    process.stderr.write(
      `model-proxy -> ${backend.host}\n  OpenAI base URL: ${baseUrl}\n  launching: ${opts.client}\n`,
    );
    // Hand off to an off-the-shelf OpenAI-compatible client, pointing it at
    // the proxy via the standard env vars (plus the provider switches a
    // couple of popular CLIs read). `shell: true` lets `--client` carry its
    // own args, e.g. `--client "bunx merlion"`.
    const child = spawn(opts.client, {
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        OPENAI_BASE_URL: baseUrl,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "model-proxy",
        ...(opts.model ? { OPENAI_MODEL: opts.model } : {}),
        LLM_PROVIDER: "openai-compat",
        CLAUDE_CODE_USE_OPENAI: "1",
      },
    });
    child.on("exit", (code) => {
      server.close();
      process.exit(code ?? 0);
    });
    process.on("SIGINT", () => child.kill("SIGINT"));
  });

  addAuthOptions(
    program
      .command("models")
      .description("List resolvable Databricks serving endpoints (as JSON).")
      .option("--chat", "only list chat-capable endpoints"),
  ).action(async (_local: CommonOpts & { chat?: boolean }, command: Command) => {
    const opts = globalOpts<CommonOpts & { chat?: boolean }>(command);
    const backend = await DatabricksBackend.create(backendOptions(opts));
    const endpoints = await backend.models();
    const enriched = endpoints.map(enrichEndpoint);
    const out = opts.chat ? enriched.filter((e) => e.capabilities.chat) : enriched;
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  });

  addAuthOptions(
    program
      .command("resolve")
      .description("Show what a fuzzy model name resolves to (as JSON).")
      .argument("<query...>", "model name / fuzzy search terms"),
  ).action(async (query: string[], _local: CommonOpts, command: Command) => {
    const opts = globalOpts<CommonOpts>(command);
    const backend = await DatabricksBackend.create(backendOptions(opts));
    const search = query.join(" ");
    const resolved = await backend.resolve(search);
    // Same shape as one `models` entry when matched; null when nothing in the
    // catalogue scores within the threshold (caller can fall back to the query).
    if (!resolved.matched) {
      process.stdout.write("null\n");
      return;
    }
    const endpoint = (await backend.models()).find((e) => e.name === resolved.modelId);
    process.stdout.write(
      `${JSON.stringify(endpoint ? enrichEndpoint(endpoint) : null, null, 2)}\n`,
    );
  });

  return program;
}

/** One `models` / `resolve` list entry: endpoint summary + derived capabilities. */
function enrichEndpoint(endpoint: ServingEndpointSummary) {
  return {
    ...endpoint,
    // `chat` = OpenAI chat/completions + Responses; `embedding` = vectors;
    // `tools` = function/tool calls (every chat endpoint here).
    capabilities: classify.endpointCapabilities(endpoint),
  };
}

/** Parse `argv` and run the matching command. Throws {@link CommanderError} on flag errors. */
export async function runCli(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}

export { CommanderError };

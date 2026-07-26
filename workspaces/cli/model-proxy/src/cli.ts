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
 * @module
 */

import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { Command, CommanderError } from "commander";

import { type ServingEndpointSummary } from "@dbx-tools/shared-model";

import { DatabricksBackend, type BackendOptions } from "./backend";
import { DEFAULT_BIND_HOST, DEFAULT_PORT } from "./defaults";
import { startProxyServer } from "./server";

/** Capability flags an endpoint advertises, derived from its task/class. */
interface EndpointCapabilities {
  /** OpenAI chat/completions + Responses (what a chat agent like Codex needs). */
  chat: boolean;
  /** Embedding (vector) endpoint. */
  embedding: boolean;
  /** Function / tool calling. Chat endpoints here support it. */
  tools: boolean;
}

/**
 * Derive an endpoint's capabilities from its Databricks task hint and the
 * classifier's model class. `llm/v1/chat` (and chat-classed endpoints) are
 * chat- and tool-capable; `llm/v1/embeddings` (and embedding-classed) are
 * embedding-only. Keeps capability logic in one place so consumers don't
 * re-derive it from raw strings.
 */
function capabilitiesFor(endpoint: ServingEndpointSummary): EndpointCapabilities {
  const task = endpoint.task;
  const cls = endpoint.class;
  const embedding = task === "llm/v1/embeddings" || cls === "embedding";
  const chat =
    !embedding && (task === "llm/v1/chat" || (typeof cls === "string" && cls.startsWith("chat")));
  return { chat, embedding, tools: chat };
}

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
}

/** Map shared CLI flags onto {@link BackendOptions}. */
function backendOptions(opts: CommonOpts): BackendOptions {
  return {
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.workspaceHost ? { host: opts.workspaceHost } : {}),
    ...(opts.threshold !== undefined ? { threshold: Number(opts.threshold) } : {}),
  };
}

/** Create the backend and start the proxy from the shared listen flags. */
async function startProxy(
  opts: ServeOpts,
): Promise<{ backend: DatabricksBackend; server: Server; url: string }> {
  const backend = await DatabricksBackend.create(backendOptions(opts));
  const apiKey = opts.apiKey ?? process.env.PROXY_API_KEY;
  const { server, url } = await startProxyServer(backend, {
    host: opts.host,
    port: Number(opts.port),
    ...(apiKey ? { apiKey } : {}),
  });
  return { backend, server, url };
}

/** Build the `dbx-tools-model-proxy` commander program (no side effects until parsed). */
export function buildProgram(): Command {
  // Serving is the root action, not a subcommand: the bare command runs the
  // proxy, and `chat`/`models`/`resolve` are the named detours off it.
  const program = new Command()
    .name("dbx-tools-model-proxy")
    .description("Local OpenAI-compatible proxy to Databricks Model Serving.")
    .option("-p, --port <port>", "port to listen on", String(DEFAULT_PORT))
    .option("-H, --host <host>", "address to bind", DEFAULT_BIND_HOST)
    .option("--profile <profile>", "Databricks config profile")
    .option("--workspace-host <url>", "override the Databricks workspace host")
    .option("-t, --threshold <n>", "fuzzy match threshold (0..1)")
    .option("-k, --api-key <key>", "require this bearer token from local clients")
    .action(async (opts: ServeOpts) => {
      const { backend, url } = await startProxy(opts);
      process.stderr.write(`model-proxy -> ${backend.host}\n`);
      process.stderr.write(`  OpenAI base URL: ${url}/v1\n`);
    });

  program
    .command("chat")
    .description("Start the proxy and launch a terminal chat client wired to it.")
    .option("-p, --port <port>", "proxy port", String(DEFAULT_PORT))
    .option("-H, --host <host>", "proxy bind host", DEFAULT_BIND_HOST)
    .option("--profile <profile>", "Databricks config profile")
    .option("--workspace-host <url>", "override the Databricks workspace host")
    .option("-t, --threshold <n>", "fuzzy match threshold (0..1)")
    .option("-m, --model <name>", "default model (fuzzy name ok)")
    .option(
      "--client <cmd>",
      "terminal chat CLI to launch (run via your shell)",
      process.env.PROXY_CHAT_CLIENT ?? DEFAULT_CHAT_CLIENT,
    )
    .action(async (opts: ServeOpts & { model?: string; client: string }) => {
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

  program
    .command("models")
    .description("List resolvable Databricks serving endpoints (as JSON).")
    .option("--profile <profile>", "Databricks config profile")
    .option("--workspace-host <url>", "override the Databricks workspace host")
    .option("--chat", "only list chat-capable endpoints")
    .action(async (opts: CommonOpts & { chat?: boolean }) => {
      const backend = await DatabricksBackend.create(backendOptions(opts));
      const endpoints = await backend.models();
      // Enrich each endpoint with a derived `capabilities` object so consumers
      // filter on capability rather than re-deriving it from raw `task`/`class`
      // strings. `chat` = OpenAI chat/completions + Responses (what an agent
      // like Codex needs); `embedding` = vector endpoints; `tools` = whether the
      // endpoint supports function/tool calls (all chat endpoints here do).
      const enriched = endpoints.map((endpoint) => {
        const caps = capabilitiesFor(endpoint);
        return { ...endpoint, capabilities: caps };
      });
      const out = opts.chat ? enriched.filter((e) => e.capabilities.chat) : enriched;
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    });

  program
    .command("resolve")
    .description("Show what a fuzzy model name resolves to (as JSON).")
    .argument("<query...>", "model name / fuzzy search terms")
    .option("--profile <profile>", "Databricks config profile")
    .option("--workspace-host <url>", "override the Databricks workspace host")
    .option("-t, --threshold <n>", "fuzzy match threshold (0..1)")
    .action(async (query: string[], opts: CommonOpts) => {
      const backend = await DatabricksBackend.create(backendOptions(opts));
      const resolved = await backend.resolve(query.join(" "));
      process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    });

  return program;
}

/** Parse `argv` and run the matching command. Throws {@link CommanderError} on flag errors. */
export async function runCli(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}

export { CommanderError };

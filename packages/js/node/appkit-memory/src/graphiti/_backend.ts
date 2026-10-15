/**
 * Lazy Graphiti implementation of the backend-neutral memory contract.
 *
 * @module
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { ConfigurationError } from "@databricks/appkit";
import { openApiTools, type OpenApiTool } from "@dbx-tools/appkit/openapi-tool";
import { profile as authProfile } from "@dbx-tools/auth";
import { configUtils } from "@dbx-tools/core";
import type { ChildProcessResult } from "@dbx-tools/core/exec";
import { z } from "zod";

import {
  type GraphitiMemoryBackend,
  type MemoryTurn,
  type RecallMemoryInput,
  type RecallMemoryResult,
  type RememberMemoryInput,
  type RememberMemoryResult,
} from "../_contracts.ts";
import {
  graphitiOptionOverrides,
  graphitiOptionsFromEnvironment,
  resolveGraphitiOptions,
  type GraphitiOptions,
  type ResolvedGraphitiOptions,
} from "./options.ts";
import {
  createGraphitiChildProcess,
  graphitiHealthCheck,
  graphitiHttpUrl,
  graphitiRequestHeaders,
} from "./runtime.ts";

const GraphitiFactSchema = z
  .object({
    name: z.string().optional().describe("Graphiti fact name."),
    fact: z.string().describe("Retrieved graph fact."),
  })
  .loose()
  .describe("Graphiti fact search result.");

const GraphitiFactSearchSchema = z
  .object({
    facts: z.array(GraphitiFactSchema).optional().describe("Matching graph facts."),
    error: z.string().optional().describe("Graphiti operation error."),
  })
  .loose()
  .describe("Graphiti fact search response.");

const GraphitiWriteSchema = z
  .object({
    message: z.string().optional().describe("Graphiti write confirmation."),
    error: z.string().optional().describe("Graphiti operation error."),
  })
  .loose()
  .describe("Graphiti write response.");

class GraphitiBackend implements GraphitiMemoryBackend {
  constructor(
    private readonly options: ResolvedGraphitiOptions,
    private readonly child: ChildProcessResult,
    private readonly writeTool: OpenApiTool,
    private readonly recallTool: OpenApiTool,
  ) {}

  get running(): boolean {
    return (
      (this.child.exitCode === null || this.child.exitCode === undefined) &&
      (this.child.signalCode === null || this.child.signalCode === undefined)
    );
  }

  async remember(
    actorId: string,
    input: RememberMemoryInput,
    signal?: AbortSignal,
  ): Promise<RememberMemoryResult> {
    await this.write(
      actorId,
      {
        name: input.path,
        episode_body: input.content,
        source: "text",
        source_description: input.description ? `${input.path}: ${input.description}` : input.path,
      },
      signal,
    );
    return {
      backend: "graphiti",
      memory: {
        path: input.path,
        content: input.content,
        ...(input.description ? { description: input.description } : {}),
      },
    };
  }

  async recall(
    actorId: string,
    input: RecallMemoryInput,
    signal?: AbortSignal,
  ): Promise<RecallMemoryResult> {
    const response = GraphitiFactSearchSchema.parse(
      await this.request(
        this.recallTool,
        {
          query: input.query,
          max_facts: input.limit,
          group_ids: [userScope(actorId)],
        },
        signal,
      ),
    );
    if (response.error) throw new Error(response.error);
    return {
      backend: "graphiti",
      memories: (response.facts ?? []).map((fact) => ({
        content: fact.fact,
        ...(fact.name ? { description: fact.name } : {}),
      })),
    };
  }

  async saveTurn(turn: MemoryTurn, signal?: AbortSignal): Promise<void> {
    await this.write(
      turn.actorId,
      {
        name: `Mastra turn ${turn.agentId}/${turn.threadId}`,
        episode_body: `User: ${turn.user}\n\nAssistant: ${turn.assistant}`,
        source: "message",
        source_description: `Completed ${turn.agentId} conversation turn`,
      },
      signal,
    );
  }

  shutdown(): Promise<void> {
    return this.child.shutdown();
  }

  private async write(
    actorId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = GraphitiWriteSchema.parse(
      await this.request(this.writeTool, { ...args, group_id: userScope(actorId) }, signal),
    );
    if (response.error) throw new Error(response.error);
  }

  private async request(
    tool: OpenApiTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.running) throw new Error("Graphiti sidecar is not running");
    const response = await fetch(tool.url, {
      method: tool.method,
      headers: {
        ...graphitiRequestHeaders(this.options),
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Graphiti operation ${tool.id} failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return response.json();
  }
}

/** Start a fully ready Graphiti backend for the first fallback operation. */
export async function startGraphitiBackend(
  options: GraphitiOptions,
  signal?: AbortSignal,
): Promise<GraphitiMemoryBackend> {
  const configured = resolveGraphitiConfig(options);
  if (configured.listen.scheme !== "tcp") {
    throw new Error("AppKit memory requires a TCP Graphiti listener");
  }
  const [graphitiPort] = await distinctPorts(
    configUtils.port(undefined, "DATABRICKS_APP_PORT", 8000, configUtils.ENV_ONLY),
    configured.listen.port,
  );
  const resolved = resolveGraphitiOptions({
    ...configured,
    bearer: randomBytes(32).toString("base64url"),
    listen: { ...configured.listen, port: graphitiPort },
  });
  let tools: OpenApiTool[] | undefined;
  const { child } = await createGraphitiChildProcess({
    ...resolved,
    ...(signal ? { signal } : {}),
    healthCheck: async ({ signal }) => {
      try {
        if (!(await graphitiHealthCheck(resolved, signal))) return false;
        const loaded = await openApiTools(graphitiHttpUrl(resolved, "/openapi.json"), {
          signal,
          headers: graphitiRequestHeaders(resolved),
        });
        tools = [
          requiredOperation(loaded, "add_memory_sync"),
          requiredOperation(loaded, "search_memory_facts"),
        ];
        return true;
      } catch (error) {
        if (signal.aborted) throw error;
        return false;
      }
    },
  });
  if (!tools) {
    await child.shutdown();
    throw new Error("Graphiti OpenAPI tools were not captured during readiness");
  }
  return new GraphitiBackend(resolved, child, tools[0]!, tools[1]!);
}

function resolveGraphitiConfig(options: GraphitiOptions): ResolvedGraphitiOptions {
  const environment = graphitiOptionsFromEnvironment(process.env);
  if (environment.profile && !authProfile.resolveProfile({ profile: environment.profile })) {
    environment.profile = undefined;
  }
  const overrides = graphitiOptionOverrides(options);
  return resolveGraphitiOptions({
    ...environment,
    ...overrides,
    listen: overrides.listen ??
      environment.listen ?? {
        scheme: "tcp",
        host: "127.0.0.1",
        port: 0,
      },
  });
}

function requiredOperation(tools: readonly OpenApiTool[], name: string): OpenApiTool {
  const tool = tools.find(({ id }) => id === name);
  if (!tool) throw new Error(`Graphiti OpenAPI is missing operation: ${name}`);
  return tool;
}

function userScope(userId: string): string {
  return `user_${createHash("sha256").update(userId).digest("base64url")}`;
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a Graphiti loopback port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function distinctPorts(appPort: number, graphitiPort: number): Promise<[number]> {
  const ports = [appPort];
  for (const configuredPort of [graphitiPort]) {
    if (configuredPort && ports.includes(configuredPort)) {
      throw new ConfigurationError("Graphiti sidecar ports must differ from DATABRICKS_APP_PORT");
    }
    let port = configuredPort || (await availablePort());
    while (ports.includes(port)) port = await availablePort();
    ports.push(port);
  }
  return ports.slice(1) as [number];
}

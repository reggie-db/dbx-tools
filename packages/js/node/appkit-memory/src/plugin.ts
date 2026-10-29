/**
 * AppKit memory plugin with Databricks-first tools and lazy Graphiti fallback.
 *
 * @module
 */

import { getExecutionContext, toPlugin, type PluginManifest } from "@databricks/appkit";
import {
  defineTool,
  executeFromRegistry,
  type ToolkitEntry,
  type ToolkitOptions,
  type ToolRegistry,
} from "@databricks/appkit/beta";
import {
  ToolRegistryPlugin,
  type AgentToolExecutionContext,
  tryGetExecutionContext,
  entries,
} from "@dbx-tools/appkit";
import { errorContext, logger } from "@dbx-tools/shared-core";

import {
  RecallMemoryInputSchema,
  RememberMemoryInputSchema,
  type GraphitiMemoryBackend,
  type MemoryTurn,
  type RecallMemoryInput,
  type RecallMemoryResult,
  type RememberMemoryInput,
  type RememberMemoryResult,
} from "./_contracts.ts";
import {
  MEMORY_CONFIG_SCHEMA,
  resolveMemoryPluginConfig,
  type MemoryPluginConfig,
  type ResolvedMemoryPluginConfig,
} from "./config.ts";
import { DatabricksMemoryRuntime } from "./databricks/_runtime.ts";

/** AppKit memory plugin with Databricks managed memory and Graphiti fallback. */
export class MemoryPlugin extends ToolRegistryPlugin<MemoryPluginConfig> {
  static phase = "deferred" as const;
  static manifest: PluginManifest<"memory"> = {
    name: "memory",
    displayName: "Memory",
    description: "Publishes Databricks-first durable memory tools with a lazy Graphiti fallback.",
    stability: "beta",
    resources: { required: [], optional: [] },
    config: { schema: MEMORY_CONFIG_SCHEMA },
  };

  private readonly logger = logger(this);
  private resolved?: ResolvedMemoryPluginConfig;
  private databricks?: DatabricksMemoryRuntime;
  private graphiti?: GraphitiMemoryBackend;
  private graphitiStarting?: Promise<GraphitiMemoryBackend>;
  private readonly graphitiStartupAbort = new AbortController();
  private closed = false;

  protected get toolRegistry(): ToolRegistry {
    return this.registry();
  }

  override async setup(): Promise<void> {
    const resolved = resolveMemoryPluginConfig(this.config);
    if (resolved.saveTurns === true && resolved.graphiti === false) {
      throw new Error("AppKit memory saveTurns requires the Graphiti fallback");
    }
    this.resolved = resolved;
    if (resolved.databricks) {
      this.databricks = new DatabricksMemoryRuntime(
        getExecutionContext().client,
        resolved.databricks,
      );
    }

    let mastra = false;
    const context = this.context;
    const shouldAttachTurnSaver =
      resolved.saveTurns !== false &&
      resolved.graphiti !== false &&
      context?.hasPlugin("mastra") === true;
    if (shouldAttachTurnSaver && context) {
      const { attachMastraTurnSaver } = await import("./_mastra.ts");
      mastra = await attachMastraTurnSaver(context, (turn, signal) => this.saveTurn(turn, signal));
    }
    if (resolved.saveTurns === true && !mastra) {
      throw new Error("AppKit memory saveTurns requires a registered Mastra plugin");
    }
    this.logger.info("ready", {
      databricks: resolved.databricks !== false,
      graphiti: resolved.graphiti !== false ? "lazy" : false,
      mastraTurnSaver: mastra,
    });
  }

  async toolkit(options?: ToolkitOptions): Promise<Record<string, ToolkitEntry>> {
    return entries("memory", this.getAgentTools(), {
      ...options,
      prefix: options?.prefix ?? "",
    });
  }

  override executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    context?: AgentToolExecutionContext,
  ): Promise<unknown> {
    return executeFromRegistry(this.registry(context?.resourceId), name, args, signal);
  }

  override abortActiveOperations(): void {
    super.abortActiveOperations();
    this.graphitiStartupAbort.abort(new Error("AppKit memory is shutting down"));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.graphitiStartupAbort.abort(new Error("AppKit memory is shutting down"));
    const starting = this.graphitiStarting;
    const backend = this.graphiti;
    this.graphitiStarting = undefined;
    this.graphiti = undefined;
    await starting?.catch(() => undefined);
    await backend?.shutdown();
  }

  private registry(resourceId?: string): ToolRegistry {
    return {
      remember: defineTool({
        description:
          "Save a durable user preference, fact, decision, or instruction for future conversations.",
        schema: RememberMemoryInputSchema,
        annotations: { effect: "write", requiresUserContext: true },
        autoInheritable: false,
        execute: (input, signal) => this.remember(this.actorId(resourceId), input, signal),
      }),
      recall_memory: defineTool({
        description:
          "Search durable actor-scoped memory for facts and preferences relevant to the current task.",
        schema: RecallMemoryInputSchema,
        annotations: { effect: "read", requiresUserContext: true },
        autoInheritable: false,
        execute: (input, signal) => this.recall(this.actorId(resourceId), input, signal),
      }),
    };
  }

  private async remember(
    actorId: string,
    input: RememberMemoryInput,
    signal?: AbortSignal,
  ): Promise<RememberMemoryResult> {
    const databricks = await this.databricksBackend(actorId, signal);
    if (databricks) {
      try {
        return await databricks.remember(actorId, input, signal);
      } catch (error) {
        if (!this.shouldFallbackFromDatabricks(error)) throw error;
      }
    }
    return (await this.graphitiBackend()).remember(actorId, input, signal);
  }

  private async recall(
    actorId: string,
    input: RecallMemoryInput,
    signal?: AbortSignal,
  ): Promise<RecallMemoryResult> {
    const parsed = RecallMemoryInputSchema.parse(input);
    const databricks = await this.databricksBackend(actorId, signal);
    if (databricks) {
      try {
        return await databricks.recall(actorId, parsed, signal);
      } catch (error) {
        if (!this.shouldFallbackFromDatabricks(error)) throw error;
      }
    }
    return (await this.graphitiBackend()).recall(actorId, parsed, signal);
  }

  private async saveTurn(turn: MemoryTurn, signal?: AbortSignal): Promise<void> {
    if (await this.databricksBackend(turn.actorId, signal)) return;
    const saveTurns = this.requireConfig().saveTurns;
    if (saveTurns !== true && !this.graphiti?.running && !this.graphitiStarting) return;
    await (await this.graphitiBackend()).saveTurn(turn, signal);
  }

  private async databricksBackend(
    actorId: string,
    signal?: AbortSignal,
  ): Promise<DatabricksMemoryRuntime | undefined> {
    const backend = this.databricks;
    if (!backend) return undefined;
    if (await backend.available(actorId, signal)) return backend;
    const configured = this.requireConfig().databricks;
    if (configured && configured.mode === "required") {
      throw new Error("Required Databricks managed memory is unavailable for the current actor");
    }
    return undefined;
  }

  private shouldFallbackFromDatabricks(error: unknown): boolean {
    const configured = this.requireConfig().databricks;
    return (
      configured !== false &&
      configured.mode === "auto" &&
      errorContext(error).hasStatusCode(403, 404)
    );
  }

  private async graphitiBackend(): Promise<GraphitiMemoryBackend> {
    if (this.closed) throw new Error("AppKit memory is closed");
    if (this.graphiti?.running) return this.graphiti;
    if (this.graphiti) {
      await this.graphiti.shutdown();
      this.graphiti = undefined;
    }
    const options = this.requireConfig().graphiti;
    if (!options) throw new Error("Graphiti fallback is disabled");
    this.graphitiStarting ??= import("./graphiti/_backend.ts")
      .then(({ startGraphitiBackend }) =>
        startGraphitiBackend(options, this.graphitiStartupAbort.signal),
      )
      .then((backend) => {
        if (this.closed) {
          return backend.shutdown().then(() => {
            throw new Error("AppKit memory closed during Graphiti startup");
          });
        }
        this.graphiti = backend;
        return backend;
      })
      .finally(() => {
        this.graphitiStarting = undefined;
      });
    return this.graphitiStarting;
  }

  private actorId(resourceId?: string): string {
    if (resourceId) return resourceId;
    const context = tryGetExecutionContext();
    if (!context) throw new Error("Memory tools require an AppKit execution context");
    return "userId" in context ? context.userId : context.serviceUserId;
  }

  private requireConfig(): ResolvedMemoryPluginConfig {
    if (!this.resolved) throw new Error("AppKit memory is not initialized");
    return this.resolved;
  }
}

/** AppKit registration factory for {@link MemoryPlugin}. */
export const memory = toPlugin(MemoryPlugin);

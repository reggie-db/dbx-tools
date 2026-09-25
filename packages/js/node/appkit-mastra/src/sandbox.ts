/**
 * Databricks Sandbox adapter for Mastra workspaces.
 *
 * Implements Mastra's foreground command surface over the Databricks Sandbox
 * REST API. Sandboxes are created lazily, retain their home directory across
 * inactivity stops, and execute untrusted shell commands outside the App
 * container.
 *
 * @module
 */

import type { WorkspaceClient } from "@databricks/appkit";
import { databricks } from "@dbx-tools/appkit";
import { async, error, log, string } from "@dbx-tools/shared-core";
import type { RequestContext } from "@mastra/core/request-context";
import type {
  CommandResult,
  ExecuteCommandOptions,
  ProviderStatus,
  SandboxInfo,
  WorkspaceSandbox,
} from "@mastra/core/workspace";
import { z } from "zod";
import { MontySandbox, type MontySandboxOptions } from "./monty-sandbox.ts";

const SANDBOX_API_PATH = "/api/2.0/sandboxes";
const SANDBOX_EXEC_API_PATH = "/api/2.0/sandbox-exec/sandboxes";
const DEFAULT_INACTIVITY_TIMEOUT = "900s";
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const SANDBOX_POLL_INTERVAL_MS = 500;
const logger = log.logger("mastra/sandbox");

const SandboxStateSchema = z.object({
  state: z.string().optional(),
});

const SandboxResponseSchema = z.object({
  name: z.string(),
  display_name: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  status: SandboxStateSchema.optional(),
});

const ExecuteResponseSchema = z.object({
  exit_code: z.number().int().optional(),
  status: z.string(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  command_id: z.string().optional(),
  truncated: z.boolean().optional(),
});

/** Options for one Databricks-backed Mastra sandbox. */
export interface DatabricksSandboxOptions {
  /** AppKit workspace client used for every sandbox API call. */
  client: WorkspaceClient;
  /** Resource id, with or without the `sandboxes/` prefix. */
  sandboxId: string;
  /** Human-readable Databricks label. */
  displayName?: string;
  /** Server-side idle timeout in protobuf duration form. Defaults to `900s`. */
  inactivityTimeout?: string;
  /** Maximum time to wait for the sandbox to become runnable. */
  startupTimeoutMs?: number;
  /** Default command timeout. Per-call `options.timeout` wins. */
  commandTimeoutMs?: number;
  /**
   * Provider used only when Databricks Sandbox is definitively unavailable.
   * Defaults to the Node Pydantic Monty runtime; `false` fails instead.
   */
  fallback?: false | "monty" | MontySandboxOptions | WorkspaceSandbox;
}

/** Databricks options accepted by the higher-level workspace factory. */
export interface DatabricksWorkspaceSandboxOptions extends Omit<
  DatabricksSandboxOptions,
  "client" | "sandboxId"
> {
  /** Provider discriminator. Defaults to `databricks`. */
  provider?: "databricks";
  /**
   * Credential source. Defaults to a fresh AppKit client using the normal
   * environment/profile chain, which is the app service principal in a
   * Databricks App.
   */
  client?: WorkspaceClient | ((context: { requestContext: RequestContext }) => WorkspaceClient);
  /**
   * Fixed id or per-request resolver. Omit to derive a stable, opaque id from
   * the workspace and attributed user.
   */
  sandboxId?: string | ((context: { requestContext: RequestContext }) => string);
}

/** Mastra sandbox backed by Databricks serverless Sandbox compute. */
export class DatabricksSandbox implements WorkspaceSandbox {
  readonly id: string;
  readonly name: string;
  status: ProviderStatus = "pending";
  error?: string;

  private readonly client: WorkspaceClient;
  private readonly displayName: string;
  private readonly inactivityTimeout: string;
  private readonly startupTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly fallbackConfig: Exclude<DatabricksSandboxOptions["fallback"], undefined>;
  private readonly createdAt = new Date();
  private remoteCreatedAt?: Date;
  private lastUsedAt?: Date;
  private activeFallback?: WorkspaceSandbox;
  private startPromise?: Promise<void>;

  constructor(options: DatabricksSandboxOptions) {
    const id = string.trimToNull(options.sandboxId.replace(/^sandboxes\//, ""));
    if (!id) throw new TypeError("Databricks sandbox id must not be blank");
    this.id = id;
    this.name = options.displayName?.trim() || `Mastra sandbox ${id}`;
    this.client = options.client;
    this.displayName = this.name;
    this.inactivityTimeout = options.inactivityTimeout ?? DEFAULT_INACTIVITY_TIMEOUT;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.fallbackConfig = options.fallback ?? "monty";
  }

  get provider(): string {
    return this.activeFallback?.provider ?? "databricks";
  }

  /** Ensure the remote sandbox exists and has reached its running state. */
  async start(): Promise<void> {
    await this.startWithSignal();
  }

  private async startWithSignal(signal?: AbortSignal): Promise<void> {
    if (this.status === "running") return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    const pending = this.performStart(signal);
    this.startPromise = pending;
    try {
      await pending;
    } finally {
      if (this.startPromise === pending) this.startPromise = undefined;
    }
  }

  private async performStart(signal?: AbortSignal): Promise<void> {
    if (this.activeFallback) {
      await this.activeFallback.start?.();
      this.status = this.activeFallback.status;
      return;
    }
    this.status = "starting";
    this.error = undefined;
    try {
      let sandbox = await this.getOrCreate(signal);
      if (sandbox.status?.state === "SANDBOX_STATE_STOPPED") {
        sandbox = await this.mutate("start", signal);
      }
      if (sandbox.status?.state === "SANDBOX_STATE_STOPPING") {
        await this.waitForState("SANDBOX_STATE_STOPPED", signal);
        sandbox = await this.mutate("start", signal);
      }
      if (sandbox.status?.state !== "SANDBOX_STATE_RUNNING") {
        await this.waitForState("SANDBOX_STATE_RUNNING", signal);
      }
      this.status = "running";
      this.lastUsedAt = new Date();
    } catch (caught) {
      if (this.fallbackConfig !== false && isDatabricksSandboxUnavailable(caught)) {
        const fallback = resolveFallback(this.fallbackConfig);
        logger.warn("Databricks Sandbox unavailable; using fallback", {
          sandboxId: this.id,
          fallback: fallback.provider,
          error: error.errorMessage(caught),
        });
        await fallback.start?.();
        this.activeFallback = fallback;
        this.status = fallback.status;
        this.error = fallback.error;
        return;
      }
      this.status = "error";
      this.error = error.errorMessage(caught);
      throw caught;
    }
  }

  /** Databricks home persistence is not a cloneable Mastra checkpoint. */
  async snapshot(): Promise<void> {
    await this.activeFallback?.snapshot();
  }

  get supportsCheckpoints(): boolean {
    return this.activeFallback?.supportsCheckpoints ?? false;
  }

  /** Stop compute while preserving the sandbox home directory. */
  async stop(): Promise<void> {
    if (this.activeFallback) {
      await this.activeFallback.stop?.();
      this.status = this.activeFallback.status;
      return;
    }
    if (this.status === "stopped" || this.status === "destroyed") return;
    this.status = "stopping";
    try {
      await this.mutate("stop");
      this.status = "stopped";
    } catch (caught) {
      if (isStatus(caught, 404)) {
        this.status = "stopped";
        return;
      }
      this.status = "error";
      this.error = error.errorMessage(caught);
      throw caught;
    }
  }

  /** Permanently delete the sandbox and its persisted home directory. */
  async destroy(): Promise<void> {
    if (this.activeFallback) {
      await this.activeFallback.destroy?.();
      this.status = this.activeFallback.status;
      return;
    }
    if (this.status === "destroyed") return;
    this.status = "destroying";
    try {
      await this.request(`${this.resourcePath}`, "DELETE", z.object({}).passthrough());
      this.status = "destroyed";
    } catch (caught) {
      if (isStatus(caught, 404)) {
        this.status = "destroyed";
        return;
      }
      this.status = "error";
      this.error = error.errorMessage(caught);
      throw caught;
    }
  }

  /** Execute one foreground shell command in the remote sandbox. */
  async executeCommand(
    command: string,
    args: string[] = [],
    options: ExecuteCommandOptions = {},
  ): Promise<CommandResult> {
    await this.startWithSignal(options.abortSignal);
    if (this.activeFallback) {
      if (!this.activeFallback.executeCommand) {
        return {
          command,
          args,
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: `Fallback sandbox ${this.activeFallback.provider} does not support command execution.`,
          executionTimeMs: 0,
        };
      }
      return this.activeFallback.executeCommand(command, args, options);
    }
    const timeout = options.timeout ?? this.commandTimeoutMs;
    const script = commandScript(command, args, options.cwd);
    const started = performance.now();
    const response = await this.request(
      `${SANDBOX_EXEC_API_PATH}/${encodeURIComponent(this.id)}/exec-sync`,
      "POST",
      ExecuteResponseSchema,
      {
        payload: {
          cmd: "/bin/bash",
          args: ["-lc", script],
          envs: definedEnvironment(options.env),
          execution_timeout: `${Math.max(1, Math.ceil(timeout / 1_000))}s`,
        },
        signal: options.abortSignal,
      },
    );
    const stdout = response.stdout ?? "";
    const stderr = response.stderr ?? "";
    options.onStdout?.(stdout);
    options.onStderr?.(stderr);
    this.lastUsedAt = new Date();
    const timedOut = response.status === "EXECUTE_COMMAND_STATUS_TIMED_OUT";
    const exitCode = response.exit_code ?? -1;
    return {
      command,
      args,
      success: response.status === "EXECUTE_COMMAND_STATUS_COMPLETED" && exitCode === 0,
      exitCode,
      stdout,
      stderr,
      executionTimeMs: performance.now() - started,
      ...(timedOut ? { timedOut: true, killed: true } : {}),
      ...(response.truncated
        ? {
            stdoutTruncated: true,
            stderrTruncated: true,
          }
        : {}),
    };
  }

  /** Whether the adapter currently knows the remote sandbox to be running. */
  async isReady(): Promise<boolean> {
    if (this.activeFallback) {
      return this.activeFallback.isReady?.() ?? this.activeFallback.status === "running";
    }
    if (this.status === "running") return true;
    try {
      const sandbox = await this.get();
      this.status =
        sandbox.status?.state === "SANDBOX_STATE_RUNNING" ? "running" : remoteStatus(sandbox);
      return this.status === "running";
    } catch (caught) {
      if (isStatus(caught, 404)) return false;
      throw caught;
    }
  }

  /** Report Mastra-facing sandbox metadata. */
  async getInfo(): Promise<SandboxInfo> {
    if (this.activeFallback) {
      return (
        (await this.activeFallback.getInfo?.()) ?? {
          id: this.activeFallback.id,
          name: this.activeFallback.name,
          provider: this.activeFallback.provider,
          status: this.activeFallback.status,
          createdAt: this.createdAt,
        }
      );
    }
    const sandbox = await this.get();
    this.status = remoteStatus(sandbox);
    return {
      id: this.id,
      name: sandbox.display_name ?? this.name,
      provider: this.provider,
      status: this.status,
      createdAt: this.remoteCreatedAt ?? this.createdAt,
      ...(this.lastUsedAt ? { lastUsedAt: this.lastUsedAt } : {}),
      metadata: {
        resourceName: sandbox.name,
        remoteState: sandbox.status?.state,
        updateTime: sandbox.update_time,
      },
    };
  }

  /** Explain the Databricks execution boundary to the agent. */
  getInstructions(): string {
    return [
      "Commands run in a persistent Databricks serverless sandbox, not in the App container.",
      "Use shell commands normally. The sandbox home directory survives inactivity stops.",
      "If Databricks Sandbox is unavailable, commands fall back to Pydantic Monty and must be Python source.",
      "Databricks Workspace filesystem mounts remain separate unless a command copies data explicitly.",
    ].join(" ");
  }

  private get resourcePath(): string {
    return `${SANDBOX_API_PATH}/${encodeURIComponent(this.id)}`;
  }

  private async getOrCreate(signal?: AbortSignal) {
    try {
      return await this.get(signal);
    } catch (caught) {
      if (!isStatus(caught, 404)) throw caught;
    }
    try {
      const sandbox = await this.request(SANDBOX_API_PATH, "POST", SandboxResponseSchema, {
        query: { sandbox_id: this.id },
        payload: {
          display_name: this.displayName,
          spec: {
            compute: {
              inactivity_timeout: this.inactivityTimeout,
            },
          },
        },
        signal,
      });
      this.rememberCreatedAt(sandbox.create_time);
      return sandbox;
    } catch (caught) {
      if (!isStatus(caught, 409)) throw caught;
      return this.get(signal);
    }
  }

  private async get(signal?: AbortSignal) {
    const sandbox = await this.request(this.resourcePath, "GET", SandboxResponseSchema, {
      signal,
    });
    this.rememberCreatedAt(sandbox.create_time);
    return sandbox;
  }

  private mutate(operation: "start" | "stop", signal?: AbortSignal) {
    return this.request(`${this.resourcePath}/${operation}`, "POST", SandboxResponseSchema, {
      signal,
    });
  }

  private async waitForState(expected: string, signal?: AbortSignal) {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const sandbox = await this.get(signal);
      if (sandbox.status?.state === expected) return sandbox;
      await async.sleep(SANDBOX_POLL_INTERVAL_MS, signal);
    }
    throw new Error(
      `Databricks sandbox ${this.id} did not reach ${expected} within ${this.startupTimeoutMs}ms`,
    );
  }

  private rememberCreatedAt(value: string | undefined): void {
    if (!value) return;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) this.remoteCreatedAt = parsed;
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST" | "DELETE",
    schema: z.ZodType<T>,
    options: {
      payload?: unknown;
      query?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const response = await this.client.apiClient.request(
      {
        path,
        method,
        query: options.query,
        headers: new Headers({
          Accept: "application/json",
          ...(options.payload === undefined ? {} : { "Content-Type": "application/json" }),
        }),
        raw: false,
        ...(options.payload === undefined ? {} : { payload: options.payload }),
      },
      options.signal ? databricks.toContext(options.signal) : undefined,
    );
    return schema.parse(response);
  }
}

function commandScript(command: string, args: readonly string[], cwd: string | undefined): string {
  const invocation = args.length ? [command, ...args].map(shellQuote).join(" ") : command;
  return cwd ? `cd -- ${shellQuote(cwd)} && ${invocation}` : invocation;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function definedEnvironment(input: NodeJS.ProcessEnv | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function isStatus(caught: unknown, status: number): boolean {
  return error.errorContext(caught).statusCode === status;
}

function remoteStatus(sandbox: z.infer<typeof SandboxResponseSchema>): ProviderStatus {
  switch (sandbox.status?.state) {
    case "SANDBOX_STATE_RUNNING":
      return "running";
    case "SANDBOX_STATE_STOPPED":
      return "stopped";
    case "SANDBOX_STATE_STOPPING":
      return "stopping";
    case "SANDBOX_STATE_PENDING":
      return "starting";
    default:
      return "pending";
  }
}

function resolveFallback(
  configured: Exclude<DatabricksSandboxOptions["fallback"], false | undefined>,
): WorkspaceSandbox {
  if (typeof configured === "object" && "provider" in configured && "status" in configured) {
    return configured;
  }
  return new MontySandbox(configured === "monty" ? {} : configured);
}

function isDatabricksSandboxUnavailable(caught: unknown): boolean {
  const context = error.errorContext(caught);
  return (
    context.statusCode === 404 ||
    context.hasMessage("feature", "disabled") ||
    context.hasMessage("sandbox", "not", "enabled") ||
    context.hasMessage("preview", "not", "enabled") ||
    context.hasMessage("preview", "unavailable") ||
    context.hasMessage("preview", "disabled")
  );
}

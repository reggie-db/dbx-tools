import {
  ConfigurationError,
  createWorkspaceClient,
  type WorkspaceClient,
} from "@databricks/appkit";
import { MASTRA_USER_KEY, type User } from "@dbx-tools/appkit-mastra";
import type { SshMachine } from "@dbx-tools/shared-databricks-sandbox";
import type { RequestContext } from "@mastra/core/request-context";
import {
  MastraSandbox,
  type CommandResult,
  type ExecuteCommandOptions,
  type SandboxInfo,
  type SandboxStartOptions,
  type SandboxStartResult,
  type WorkspaceSandbox,
  type WorkspaceSandboxResolver,
} from "@mastra/core/workspace";
import type { SshRuntime } from "./runtime.ts";

const ROUTING_INSTRUCTIONS = `Call list_ssh_machines first and use only a returned machine id. Reuse that machine's existing project from the Lakebase-backed projects list when one matches; pass its projectId to add_ssh_project. Use add_ssh_project before creating persistent project files. The tool generates a unique name, path, and port when omitted, creates /home/sandbox-user/projects/<path>, writes mise.toml, and returns the directory plus route fields when enabled. Set route: false for projects that do not serve HTTP. Declare built-in requirements such as desktop through the typed serviceDependencies option; the runtime waits for those services outside the project mise configuration. Re-call add_ssh_project with projectId to update any project field.

For mise, prefer the first-class tools, postinstall, and uninstall options. Use config only for additional canonical mise fields described by https://mise.jdx.dev/schema/mise.json. First-class fields merge over conflicting config.tools, config.hooks.postinstall, and config.tasks.uninstall values. The runtime injects PROJECT_NAME, PROJECT_PATH, and PROJECT_PORT. postinstall may install, prepare, or intentionally start a workload that remains active until uninstall. Expensive setup must use a check-lock-check pattern and a completion marker. Project install is idempotent and serialized through one home-owned lifecycle lock and bounded log. Project removal and reset may automatically call only uninstall; uninstall is idempotent, preempts any active install instead of waiting, then terminates remaining *.pid processes and processes whose cwd is the project directory. Never assume start or stop runs automatically.

All public commands, projects, terminals, and service lifecycle run as the locked non-sudo user sandbox-user with home /home/sandbox-user. Before running a project task, call execute_ssh_command from the returned directory with command: "sh" and args: ["-lc", "$HOME/.local/bin/mise tasks ls --name-only --hidden"]. Invoke only a task whose purpose and invocation point are defined by the applicable skill, using command: "sh" and args: ["-lc", "$HOME/.local/bin/mise run <task>"]. Never combine an executable and its arguments in command. Opening the built-in terminal for a project activates that project's interactive mise shell without global directory activation.

SSH commands never inherit authentication injected into the Sandbox machine. The transport clears Databricks environment variables, disables agent forwarding, and ignores the default Databricks config file before running remote code. Generic execute_ssh_command env overlays cannot restore Databricks credentials. Databricks access from a Sandbox requires a dedicated app-mediated capability that obtains the current user's short-lived OBO authorization for that operation; never expose the app service principal in the Sandbox.

Built-in terminal, desktop, and stats starts return one generic async lifecycle iterator for Mastra and other agent callers; observe starting, the current shared home-owned operation log, and then ready or error. The browser observes the same iterator over SSE. Running machine snapshots are the source of truth for built-ins: list_ssh_machines reconnects after an app restart and recovers service state and logs from remote lock/status/log files. Return openUrl only after ready. add_ssh_project waits only for declared serviceDependencies. Removal and reset preserve cleanup safety by preempting an active install, attempting uninstall, then killing recorded pids and processes rooted in the project directory before deletion.

Never return localhost, a direct Sandbox URL, or the loopback port. Use the returned AppKit path and openUrl. Services must use relative asset and API URLs under their assigned path. Always derive ws:// or wss:// from the browser origin for WebSockets. Raw TCP, UDP, and protocols that cannot honor the routed prefix are not supported.`;

/** Options for selecting and naming the SSH-backed Mastra workspace sandbox. */
export interface SshWorkspaceSandboxOptions {
  /**
   * Assigned Sandbox ID or request-scoped resolver. When omitted, a running
   * assigned machine is preferred, followed by the first assigned machine.
   */
  machineId?: string | ((context: { requestContext: RequestContext }) => string | undefined);
  /** Optional display name presented by Mastra instead of the Sandbox name. */
  displayName?: string;
}

/**
 * Mastra workspace sandbox backed by one existing assigned Databricks Sandbox.
 *
 * Lifecycle and command methods delegate to {@link SshRuntime}, so assignment,
 * authentication fallback, SSH key, and host-verification policy match the
 * AppKit plugin tools and routes.
 */
export class SshWorkspaceSandbox extends MastraSandbox {
  readonly provider = "appkit-sandbox";
  status: WorkspaceSandbox["status"] = "pending";

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly runtime: SshRuntime,
    private readonly client: WorkspaceClient,
    private readonly userId: string,
  ) {
    super({ name });
  }

  /** Starts the assigned Sandbox and reports a connected Mastra outcome. */
  async start(options?: SandboxStartOptions): Promise<SandboxStartResult> {
    await this.withAuth("startMachine", (client) =>
      this.runtime.startMachine(client, this.userId, this.id, options?.abortSignal),
    );
    this.status = "running";
    return { outcome: "connected" };
  }

  /** Stops the assigned Sandbox. */
  async stop(): Promise<void> {
    await this.withAuth("stopMachine", (client) =>
      this.runtime.stopMachine(client, this.userId, this.id),
    );
    this.status = "stopped";
  }

  /** Disconnects local session state without deleting the remote Sandbox. */
  async destroy(): Promise<void> {
    this.runtime.disconnect(new DatabricksScope(this.client).value, this.userId, this.id);
    this.status = "destroyed";
  }

  /** Mastra snapshot hook. Databricks Sandboxes do not expose snapshot operations. */
  async snapshot(): Promise<void> {}

  /** Runs a command through the shared runtime and current AppKit request identity. */
  override async executeCommand(
    command: string,
    args: string[] = [],
    options: ExecuteCommandOptions = {},
  ): Promise<CommandResult> {
    return this.withAuth("executeCommand", async (client) => {
      const sshCommand = this.runtime.execute(
        client,
        this.userId,
        {
          machineId: this.id,
          command,
          args,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env
            ? {
                env: Object.fromEntries(
                  Object.entries(options.env).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                  ),
                ),
              }
            : {}),
          ...(options.timeout ? { timeoutMs: options.timeout } : {}),
        },
        options.abortSignal,
      );
      if (options.onStdout) {
        sshCommand.stdout.on("data", (chunk: string) => options.onStdout?.(chunk));
      }
      if (options.onStderr) {
        sshCommand.stderr.on("data", (chunk: string) => options.onStderr?.(chunk));
      }
      const result = await sshCommand.result;
      const stdout = retainCommandOutput(result.stdout, options.maxRetainedBytes);
      const stderr = retainCommandOutput(result.stderr, options.maxRetainedBytes);
      return {
        ...result,
        stdout: stdout.value,
        stderr: stderr.value,
        ...(stdout.droppedBytes > 0
          ? { stdoutTruncated: true, stdoutDroppedBytes: stdout.droppedBytes }
          : {}),
        ...(stderr.droppedBytes > 0
          ? { stderrTruncated: true, stderrDroppedBytes: stderr.droppedBytes }
          : {}),
      };
    });
  }

  /** Returns the latest assigned machine metadata in Mastra's Sandbox shape. */
  async getInfo(): Promise<SandboxInfo> {
    const response = await this.withAuth("listMachines", (client) =>
      this.runtime.listMachines(client, this.userId),
    );
    const machine = response.machines.find((candidate) => candidate.id === this.id);
    if (!machine) throw new Error(`SSH machine ${this.id} no longer exists`);
    this.status = providerStatus(machine.status);
    return {
      id: machine.id,
      name: machine.name,
      provider: this.provider,
      status: this.status,
      createdAt: machine.createdAt ? new Date(machine.createdAt) : new Date(0),
      ...(machine.lastStartedAt ? { lastUsedAt: new Date(machine.lastStartedAt) } : {}),
      metadata: { gatewayHost: machine.gatewayHost, projects: machine.projects },
    };
  }

  /** Returns agent instructions for machine reuse and public route requirements. */
  getInstructions(): string {
    return `Commands run on Databricks Sandbox ${this.id} over SSH. Prefer reusing this existing Sandbox. Create another only when the user explicitly requests a separate Sandbox.\n\n${ROUTING_INSTRUCTIONS}`;
  }

  private withAuth<T>(
    operation: string,
    action: (client: WorkspaceClient) => Promise<T>,
  ): Promise<T> {
    return this.runtime.withAuthFallback(
      { operation, transport: "code-mode", userId: this.userId },
      {
        user: () => action(this.client),
        servicePrincipal: () => action(createWorkspaceClient()),
      },
    );
  }
}

/**
 * Creates a request-scoped Mastra workspace resolver for existing assigned
 * Sandboxes.
 *
 * The resolver never creates a Sandbox. Without an assigned machine, it returns
 * a placeholder that keeps native Code Mode available and rejects only
 * SSH-backed command execution. A configured but unavailable `machineId`
 * produces a Mastra resource-not-found error.
 */
export function sshWorkspaceSandbox(
  runtime: SshRuntime,
  options: SshWorkspaceSandboxOptions = {},
): WorkspaceSandboxResolver {
  return async ({ requestContext }) => {
    const user = requestContext.get(MASTRA_USER_KEY) as User | undefined;
    if (!user) {
      throw ConfigurationError.resourceNotFound(
        "SSH sandbox user context",
        "Invoke Code Mode from an agent turn served by the Mastra plugin.",
      );
    }
    const client = user.executionContext.client as WorkspaceClient;
    const configured =
      typeof options.machineId === "function"
        ? options.machineId({ requestContext })
        : options.machineId;
    const machines = await runtime.withAuthFallback(
      { operation: "listMachines", transport: "code-mode", userId: user.id },
      {
        user: () => runtime.listMachines(client, user.id),
        servicePrincipal: () => runtime.listMachines(createWorkspaceClient(), user.id),
      },
    );
    const machine = configured
      ? machines.machines.find((candidate) => candidate.id === configured)
      : preferredMachine(machines.machines);
    if (!machine) {
      if (configured) {
        throw ConfigurationError.resourceNotFound(
          "existing SSH machine",
          `No Databricks Sandbox named ${configured} exists.`,
        );
      }
      return new MissingSshWorkspaceSandbox();
    }
    return new SshWorkspaceSandbox(
      machine.id,
      options.displayName ?? machine.name,
      runtime,
      client,
      user.id,
    );
  };
}

class MissingSshWorkspaceSandbox extends MastraSandbox {
  readonly id = "unassigned";
  readonly name = "Databricks Sandbox unavailable";
  readonly provider = "appkit-sandbox";
  status: WorkspaceSandbox["status"] = "stopped";

  constructor() {
    super({ name: "Databricks Sandbox unavailable" });
  }

  async snapshot(): Promise<void> {}

  override async executeCommand(): Promise<CommandResult> {
    throw new Error(
      "No Databricks Sandbox exists for this user. Continue with direct tools and native Code Mode; reuse or create a Sandbox only for an explicitly requested SSH-backed operation.",
    );
  }

  getInstructions(): string {
    return `No Databricks Sandbox currently exists for this user. Continue normal chat, direct tool calls, and native Code Mode; QuickJS or isolated-vm orchestration does not require SSH. Do not create a Sandbox merely to enable code execution. If the user explicitly requests an SSH-backed Sandbox operation, list Sandboxes first and prefer an existing one.\n\nIf a Sandbox is created and starts a web service, follow these routing requirements:\n${ROUTING_INSTRUCTIONS}`;
  }
}

function preferredMachine(machines: SshMachine[]): SshMachine | undefined {
  return machines.find((machine) => machine.status === "running") ?? machines[0];
}

function providerStatus(status: SshMachine["status"]): WorkspaceSandbox["status"] {
  return status === "unknown" ? "pending" : status;
}

function retainCommandOutput(
  output: string,
  maxRetainedBytes: number | undefined,
): { value: string; droppedBytes: number } {
  if (maxRetainedBytes === undefined || maxRetainedBytes === Infinity) {
    return { value: output, droppedBytes: 0 };
  }
  const limit = Number.isFinite(maxRetainedBytes) ? Math.max(0, Math.floor(maxRetainedBytes)) : 0;
  const bytes = Buffer.from(output);
  if (bytes.length <= limit) return { value: output, droppedBytes: 0 };
  let retainedStart = bytes.length - limit;
  while (retainedStart < bytes.length && (bytes[retainedStart]! & 0xc0) === 0x80) {
    retainedStart++;
  }
  return {
    value: bytes.subarray(retainedStart).toString("utf8"),
    droppedBytes: retainedStart,
  };
}

class DatabricksScope {
  readonly value: string;
  constructor(client: WorkspaceClient) {
    this.value = client.config.workspaceId || client.config.host || "workspace";
  }
}

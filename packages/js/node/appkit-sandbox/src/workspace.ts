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

const ROUTING_INSTRUCTIONS = `Call list_ssh_machines first and use only a returned machine id. Reuse that machine's existing project from the Lakebase-backed projects list when one matches; pass its projectId to add_ssh_project. Use add_ssh_project before creating persistent project files. The tool generates a unique name, path, and port when omitted, creates ~/projects/<path>, writes mise.toml from config, and returns the directory plus route fields when enabled. Set route: false for projects that do not serve HTTP. Declare built-in requirements such as desktop through serviceDependencies; the runtime starts them before setup and injects hidden sandbox:<kind> mise dependencies. Re-call add_ssh_project with projectId to update any project field.

Installation and lifecycle behavior belong in config. Keep hooks.postinstall limited to installation or preparation performed by mise install. Define runtime lifecycle behavior in tasks.start and tasks.stop, and define a visible tasks.uninstall only for additional teardown. Before invoking a project task, use execute_ssh_command from the returned directory with command "sh" and args ["-lc", "\"$HOME/.local/bin/mise\" tasks ls --name-only --hidden"], evaluate the available tasks, and use only the task whose purpose and invocation point are documented by the applicable skill. Invoke one documented task with command "sh" and args ["-lc", "\"$HOME/.local/bin/mise\" run <task>"]. Never pass an executable and its arguments together as command. Prefer mise lifecycle tasks over ad-hoc workload commands. Use execute_ssh_command to write application files in the returned directory, invoke documented mise tasks, and read logs. Start servers detached with nohup and redirected stdin, stdout, and stderr. Use config for tools, dependencies, tasks, hooks, and environment values. PROJECT_NAME, PROJECT_PATH, and PROJECT_PORT are injected into mise.env. Bind HTTP services to 127.0.0.1 and PROJECT_PORT.

For routed projects, return openUrl to the user. For route-less desktop projects, return the ready desktop service openUrl. Never return localhost, 127.0.0.1, 0.0.0.0, or a direct Sandbox URL. Applications should use relative asset and API URLs. Prefer stripPrefix: true unless the application is configured for the full public project path.

WebSocket clients must derive ws:// or wss:// from the public origin and include the project path. Raw TCP, UDP, and servers that cannot operate behind a path prefix are not browser-routable.

remove_ssh_project attempts mise run stop and then mise run uninstall when each task exists, discovering hidden tasks for compatibility, then removes the project route, Lakebase record, and ~/projects/<path> directory. Stopping a Sandbox preserves projects. Deleting or expiring a Sandbox removes its project records.`;

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
    return this.withAuth("executeCommand", (client) =>
      this.runtime.execute(
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
      ),
    );
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

class DatabricksScope {
  readonly value: string;
  constructor(client: WorkspaceClient) {
    this.value = client.config.workspaceId || client.config.host || "workspace";
  }
}

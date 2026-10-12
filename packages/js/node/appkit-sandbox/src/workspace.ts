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

const ROUTING_INSTRUCTIONS = `Remote web services must be exposed through add_ssh_route. Never give the user a localhost, 127.0.0.1, 0.0.0.0, or direct Sandbox URL; those addresses are reachable only inside the Sandbox or AppKit bridge. Bind the remote process to Sandbox loopback, then return the registered AppKit path.

User-created routes are automatically placed beneath a short user-hash prefix. Request a suffix such as /hello-world and use the route returned by add_ssh_route. The hash only prevents path collisions; it is not a security boundary, and the existing authenticated owner checks remain authoritative. Built-in services use reserved paths beneath the Sandbox route root at /sandbox/terminal/<machine-id> and /sandbox/metrics/<machine-id>.

Every service must work behind its registered path. Prefer stripPrefix: true for applications that serve from / and use relative asset/API URLs. Use stripPrefix: false only after configuring the application with the full public base path. Do not emit root-absolute links such as /api or /assets unless the application base path includes the registered route.

WebSockets are supported only through the registered HTTP route's standard Upgrade flow. Browser clients must derive ws:// or wss:// from the current public origin and include the registered route path; never connect to Sandbox loopback directly. With stripPrefix: true, AppKit removes the route prefix from both HTTP and WebSocket requests before forwarding. Raw TCP, UDP, and WebSocket servers that cannot operate behind a path prefix are not browser-routable through add_ssh_route.`;

/** Options for selecting and naming the SSH-backed Mastra workspace sandbox. */
export interface SshWorkspaceSandboxOptions {
  machineId?: string | ((context: { requestContext: RequestContext }) => string | undefined);
  displayName?: string;
}

/** Mastra workspace sandbox backed by one existing Databricks Sandbox. */
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

  async start(options?: SandboxStartOptions): Promise<SandboxStartResult> {
    await this.withAuth("startMachine", (client) =>
      this.runtime.startMachine(client, this.userId, this.id, options?.abortSignal),
    );
    this.status = "running";
    return { outcome: "connected" };
  }

  async stop(): Promise<void> {
    await this.withAuth("stopMachine", (client) =>
      this.runtime.stopMachine(client, this.userId, this.id),
    );
    this.status = "stopped";
  }

  async destroy(): Promise<void> {
    this.runtime.disconnect(new DatabricksScope(this.client).value, this.userId, this.id);
    this.status = "destroyed";
  }

  async snapshot(): Promise<void> {}

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
      metadata: { gatewayHost: machine.gatewayHost, routes: machine.routes },
    };
  }

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

/** Creates a request-scoped Mastra workspace resolver for existing SSH machines. */
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

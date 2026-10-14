import { ConfigurationError } from "@databricks/appkit";
import { MASTRA_USER_KEY, type User } from "@dbx-tools/appkit-mastra";
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
import type { LakeboxRuntime } from "./runtime.ts";

const INSTRUCTIONS = `Commands run on the app's shared Databricks Lakebox as your own locked, non-sudo Linux account with a persistent home. Other users have separate accounts and cannot reach your files or service ports. The Lakebox is created and started on first use and stops after its idle timeout; files and saved services persist.

Run long-lived servers as services, not background commands. Call create_lakebox_service with an OCI image; it starts the service detached, waits until it is ready, and returns openUrl. The runtime injects SERVICE_NAME, SERVICE_PATH, SERVICE_PORT, and PORT. Routed services must listen on 127.0.0.1:$SERVICE_PORT. There is no Docker CLI, daemon, port publishing, privileged mode, or device access. Bind mounts come from your home through the mounts field. Services restart from their saved definition when the Lakebox starts; process memory does not resume.

For a minimal routed Python service:

{
  "name": "hello",
  "image": "docker.io/library/python:3.12-alpine",
  "command": ["python", "-c", "import http.server, os; name=os.environ['SERVICE_NAME']; H=type('H',(http.server.BaseHTTPRequestHandler,),{'do_GET':lambda s:(s.send_response(200),s.send_header('Content-Type','text/plain'),s.end_headers(),s.wfile.write(f'hello from {name}\\\\n'.encode())),'log_message':lambda *a:None}); http.server.ThreadingHTTPServer(('127.0.0.1',int(os.environ['SERVICE_PORT'])),H).serve_forever()"]
}

Terminal and desktop are built-in services: call start_lakebox_service with name "terminal" or "desktop" and return the openUrl. Graphical applications belong on the desktop; never start, stop, or reconfigure the desktop display yourself.

With execute_lakebox_command, pass command "sh" and put the script in args ["-lc", "..."]; never pass an executable and its arguments together as command. Commands never receive Databricks credentials. Never return localhost, a loopback port, or a direct Lakebox URL; use the returned openUrl. Services must use relative asset and API URLs beneath their route. Derive ws:// or wss:// from the browser origin.`;

/** Options for the Lakebox-backed Mastra workspace sandbox. */
export interface LakeboxWorkspaceSandboxOptions {
  /** Optional display name presented by Mastra instead of Lakebox. */
  displayName?: string;
}

/**
 * Mastra workspace sandbox backed by the app Lakebox.
 *
 * Commands run as the requesting user's Lakebox account through the shared
 * {@link LakeboxRuntime}, so identity, credential scrubbing, and transport
 * policy match the AppKit plugin tools and routes.
 */
export class LakeboxWorkspaceSandbox extends MastraSandbox {
  readonly provider = "appkit-lakebox";
  status: WorkspaceSandbox["status"] = "pending";

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly runtime: LakeboxRuntime,
    private readonly identity: string,
  ) {
    super({ name });
  }

  /** Creates or starts the app Lakebox. */
  async start(options?: SandboxStartOptions): Promise<SandboxStartResult> {
    await this.runtime.start(options?.abortSignal);
    this.status = "running";
    return { outcome: "connected" };
  }

  /** Leaves the shared Lakebox running; its platform idle timeout stops it. */
  async stop(): Promise<void> {
    this.status = "stopped";
  }

  /** Releases this handle without changing the shared Lakebox. */
  async destroy(): Promise<void> {
    this.status = "destroyed";
  }

  /** Mastra snapshot hook. Lakeboxes do not expose snapshot operations. */
  async snapshot(): Promise<void> {}

  /** Runs a command as the current user's Lakebox account. */
  override async executeCommand(
    command: string,
    args: string[] = [],
    options: ExecuteCommandOptions = {},
  ): Promise<CommandResult> {
    const execution = this.runtime.execute(
      this.identity,
      {
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
    if (options.onStdout) execution.stdout.on("data", (chunk: string) => options.onStdout?.(chunk));
    if (options.onStderr) execution.stderr.on("data", (chunk: string) => options.onStderr?.(chunk));
    const result = await execution.result;
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
  }

  /** Returns the current Lakebox status in Mastra's sandbox shape. */
  async getInfo(): Promise<SandboxInfo> {
    const summary = await this.runtime.summary(this.identity);
    this.status =
      summary.status === "missing" || summary.status === "unknown" ? "pending" : summary.status;
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      createdAt: new Date(0),
      metadata: { lakeboxId: summary.id, user: summary.user.name, services: summary.services },
    };
  }

  /** Returns agent instructions for services, routes, and command execution. */
  getInstructions(): string {
    return INSTRUCTIONS;
  }
}

/**
 * Creates a request-scoped Mastra workspace resolver for the app Lakebox.
 *
 * Resolution never creates compute; the first command or service does.
 */
export function lakeboxWorkspaceSandbox(
  runtime: LakeboxRuntime,
  options: LakeboxWorkspaceSandboxOptions = {},
): WorkspaceSandboxResolver {
  return async ({ requestContext }) => {
    const user = requestContext.get(MASTRA_USER_KEY) as User | undefined;
    if (!user) {
      throw ConfigurationError.resourceNotFound(
        "Lakebox user context",
        "Invoke Code Mode from an agent turn served by the Mastra plugin.",
      );
    }
    return new LakeboxWorkspaceSandbox(
      runtime.config.application,
      options.displayName ?? "Lakebox",
      runtime,
      user.id,
    );
  };
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

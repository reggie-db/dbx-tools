import type { Duplex } from "node:stream";
import { log } from "@dbx-tools/shared-core";
import type { Client as Ssh2Client, ClientChannel } from "ssh2";
import {
  PooledSshTransport,
  type SshCommandExecution,
  type SshPoolOptions,
  type SshResourceLifecycle,
  type SshTransportOptions,
} from "./_ssh.ts";

const logger = log.logger("appkit-sandbox:ssh2");
const patchedSsh2Protocols = new WeakSet<Ssh2Protocol>();

interface Ssh2Resource {
  readonly client: Ssh2Client;
  alive: boolean;
}

/** Exclusive ssh2 connection pool for commands and direct TCP forwarding. */
export class Ssh2Transport extends PooledSshTransport<Ssh2Resource> {
  readonly kind = "ssh2" as const;
  private readonly connectTimeoutMs: number;

  constructor(options: SshTransportOptions, poolOptions: SshPoolOptions = {}) {
    super(ssh2Lifecycle(options), {
      acquireTimeoutMillis: options.connectTimeoutMs,
      ...poolOptions,
    });
    this.connectTimeoutMs = options.connectTimeoutMs;
  }

  protected runWithResource(
    resource: Ssh2Resource,
    script: string,
    execution: SshCommandExecution,
  ): Promise<number> {
    return executeCommand(resource, script, execution);
  }

  protected connectWithResource(
    resource: Ssh2Resource,
    remoteHost: string,
    remotePort: number,
  ): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`ssh2 forwarding did not open within ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      timeout.unref?.();
      resource.client.forwardOut("127.0.0.1", 0, remoteHost, remotePort, (error, channel) => {
        if (settled) {
          channel?.destroy();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(channel);
      });
    });
  }
}

function ssh2Lifecycle(options: SshTransportOptions): SshResourceLifecycle<Ssh2Resource> {
  const patchMode = options.ssh2Patch ?? "auto";
  const requirePatch = patchMode === "true";
  const patchCommands = requirePatch || (patchMode === "auto" && isNodeDevelopment());
  let initialClient: Ssh2Client | undefined = options.ssh2Client;
  const initialPatched = patchCommands ? patchSsh2ExecWithoutReply(options.ssh2Client) : false;
  if (requirePatch && !initialPatched) {
    options.ssh2Client.destroy();
    throw new Error("Installed ssh2 internals do not support the required exec no-reply patch");
  }
  let logged = false;
  return {
    create: async () => {
      const seeded = initialClient !== undefined;
      const client = initialClient ?? (await options.createSsh2CommandClient());
      initialClient = undefined;
      const resource = trackClient(client);
      const patched = seeded
        ? initialPatched
        : patchCommands
          ? patchSsh2ExecWithoutReply(client)
          : false;
      if (requirePatch && !patched) {
        client.destroy();
        throw new Error("Installed ssh2 internals do not support the required exec no-reply patch");
      }
      if (!logged) {
        logged = true;
        logger.warn("using pooled ssh2 Sandbox transport", {
          patchMode,
          patched,
          nodeEnv: process.env.NODE_ENV,
          transportMode: options.transport ?? "auto",
        });
      }
      return resource;
    },
    destroy: (resource) => closeClient(resource, options.connectTimeoutMs),
    // A remote no-op would consume the connection's only permitted operation.
    test: async (resource) => resource.alive,
  };
}

function trackClient(client: Ssh2Client): Ssh2Resource {
  const resource: Ssh2Resource = { client, alive: true };
  const markClosed = () => {
    resource.alive = false;
  };
  client.once("close", markClosed);
  client.once("error", markClosed);
  return resource;
}

async function closeClient(resource: Ssh2Resource, timeoutMs: number): Promise<void> {
  if (!resource.alive) {
    resource.client.destroy();
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resource.alive = false;
      resolve();
    };
    const timeout = setTimeout(
      () => {
        resource.client.destroy();
        finish();
      },
      Math.min(timeoutMs, 1_000),
    );
    timeout.unref?.();
    resource.client.once("close", finish);
    resource.client.once("error", finish);
    resource.client.end();
  });
}

function executeCommand(
  resource: Ssh2Resource,
  script: string,
  execution: SshCommandExecution,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let channel: ClientChannel | undefined;
    let exitCode: number | undefined;
    let settled = false;
    const cleanup = () => {
      resource.client.removeListener("close", clientClosed);
      resource.client.removeListener("error", clientClosed);
    };
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const clientClosed = () => fail(new Error("ssh2 connection closed during command execution"));
    resource.client.once("close", clientClosed);
    resource.client.once("error", clientClosed);
    execution.setCancel(() => {
      if (settled) return;
      try {
        channel?.signal("KILL");
      } catch {
        // The remote may close the channel before the signal is written.
      }
      finish(130);
      channel?.close();
    });
    if (execution.signal.aborted) {
      finish(130);
      return;
    }
    resource.client.exec(script, (error, openedChannel) => {
      if (error) {
        fail(error);
        return;
      }
      if (settled) {
        openedChannel.close();
        return;
      }
      channel = openedChannel;
      channel.on("data", execution.stdout);
      channel.stderr.on("data", execution.stderr);
      channel.on("exit", (code: number | null) => {
        exitCode = code ?? 1;
      });
      channel.once("error", fail);
      channel.once("close", () => finish(exitCode ?? 1));
    });
  });
}

/** Apply the Databricks gateway exec-request workaround when internals permit it. */
function patchSsh2ExecWithoutReply(client: Ssh2Client): boolean {
  const internals = client as unknown as Ssh2ClientInternals;
  const protocol = internals._protocol;
  const channelManager = internals._chanMgr;
  if (!protocol || typeof protocol.exec !== "function" || !channelManager) {
    return false;
  }
  if (patchedSsh2Protocols.has(protocol)) return true;
  const originalExec = protocol.exec.bind(protocol);
  protocol.exec = (channelId, command) => {
    originalExec(channelId, command, false);
    const channel = Object.values(channelManager._channels).find(
      (candidate) => candidate?.outgoing.id === channelId,
    );
    const callback = channel?._callbacks.shift();
    if (!callback) {
      throw new Error("ssh2 exec callback queue was not available for the no-reply workaround");
    }
    queueMicrotask(() => callback(false));
  };
  patchedSsh2Protocols.add(protocol);
  return true;
}

function isNodeDevelopment(): boolean {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  return nodeEnv === "development" || nodeEnv === "dev";
}

interface Ssh2ExecChannel {
  outgoing: { id: number };
  _callbacks: Array<(hadError: boolean | Error) => void>;
}

interface Ssh2Protocol {
  exec(channelId: number, command: string | Buffer, wantReply?: boolean): void;
}

interface Ssh2ClientInternals {
  _protocol?: Ssh2Protocol;
  _chanMgr?: { _channels: Record<number, Ssh2ExecChannel | undefined> };
}

import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { exec } from "@dbx-tools/core";
import type { ChildProcessResult } from "@dbx-tools/core/exec";
import { errorUtils, log, stringUtils } from "@dbx-tools/shared-core";
import { SocksClient } from "socks";
import {
  PooledSshTransport,
  type SshCommandExecution,
  type SshPoolOptions,
  type SshResourceLifecycle,
  type SshTransportOptions,
} from "./_ssh.ts";

const SOCKS_HOST = "127.0.0.1";
const OPENSSH_HELPER_TIMEOUT_MS = 2_000;
const logger = log.logger("appkit-sandbox:openssh");
const nativeOpenSshSupportByCommand = new Map<string, Promise<boolean>>();
const activeNativeOpenSshProcesses = new Set<ChildProcessResult>();
const parentBoundNativeOpenSshProcesses = new WeakSet<ChildProcessResult>();
let stopParentTerminationSignal: (() => void) | undefined;
let processExitHookInstalled = false;
/** @internal JavaScript watchdog that terminates one child when its parent pipe closes. */
export const OPENSSH_PARENT_WATCH_SOURCE = stringUtils.dedent(
  // ============================================================================
  /*js*/`
    const { spawn } = require("node:child_process");

    const child = spawn(process.argv[1], process.argv.slice(2), {
      stdio: ["ignore", "ignore", "inherit"],
    });
    let stopping = false;
    const stopChild = () => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGKILL");
    };

    process.stdin.resume();
    process.stdin.once("end", stopChild);
    process.stdin.once("close", stopChild);
    child.once("error", (error) => {
      console.error(error);
      process.exit(1);
    });
    child.once("exit", (code, signal) => {
      process.stdin.pause();
      process.exit(code ?? (signal ? 1 : 0));
    });
  `,
  // ============================================================================
);

/** One authenticated native OpenSSH ControlMaster resource. */
export interface OpenSshResource {
  run(script: string, execution: SshCommandExecution): Promise<number>;
  connect(remoteHost: string, remotePort: number): Promise<Duplex>;
  test(): Promise<boolean>;
  close(): Promise<void>;
}

/** Exclusive native OpenSSH ControlMaster pool. */
export class OpenSshTransport extends PooledSshTransport<OpenSshResource> {
  readonly kind = "openssh" as const;

  constructor(
    options: SshTransportOptions,
    command: string,
    poolOptions: SshPoolOptions = {},
    lifecycle: SshResourceLifecycle<OpenSshResource> = openSshLifecycle(options, command),
  ) {
    super(lifecycle, {
      acquireTimeoutMillis: options.connectTimeoutMs,
      ...poolOptions,
    });
  }

  protected runWithResource(
    resource: OpenSshResource,
    script: string,
    execution: SshCommandExecution,
  ): Promise<number> {
    return resource.run(script, execution);
  }

  protected connectWithResource(
    resource: OpenSshResource,
    remoteHost: string,
    remotePort: number,
  ): Promise<Duplex> {
    return resource.connect(remoteHost, remotePort);
  }
}

/** Return whether an executable is OpenSSH and accepts dynamic SOCKS5 forwarding. */
export async function supportsNativeOpenSsh(command = "ssh"): Promise<boolean> {
  const cached = nativeOpenSshSupportByCommand.get(command);
  if (cached) return cached;
  const probe = probeNativeOpenSsh(command);
  nativeOpenSshSupportByCommand.set(command, probe);
  return probe;
}

/** @internal OpenSSH arguments shared by pooled ControlMaster processes. */
export function nativeOpenSshArgs(options: SshTransportOptions): string[] {
  return [
    "-i",
    options.privateKeyPath,
    "-p",
    String(options.port),
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${options.knownHostsPath}`,
    "-o",
    `HostKeyAlias=[${options.host}]:${options.port}`,
    "-o",
    "LogLevel=ERROR",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.ceil(options.connectTimeoutMs / 1_000))}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
}

function openSshLifecycle(
  options: SshTransportOptions,
  command: string,
): SshResourceLifecycle<OpenSshResource> {
  return {
    create: () => NativeOpenSshResource.create(options, command),
    destroy: (resource) => resource.close(),
    test: (resource) => resource.test(),
  };
}

class NativeOpenSshResource implements OpenSshResource {
  private alive = true;
  private closing?: Promise<void>;

  private constructor(
    private readonly options: SshTransportOptions,
    private readonly command: string,
    private readonly directory: string,
    private readonly controlPath: string,
    private readonly socksPort: number,
    private readonly master: ChildProcessResult,
  ) {
    const closed = () => {
      this.alive = false;
    };
    void master.then(closed, closed);
  }

  static async create(
    options: SshTransportOptions,
    command: string,
  ): Promise<NativeOpenSshResource> {
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-ssh-"));
    try {
      const controlPath = join(directory, "control");
      const socksPort = await availableLoopbackPort();
      const target = `${options.username}@${options.connectHost}`;
      const master = trackNativeOpenSshProcess(
        exec.spawn(
          process.execPath,
          [
            "-e",
            OPENSSH_PARENT_WATCH_SOURCE,
            command,
            ...nativeOpenSshArgs(options),
            "-M",
            "-N",
            "-S",
            controlPath,
            "-o",
            "ControlPersist=no",
            "-o",
            "ExitOnForwardFailure=yes",
            "-D",
            `${SOCKS_HOST}:${socksPort}`,
            target,
          ],
          {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "capture",
            trim: false,
            forwardTerminationSignals: false,
          },
        ),
        true,
      );
      const resource = new NativeOpenSshResource(
        options,
        command,
        directory,
        controlPath,
        socksPort,
        master,
      );
      try {
        await resource.waitUntilReady();
        return resource;
      } catch (error) {
        await resource.close();
        throw error;
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async run(script: string, execution: SshCommandExecution): Promise<number> {
    const child = trackNativeOpenSshProcess(
      exec.spawn(
        this.command,
        [
          ...nativeOpenSshArgs(this.options),
          "-S",
          this.controlPath,
          "-o",
          "ControlMaster=no",
          `${this.options.username}@${this.options.connectHost}`,
          script,
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          trim: false,
          forwardTerminationSignals: false,
        },
      ),
    );
    child.stdout?.on("data", execution.stdout);
    child.stderr?.on("data", execution.stderr);
    let shutdown: Promise<void> | undefined;
    execution.setCancel(() => {
      shutdown ??= child.shutdown({ terminateTimeout: 0, killTimeout: 1_000 }).catch((error) => {
        logger.warn("failed to stop native SSH command", { error: errorUtils.toError(error) });
      });
      return shutdown;
    });
    return (await child).exitCode;
  }

  async connect(remoteHost: string, remotePort: number): Promise<Duplex> {
    const connection = await SocksClient.createConnection({
      command: "connect",
      destination: { host: remoteHost, port: remotePort },
      proxy: { host: SOCKS_HOST, port: this.socksPort, type: 5 },
      timeout: this.options.connectTimeoutMs,
      set_tcp_nodelay: true,
    });
    return connection.socket;
  }

  async test(): Promise<boolean> {
    if (!this.alive || this.master.exitCode !== null) return false;
    try {
      return (await this.control("check")).exitCode === 0;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.alive = false;
    this.closing = this.closeResource();
    return this.closing;
  }

  private async closeResource(): Promise<void> {
    try {
      await this.control("exit").catch(() => undefined);
    } finally {
      await this.master.shutdown({ terminateTimeout: 0, killTimeout: 1_000 }).catch((error) =>
        logger.warn("failed to stop native SSH ControlMaster", {
          error: errorUtils.toError(error),
        }),
      );
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.options.connectTimeoutMs;
    while (Date.now() < deadline) {
      if (this.master.exitCode !== null) {
        const result = await this.master;
        throw new Error(
          `Native OpenSSH ControlMaster exited (${result.exitCode}): ${result.stderr.trim()}`,
        );
      }
      if ((await this.test()) && (await canConnectLoopback(this.socksPort))) return;
      await delay(50);
    }
    throw new Error(
      `Native OpenSSH ControlMaster did not become ready within ${this.options.connectTimeoutMs}ms`,
    );
  }

  private control(operation: "check" | "exit") {
    const child = trackNativeOpenSshProcess(
      exec.spawn(
        this.command,
        [
          "-p",
          String(this.options.port),
          "-S",
          this.controlPath,
          "-O",
          operation,
          `${this.options.username}@${this.options.connectHost}`,
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          forwardTerminationSignals: false,
        },
      ),
    );
    return waitForNativeOpenSshChild(child, `ssh -O ${operation}`);
  }
}

async function probeNativeOpenSsh(command: string): Promise<boolean> {
  try {
    const version = await waitForNativeOpenSshChild(
      trackNativeOpenSshProcess(
        exec.spawn(command, ["-V"], {
          stdin: "ignore",
          stdout: "capture",
          stderr: "capture",
          forwardTerminationSignals: false,
        }),
      ),
      "ssh -V",
    );
    const versionOutput = `${version.stdout}\n${version.stderr}`;
    if (version.exitCode !== 0 || !/(?:^|\s)OpenSSH_/m.test(versionOutput)) return false;
    const dynamicForward = await waitForNativeOpenSshChild(
      trackNativeOpenSshProcess(
        exec.spawn(command, ["-G", "-D", `${SOCKS_HOST}:1`, "localhost"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          forwardTerminationSignals: false,
        }),
      ),
      "ssh -G",
    );
    return dynamicForward.exitCode === 0;
  } catch {
    return false;
  }
}

async function waitForNativeOpenSshChild(
  child: ChildProcessResult,
  operation: string,
): Promise<Awaited<ChildProcessResult>> {
  let timeout: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      void child
        .shutdown({ terminateTimeout: 0, killTimeout: 1_000 })
        .then(
          () => reject(new Error(`${operation} timed out after ${OPENSSH_HELPER_TIMEOUT_MS}ms`)),
          (error) => reject(error),
        );
    }, OPENSSH_HELPER_TIMEOUT_MS);
    timeout.unref?.();
  });
  try {
    return await Promise.race([child, timedOut]);
  } finally {
    clearTimeout(timeout!);
  }
}

function trackNativeOpenSshProcess(
  child: ChildProcessResult,
  parentBound = false,
): ChildProcessResult {
  activeNativeOpenSshProcesses.add(child);
  if (parentBound) parentBoundNativeOpenSshProcesses.add(child);
  if (!stopParentTerminationSignal) {
    stopParentTerminationSignal = exec.onParentTerminationSignal(forceStopNativeOpenSshProcesses);
  }
  if (!processExitHookInstalled) {
    processExitHookInstalled = true;
    process.once("exit", forceStopNativeOpenSshProcesses);
  }
  let tracked = true;
  const untrack = () => {
    if (!tracked) return;
    tracked = false;
    child.off("exit", untrack);
    child.off("error", untrack);
    activeNativeOpenSshProcesses.delete(child);
    if (activeNativeOpenSshProcesses.size === 0) {
      stopParentTerminationSignal?.();
      stopParentTerminationSignal = undefined;
      process.off("exit", forceStopNativeOpenSshProcesses);
      processExitHookInstalled = false;
    }
  };
  child.once("exit", untrack);
  child.once("error", untrack);
  return child;
}

function forceStopNativeOpenSshProcesses(): void {
  for (const child of activeNativeOpenSshProcesses) {
    try {
      if (parentBoundNativeOpenSshProcesses.has(child)) child.stdin?.end();
      else child.kill("SIGKILL");
    } catch {
      // The child may have exited between the tracked-state check and kill.
    }
  }
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, SOCKS_HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to allocate a loopback SOCKS5 port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function canConnectLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: SOCKS_HOST, port });
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.unref();
    socket.setTimeout(100, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("connect", () => finish(true));
  });
}

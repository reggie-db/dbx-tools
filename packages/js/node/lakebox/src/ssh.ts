import { PassThrough, type Duplex, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { log, toError } from "@dbx-tools/shared-core";
import type { LakeboxCommandResult } from "@dbx-tools/shared-lakebox";
import { createPool, type Factory, type Options, type Pool } from "generic-pool";
import type { Client as Ssh2Client } from "ssh2";
import type { Ssh2PatchMode, SshTransportMode } from "./transport.ts";

const logger = log.logger("lakebox:ssh-transport");
/** Maximum authenticated resources maintained by each SSH operation pool. */
export const SSH_POOL_MAX = 10;

/** One command execution request after the remote shell script is assembled. */
export interface SshExecutionOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Transport callbacks owned by one live SSH command. */
export interface SshCommandExecution {
  readonly signal: AbortSignal;
  stdout(chunk: Buffer | string): void;
  stderr(chunk: Buffer | string): void;
  setCancel(cancel: () => void | Promise<void>): void;
  follow(command: SshCommand): Promise<number>;
}

/** Live SSH command that streams output and awaits to its numeric exit code. */
export class SshCommand implements Promise<number> {
  readonly [Symbol.toStringTag] = "SshCommand";
  /** Live standard output decoded as UTF-8 strings. */
  readonly stdout: Readable & AsyncIterable<string>;
  /** Live standard error decoded as UTF-8 strings. */
  readonly stderr: Readable & AsyncIterable<string>;
  /** Completed result with captured output, timing, and timeout metadata. */
  readonly result: Promise<LakeboxCommandResult>;
  /** Numeric exit code after completion. */
  exitCode: number | undefined;

  private readonly startedAt = Date.now();
  private readonly stdoutStream = new PassThrough();
  private readonly stderrStream = new PassThrough();
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private readonly abortController = new AbortController();
  private readonly completion: Promise<number>;
  private resolveCompletion!: (exitCode: number) => void;
  private rejectCompletion!: (error: unknown) => void;
  private cancelBackend?: () => void | Promise<void>;
  private cancellation?: Promise<void>;
  private stdoutText = "";
  private stderrText = "";
  private settled = false;
  private timedOut = false;

  /** Creates a command and schedules its asynchronous setup and execution. */
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    options: SshExecutionOptions,
    start: (execution: SshCommandExecution) => Promise<number>,
  ) {
    this.stdoutStream.setEncoding("utf8");
    this.stderrStream.setEncoding("utf8");
    this.stdout = this.stdoutStream as Readable & AsyncIterable<string>;
    this.stderr = this.stderrStream as Readable & AsyncIterable<string>;
    this.completion = new Promise<number>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    this.result = this.completion.then((exitCode) => ({
      success: exitCode === 0 && !this.timedOut,
      exitCode,
      stdout: this.stdoutText,
      stderr: this.stderrText,
      executionTimeMs: Date.now() - this.startedAt,
      ...(this.timedOut ? { timedOut: true } : {}),
      command: this.command,
      args: [...this.args],
    }));
    void this.completion.catch(() => undefined);
    void this.result.catch(() => undefined);

    const externalAbort = () => {
      void this.cancel().catch(() => undefined);
    };
    if (options.signal?.aborted) externalAbort();
    else options.signal?.addEventListener("abort", externalAbort, { once: true });
    const timeout = setTimeout(() => {
      this.timedOut = true;
      void this.cancel(124).catch(() => undefined);
    }, options.timeoutMs);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", externalAbort);
    };
    void this.completion.then(cleanup, cleanup);

    queueMicrotask(() => {
      if (this.settled) return;
      void start({
        signal: this.abortController.signal,
        stdout: (chunk) => this.writeOutput("stdout", chunk),
        stderr: (chunk) => this.writeOutput("stderr", chunk),
        setCancel: (cancel) => {
          this.cancelBackend = cancel;
          if (this.abortController.signal.aborted) {
            void this.invokeCancel().catch(() => undefined);
          }
        },
        follow: (command) => this.follow(command),
      }).then(
        (exitCode) => this.finish(exitCode),
        (error) => this.fail(error),
      );
    });
  }

  /** Cancel the command once. Caller cancellation resolves with exit code 130. */
  cancel(exitCode = 130): Promise<void> {
    if (this.settled) return this.cancellation ?? Promise.resolve();
    if (!this.abortController.signal.aborted) this.abortController.abort();
    const cancellation = this.invokeCancel();
    this.finish(exitCode);
    return cancellation;
  }

  then<TResult1 = number, TResult2 = never>(
    onfulfilled?: ((value: number) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.completion.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<number | TResult> {
    return this.completion.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<number> {
    return this.completion.finally(onfinally ?? undefined);
  }

  private invokeCancel(): Promise<void> {
    if (this.cancellation) return this.cancellation;
    if (!this.cancelBackend) return Promise.resolve();
    const cancelBackend = this.cancelBackend;
    this.cancellation = Promise.resolve()
      .then(() => cancelBackend())
      .then(() => undefined);
    void this.cancellation.catch(() => undefined);
    return this.cancellation;
  }

  private writeOutput(stream: "stdout" | "stderr", chunk: Buffer | string): void {
    if (this.settled) return;
    const decoder = stream === "stdout" ? this.stdoutDecoder : this.stderrDecoder;
    const value = decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    if (!value) return;
    if (stream === "stdout") {
      this.stdoutText += value;
      this.stdoutStream.write(value);
    } else {
      this.stderrText += value;
      this.stderrStream.write(value);
    }
  }

  private async follow(command: SshCommand): Promise<number> {
    this.cancelBackend = () => command.cancel();
    if (this.abortController.signal.aborted) {
      void this.invokeCancel().catch(() => undefined);
    }
    const stdout = this.pipe(command.stdout, (chunk) => this.writeOutput("stdout", chunk));
    const stderr = this.pipe(command.stderr, (chunk) => this.writeOutput("stderr", chunk));
    const exitCode = await command;
    await Promise.all([stdout, stderr]);
    return exitCode;
  }

  private async pipe(stream: AsyncIterable<string>, write: (chunk: string) => void): Promise<void> {
    for await (const chunk of stream) write(chunk);
  }

  private finish(exitCode: number): void {
    if (this.settled) return;
    this.settled = true;
    this.exitCode = exitCode;
    this.closeOutput();
    this.resolveCompletion(exitCode);
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.closeOutput();
    this.rejectCompletion(error);
  }

  private closeOutput(): void {
    const stdoutRemainder = this.stdoutDecoder.end();
    const stderrRemainder = this.stderrDecoder.end();
    if (stdoutRemainder) {
      this.stdoutText += stdoutRemainder;
      this.stdoutStream.write(stdoutRemainder);
    }
    if (stderrRemainder) {
      this.stderrText += stderrRemainder;
      this.stderrStream.write(stderrRemainder);
    }
    this.stdoutStream.end();
    this.stderrStream.end();
  }
}

/** Connection details shared by native OpenSSH and the guarded ssh2 fallback. */
export interface SshTransportOptions {
  host: string;
  connectHost: string;
  port: number;
  username: string;
  privateKeyPath: string;
  knownHostsPath: string;
  connectTimeoutMs: number;
  ssh2Client: Ssh2Client;
  createSsh2CommandClient: () => Promise<Ssh2Client>;
  transport?: SshTransportMode;
  ssh2Patch?: Ssh2PatchMode;
  sshCommand?: string;
}

/** Selected command and remote TCP transport for one verified SSH gateway. */
export interface SshTransport {
  readonly kind: "openssh" | "ssh2";
  run(script: string, execution: SshCommandExecution): Promise<number>;
  connect(remoteHost: string, remotePort: number): Promise<Duplex>;
  close(): Promise<void>;
}

/** Async lifecycle used by both native OpenSSH and ssh2 connection pools. */
export interface SshResourceLifecycle<T> {
  create(): Promise<T>;
  destroy(resource: T): Promise<void>;
  test(resource: T): Promise<boolean>;
}

/** Optional pool overrides used by transport tests and constrained runtimes. */
export type SshPoolOptions = Pick<
  Options,
  | "max"
  | "acquireTimeoutMillis"
  | "idleTimeoutMillis"
  | "evictionRunIntervalMillis"
  | "numTestsPerEvictionRun"
>;

/**
 * Exclusive, single-operation SSH resource pool.
 *
 * The command pool keeps one authenticated resource warm. Forwarding uses a
 * separate zero-minimum pool so long-lived WebSockets cannot consume the warm
 * command connection. Every borrowed resource is destroyed after its command
 * or forwarded stream because the Databricks Russh gateway may accept only one
 * operation during a connection's lifetime.
 */
export abstract class PooledSshTransport<T> implements SshTransport {
  abstract readonly kind: "openssh" | "ssh2";

  private readonly commandPool: Pool<T>;
  private readonly forwardingPool: Pool<T>;
  private readonly activeResources = new Map<T, Pool<T>>();
  private readonly seededResources: T[] = [];
  private lastCreateError: unknown;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;

  protected constructor(
    private readonly lifecycle: SshResourceLifecycle<T>,
    options: SshPoolOptions = {},
  ) {
    const factory: Factory<T> = {
      create: async () => {
        try {
          const resource = this.seededResources.shift() ?? (await lifecycle.create());
          this.lastCreateError = undefined;
          return resource;
        } catch (error) {
          this.lastCreateError = error;
          throw error;
        }
      },
      destroy: (resource) => lifecycle.destroy(resource),
      validate: async (resource) => {
        try {
          return await lifecycle.test(resource);
        } catch {
          return false;
        }
      },
    };
    const defaults: Options = {
      max: options.max ?? SSH_POOL_MAX,
      acquireTimeoutMillis: options.acquireTimeoutMillis ?? 15_000,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      evictionRunIntervalMillis: options.evictionRunIntervalMillis ?? 10_000,
      numTestsPerEvictionRun: options.numTestsPerEvictionRun ?? 3,
      testOnBorrow: true,
      autostart: false,
    };
    this.commandPool = createPool(factory, { ...defaults, min: 1 });
    this.forwardingPool = createPool(factory, { ...defaults, min: 0 });
  }

  /** Starts both pools and waits until one tested command resource is warm. */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`${this.kind} SSH transport is closed`));
    if (this.starting) return this.starting;
    this.starting = this.startPools();
    void this.starting
      .catch(() => this.close())
      .catch((error) =>
        logger.warn("failed to close SSH transport after startup failure", {
          kind: this.kind,
          error: toError(error),
        }),
      );
    return this.starting;
  }

  private async startPools(): Promise<void> {
    if (this.closed) throw new Error(`${this.kind} SSH transport is closed`);
    const resource = await this.lifecycle.create();
    if (this.closed) {
      await this.lifecycle.destroy(resource);
      throw new Error(`${this.kind} SSH transport is closed`);
    }
    this.seededResources.push(resource);
    this.commandPool.start();
    this.forwardingPool.start();
    try {
      const resource = await this.commandPool.acquire();
      await this.commandPool.release(resource);
    } catch (error) {
      throw this.lastCreateError ?? error;
    }
  }

  async run(script: string, execution: SshCommandExecution): Promise<number> {
    const resource = await this.acquire(this.commandPool);
    try {
      if (execution.signal.aborted) return 130;
      return await this.runWithResource(resource, script, execution);
    } finally {
      await this.destroy(this.commandPool, resource);
    }
  }

  async connect(remoteHost: string, remotePort: number): Promise<Duplex> {
    const first = await this.acquire(this.forwardingPool);
    try {
      return await this.connectWithBorrowedResource(first, remoteHost, remotePort);
    } catch (error) {
      await this.destroy(this.forwardingPool, first);
      if (this.closed) throw error;
    }
    const retry = await this.acquire(this.forwardingPool);
    try {
      return await this.connectWithBorrowedResource(retry, remoteHost, remotePort);
    } catch (error) {
      await this.destroy(this.forwardingPool, retry);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.closePools();
    return this.closing;
  }

  protected abstract runWithResource(
    resource: T,
    script: string,
    execution: SshCommandExecution,
  ): Promise<number>;

  protected abstract connectWithResource(
    resource: T,
    remoteHost: string,
    remotePort: number,
  ): Promise<Duplex>;

  private async connectWithBorrowedResource(
    resource: T,
    remoteHost: string,
    remotePort: number,
  ): Promise<Duplex> {
    const stream = await this.connectWithResource(resource, remoteHost, remotePort);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      void this.destroy(this.forwardingPool, resource);
    };
    stream.once("close", dispose);
    stream.once("error", dispose);
    if (stream.destroyed) dispose();
    return stream;
  }

  private async acquire(pool: Pool<T>): Promise<T> {
    if (this.closed) throw new Error(`${this.kind} SSH transport is closed`);
    let resource: T;
    try {
      resource = await pool.acquire();
    } catch (error) {
      throw this.lastCreateError ?? error;
    }
    this.activeResources.set(resource, pool);
    if (this.closed) {
      await this.destroy(pool, resource);
      throw new Error(`${this.kind} SSH transport is closed`);
    }
    return resource;
  }

  private async destroy(pool: Pool<T>, resource: T): Promise<void> {
    if (this.activeResources.get(resource) !== pool) return;
    this.activeResources.delete(resource);
    try {
      await pool.destroy(resource);
    } catch (error) {
      logger.warn("failed to destroy pooled SSH resource", {
        kind: this.kind,
        error: toError(error),
      });
    }
  }

  private async closePools(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const commandDrain = this.commandPool.drain();
    const forwardingDrain = this.forwardingPool.drain();
    await Promise.all(
      [...this.activeResources].map(([resource, pool]) => this.destroy(pool, resource)),
    );
    await Promise.all([commandDrain, forwardingDrain]);
    await Promise.all([this.commandPool.clear(), this.forwardingPool.clear()]);
  }
}

/** Injectable transport constructors used to isolate policy selection in tests. */
export interface SshTransportFactories {
  supportsOpenSsh(command: string): Promise<boolean>;
  createOpenSsh(options: SshTransportOptions, command: string): Promise<SshTransport>;
  createSsh2(options: SshTransportOptions): Promise<SshTransport>;
}

/**
 * Select one SSH transport from resolved policy and keep it for the session.
 * Auto prefers native OpenSSH and otherwise selects ssh2.
 */
export async function createSshTransport(
  options: SshTransportOptions,
  overrides: Partial<SshTransportFactories> = {},
): Promise<SshTransport> {
  const factories = { ...defaultSshTransportFactories, ...overrides };
  const sshCommand = options.sshCommand ?? "ssh";
  const transportMode = options.transport ?? "auto";
  if (transportMode === "ssh2") {
    return factories.createSsh2(options);
  }
  const openSshSupported = await factories.supportsOpenSsh(sshCommand);
  if (transportMode === "openssh" && !openSshSupported) {
    throw new Error("Native OpenSSH with SOCKS5 forwarding is unavailable");
  }
  if (openSshSupported) {
    return factories.createOpenSsh(options, sshCommand);
  }
  if (transportMode !== "auto") {
    throw new Error(`Unsupported SSH transport: ${transportMode}`);
  }
  return factories.createSsh2(options);
}

const defaultSshTransportFactories: SshTransportFactories = {
  supportsOpenSsh: async (command) => {
    const { supportsNativeOpenSsh } = await import("./_ssh_openssh.ts");
    return supportsNativeOpenSsh(command);
  },
  createOpenSsh: async (options, command) => {
    const { OpenSshTransport } = await import("./_ssh_openssh.ts");
    const transport = new OpenSshTransport(options, command);
    try {
      await transport.start();
      return transport;
    } catch (error) {
      await transport.close();
      throw error;
    }
  },
  createSsh2: async (options) => {
    const { Ssh2Transport } = await import("./_ssh_ssh2.ts");
    const transport = new Ssh2Transport(options);
    try {
      await transport.start();
      return transport;
    } catch (error) {
      await transport.close();
      throw error;
    }
  },
};

/**
 * Account that runs one remote command.
 *
 * `user` targets a locked, non-sudo Lakebox account. `root` is reserved for
 * fixed package-owned bootstrap scripts and is never reachable from REST,
 * agent tools, or service definitions.
 */
export type SshCommandIdentity = { kind: "user"; name: string; home: string } | { kind: "root" };

/** @internal Builds a remote command after clearing inherited machine credentials. */
export function sshCommandScript(
  command: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  identity: SshCommandIdentity,
): string {
  assertSafeSshEnvironment(env);
  const root = identity.kind === "root";
  const home = root ? "/root" : identity.home;
  const name = root ? "root" : identity.name;
  const workingDirectory = cwd ?? home;
  const invocation = [command, ...scrubLoginShellCommand(command, args)].map(shellQuote).join(" ");
  const environment = Object.entries({
    HOME: home,
    USER: name,
    LOGNAME: name,
    SHELL: "/bin/bash",
    PWD: workingDirectory,
    PATH: root
      ? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
      : `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    DATABRICKS_CONFIG_FILE: "/dev/null",
    ...env,
  })
    .map(([key, value]) => `${environmentName(key)}=${shellQuote(value)}`)
    .join(" ");
  const run = `cd -- ${shellQuote(workingDirectory)} && ${invocation}`;
  const sudoArgs = root ? ["-n", "-H"] : ["-n", "-H", "-u", name];
  const switched = ["sudo", ...sudoArgs, "--", "env", "-i"].map(shellQuote).join(" ");
  return `${SSH_AUTH_ENVIRONMENT_SCRUB}\nexec ${switched} ${environment} '/bin/sh' '-c' ${shellQuote(run)} </dev/null`;
}

function scrubLoginShellCommand(command: string, args: string[]): string[] {
  const executable = command.split("/").at(-1);
  if (!executable || !["sh", "bash", "zsh"].includes(executable) || args[0] !== "-lc") {
    return args;
  }
  const [flags, script, ...rest] = args;
  if (script === undefined) return args;
  return [flags, `${SSH_AUTH_ENVIRONMENT_SCRUB}\n${script}`, ...rest];
}

const SSH_AUTH_ENVIRONMENT_SCRUB = `for __dbx_tools_name in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'); do
  case "$__dbx_tools_name" in
    DATABRICKS_*|SSH_AUTH_SOCK)
      unset "$__dbx_tools_name"
      ;;
  esac
done
export DATABRICKS_CONFIG_FILE=/dev/null`;

function assertSafeSshEnvironment(env: Readonly<Record<string, string>> | undefined): void {
  for (const name of Object.keys(env ?? {})) {
    if (
      name === "HOME" ||
      name === "USER" ||
      name === "LOGNAME" ||
      name === "SHELL" ||
      name === "PWD" ||
      name === "PATH" ||
      name.startsWith("SUDO_") ||
      name.startsWith("DATABRICKS_") ||
      name === "SSH_AUTH_SOCK"
    ) {
      throw new Error(
        "SSH environment overlays cannot replace the Lakebox identity or restore Databricks or SSH agent credentials.",
      );
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function environmentName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SSH environment variable name: ${value}`);
  }
  return value;
}

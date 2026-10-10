/**
 * Pydantic Monty fallback for Mastra command execution.
 *
 * Prefers Monty's native Node subprocess workers and falls back to its WASM
 * workers when the native package is unavailable. It executes Python source
 * with no host filesystem, network, environment, shell, or third-party package
 * access.
 *
 * @module
 */

import { availableParallelism } from "node:os";
import { configUtils } from "@dbx-tools/core";
import { errorUtils, functionUtils, log } from "@dbx-tools/shared-core";
import type {
  CommandResult,
  ExecuteCommandOptions,
  SandboxInfo,
  MastraSandbox,
  type ProviderStatus,
} from "@mastra/core/workspace";
import type { CheckoutOptions, Monty, MontyCrashedError, MontySession } from "@pydantic/monty";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MEMORY_BYTES = 10_000_000;
const NATIVE_MONTY_TARGET = {
  name: "native Monty",
  load: () => import("@pydantic/monty/node"),
} as const;
const WASM_MONTY_TARGET = {
  name: "WASM Monty",
  load: () => import("@pydantic/monty/wasm"),
} as const;
const logger = log.logger("mastra/monty");

type MontyPool = Pick<Monty, "checkout">;

interface MontyContext {
  crashedError: typeof MontyCrashedError;
  pool: MontyPool;
}

/** @internal Size the shared worker pool from the host's available processors. */
export function montyMaxProcesses(parallelism: number = availableParallelism()): number {
  return Math.max(4, Math.floor(parallelism) * 2);
}

const montyContext = functionUtils.memoize(async (): Promise<MontyContext> => {
  const errors: Error[] = [];
  const targets = configUtils.boolean(undefined, "MONTY_FORCE_WASM")
    ? [WASM_MONTY_TARGET]
    : [NATIVE_MONTY_TARGET, WASM_MONTY_TARGET];
  for (const target of targets) {
    try {
      const module = await target.load();
      logger.debug(`${target.name} module available`);
      const maxProcesses = montyMaxProcesses();
      const pool = await module.Monty.create({
        minProcesses: 1,
        maxProcesses,
        requestTimeout: 35,
      });
      logger.debug(`${target.name} pool created`, { maxProcesses });
      return {
        crashedError: module.MontyCrashedError,
        pool,
      };
    } catch (error) {
      errors.push(errorUtils.toError(error));
      logger.debug(`${target.name} unavailable`, {
        error: errorUtils.errorMessage(error),
      });
    }
  }
  throw new AggregateError(errors, "Failed to create Monty pool");
});

/** Resource controls for the Monty Python fallback. */
export interface MontySandboxOptions {
  /** Mastra provider id. */
  id?: string;
  /** Display name. */
  name?: string;
  /** Default execution timeout. Per-call `options.timeout` wins. */
  commandTimeoutMs?: number;
  /** Maximum Monty heap bytes for one checkout. */
  maxMemoryBytes?: number;
  /** Type-check each Python snippet before running it. Defaults to false. */
  typeCheck?: boolean;
}

/** Python-only, deny-by-default sandbox backed by Monty's selected worker pool. */
export class MontySandbox extends MastraSandbox {
  readonly id: string;
  readonly name: string;
  readonly provider = "monty";
  status: ProviderStatus = "pending";

  private readonly commandTimeoutMs: number;
  private readonly maxMemoryBytes: number;
  private readonly typeCheck: boolean;
  private readonly createdAt = new Date();
  private lastUsedAt?: Date;

  constructor(options: MontySandboxOptions = {}) {
    const name = options.name ?? "Pydantic Monty";
    super({ name });
    this.id = options.id ?? "monty";
    this.name = name;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.maxMemoryBytes = options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
    this.typeCheck = options.typeCheck ?? false;
  }

  /** Warm the shared crash-isolated worker pool. */
  async start(): Promise<void> {
    await montyContext();
  }

  /** The process-wide pool stays warm; this instance carries no open session. */
  async stop(): Promise<void> {}

  /** The process-wide pool stays warm; each command closes its own checkout. */
  async destroy(): Promise<void> {}

  /** Execute Python source and map Monty output to Mastra's command result. */
  async executeCommand(
    command: string,
    args: string[] = [],
    options: ExecuteCommandOptions = {},
  ): Promise<CommandResult> {
    const started = performance.now();
    const code = montyCode(command, args);
    if (code === undefined) {
      return failedResult(
        command,
        args,
        started,
        "Monty fallback accepts Python source directly, or python/python3 with a single -c script.",
      );
    }
    const environment = Object.entries(options.env ?? {}).filter(
      ([, value]) => value !== undefined,
    );
    if (environment.length > 0) {
      return failedResult(
        command,
        args,
        started,
        "Monty fallback does not expose host environment variables.",
      );
    }
    if (options.cwd) {
      return failedResult(
        command,
        args,
        started,
        "Monty fallback does not expose a host working directory.",
      );
    }
    if (options.abortSignal?.aborted) throw options.abortSignal.reason;

    await this.start();
    const timeout = options.timeout ?? this.commandTimeoutMs;
    const pool = (await montyContext()).pool;
    const session = await checkoutSession(
      pool,
      {
        limits: {
          maxFeedDurationSecs: Math.max(0.001, timeout / 1_000),
          maxMemory: this.maxMemoryBytes,
        },
        typeCheck: this.typeCheck,
      },
      options.abortSignal,
    );
    const output = new RetainedOutput(options);
    const workerPid = session.workerPid;
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      terminateWorker(workerPid);
    };
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (options.abortSignal?.aborted) onAbort();
    try {
      if (aborted) throw abortReason(options.abortSignal);
      const value = await session.feedRun(stripPythonFence(code), {
        printCallback: (stream, text) => output.emit(stream, text),
      });
      const returned = formatResult(value);
      if (returned) {
        const suffix = returned.endsWith("\n") ? returned : `${returned}\n`;
        output.emit("stdout", suffix);
      }
      this.lastUsedAt = new Date();
      return {
        command,
        args,
        success: true,
        exitCode: 0,
        stdout: output.stdout.value,
        stderr: output.stderr.value,
        executionTimeMs: performance.now() - started,
        ...output.metadata(),
      };
    } catch (caught) {
      if (aborted || options.abortSignal?.aborted) {
        throw abortReason(options.abortSignal);
      }
      const message = errorUtils.errorMessage(caught);
      output.emit("stderr", output.stderr.value ? `\n${message}` : message);
      const { crashedError } = await montyContext();
      const timedOut = caught instanceof crashedError && caught.timedOut;
      return {
        command,
        args,
        success: false,
        exitCode: timedOut ? -1 : 1,
        stdout: output.stdout.value,
        stderr: output.stderr.value,
        executionTimeMs: performance.now() - started,
        ...(timedOut ? { timedOut: true, killed: true } : {}),
        ...output.metadata(),
      };
    } finally {
      options.abortSignal?.removeEventListener("abort", onAbort);
      await session.close();
    }
  }

  async isReady(): Promise<boolean> {
    return this.status === "running";
  }

  getInfo(): SandboxInfo {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      createdAt: this.createdAt,
      ...(this.lastUsedAt ? { lastUsedAt: this.lastUsedAt } : {}),
      metadata: {
        language: "python",
        hostAccess: false,
      },
    };
  }

  getInstructions(): string {
    return [
      "Commands run as Python source in the Pydantic Monty fallback.",
      "Pass Python code directly rather than shell syntax.",
      "There is no host filesystem, network, environment, shell, or third-party package access.",
    ].join(" ");
  }
}

function montyCode(command: string, args: readonly string[]): string | undefined {
  if (args.length === 0) return command;
  if ((command === "python" || command === "python3") && args.length === 2 && args[0] === "-c") {
    return args[1];
  }
  return undefined;
}

function stripPythonFence(code: string): string {
  const trimmed = code.trim();
  const match = /^```(?:python|py)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return match?.[1] ?? code;
}

function formatResult(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

class RetainedOutput {
  readonly stdout: RetainedText;
  readonly stderr: RetainedText;

  private readonly onStdout: ExecuteCommandOptions["onStdout"];
  private readonly onStderr: ExecuteCommandOptions["onStderr"];

  constructor(options: ExecuteCommandOptions) {
    this.stdout = new RetainedText(options.maxRetainedBytes);
    this.stderr = new RetainedText(options.maxRetainedBytes);
    this.onStdout = options.onStdout;
    this.onStderr = options.onStderr;
  }

  emit(stream: "stdout" | "stderr", text: string): void {
    if (stream === "stdout") {
      this.onStdout?.(text);
      this.stdout.append(text);
    } else {
      this.onStderr?.(text);
      this.stderr.append(text);
    }
  }

  metadata(): Pick<
    CommandResult,
    "stdoutTruncated" | "stderrTruncated" | "stdoutDroppedBytes" | "stderrDroppedBytes"
  > {
    return {
      ...(this.stdout.droppedBytes > 0
        ? {
            stdoutTruncated: true,
            stdoutDroppedBytes: this.stdout.droppedBytes,
          }
        : {}),
      ...(this.stderr.droppedBytes > 0
        ? {
            stderrTruncated: true,
            stderrDroppedBytes: this.stderr.droppedBytes,
          }
        : {}),
    };
  }
}

class RetainedText {
  value = "";
  droppedBytes = 0;

  private readonly maxBytes: number;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(maxBytes: number | undefined) {
    const resolved = maxBytes ?? Number.POSITIVE_INFINITY;
    if (
      resolved !== Number.POSITIVE_INFINITY &&
      (!Number.isSafeInteger(resolved) || resolved < 0)
    ) {
      throw new TypeError("maxRetainedBytes must be a non-negative safe integer or Infinity");
    }
    this.maxBytes = resolved;
  }

  append(text: string): void {
    if (!text) return;
    if (this.maxBytes === Number.POSITIVE_INFINITY) {
      this.value += text;
      return;
    }
    const combined = this.encoder.encode(this.value + text);
    if (combined.length <= this.maxBytes) {
      this.value += text;
      return;
    }
    let start = combined.length - this.maxBytes;
    while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
    const retained = combined.subarray(start);
    this.droppedBytes += combined.length - retained.length;
    this.value = this.decoder.decode(retained);
  }
}

function terminateWorker(workerPid: number | undefined): void {
  if (workerPid === undefined) return;
  try {
    process.kill(workerPid, "SIGKILL");
  } catch {
    // The command can finish between the abort event and the kill request.
  }
}

async function checkoutSession(
  pool: MontyPool,
  options: CheckoutOptions,
  signal: AbortSignal | undefined,
): Promise<MontySession> {
  const checkout = pool.checkout(options);
  if (!signal) return checkout;
  if (signal.aborted) {
    void checkout.then((session) => session.close()).catch(() => undefined);
    throw abortReason(signal);
  }

  return new Promise<MontySession>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortReason(signal));
      void checkout.then((session) => session.close()).catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    checkout.then(
      (session) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(session);
      },
      (caught: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(caught);
      },
    );
  });
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The command was aborted", "AbortError");
}

function failedResult(
  command: string,
  args: string[],
  started: number,
  stderr: string,
): CommandResult {
  return {
    command,
    args,
    success: false,
    exitCode: 1,
    stdout: "",
    stderr,
    executionTimeMs: performance.now() - started,
  };
}

if (import.meta.main) {
  const sandbox = new MontySandbox();
  await sandbox.start();
  console.log(await sandbox.executeCommand("print('Hello, world!')"));
  await sandbox.stop();
}

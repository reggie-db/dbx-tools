import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import {
  pythonHost,
  type PythonProcessHandle,
  type PythonProcessResult,
} from "./host.ts";

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  signal?: AbortSignal;
}

interface SpawnSyncResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & {
    code: "ENOENT";
    errno: -2;
    syscall: string;
    path: string;
    spawnargs: string[];
  };
}

class PythonChildProcess extends EventEmitter {
  readonly pid = undefined;
  readonly stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  readonly stdout = new Readable({ read() {} });
  readonly stderr = new Readable({ read() {} });
  private active = true;
  private readonly handle: PythonProcessHandle;

  constructor(command: string, args: string[], options: SpawnOptions) {
    super();
    this.handle = pythonHost().process.start(command, args, options.env, undefined);
    options.signal?.addEventListener("abort", () => {
      if (!this.active) return;
      this.active = false;
      // Actually terminate the Python child so an aborted call leaks nothing.
      this.handle.kill();
      this.stdout.push(null);
      this.stderr.push(null);
      this.emit(
        "error",
        Object.assign(new Error("Process execution was aborted"), { code: "ABORT_ERR" }),
      );
    });
    void this.handle.wait().then(
      (result) => {
        if (!this.active) return;
        this.active = false;
        if (result.stdout) this.stdout.push(result.stdout);
        if (result.stderr) this.stderr.push(result.stderr);
        this.stdout.push(null);
        this.stderr.push(null);
        this.emit("close", result.exitCode);
        this.emit("exit", result.exitCode);
      },
      (error) => {
        if (!this.active) return;
        this.active = false;
        this.stdout.push(null);
        this.stderr.push(null);
        this.emit("error", error);
      },
    );
  }

  kill(): boolean {
    this.handle.kill();
    return true;
  }
}

export function spawn(command: string, args: string[] = [], options: SpawnOptions = {}) {
  return new PythonChildProcess(command, args, options);
}

export function execFile(
  command: string,
  args: string[],
  _options: object,
  callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
): void {
  void pythonHost()
    .process.start(command, args, undefined, undefined)
    .wait()
    .then(
      (result) => {
        if (result.exitCode === 0) {
          callback(null, { stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
        } else {
          callback(
            Object.assign(new Error(result.stderr || `Command exited ${result.exitCode}`), {
              code: result.exitCode,
            }),
          );
        }
      },
      (error) => callback(error instanceof Error ? error : new Error(String(error))),
    );
}

export function spawnSync(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): SpawnSyncResult {
  let result: PythonProcessResult;
  try {
    result = pythonHost().process.run(
      command,
      args,
      options.env,
      options.input,
      options.cwd,
    );
  } catch (error) {
    if (!String(error).includes("Python FileNotFoundError: [Errno 2]")) throw error;
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error(`spawnSync ${command} ENOENT`), {
        code: "ENOENT" as const,
        errno: -2 as const,
        syscall: `spawnSync ${command}`,
        path: command,
        spawnargs: args,
      }),
    };
  }
  return {
    status: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export default { execFile, spawn, spawnSync };

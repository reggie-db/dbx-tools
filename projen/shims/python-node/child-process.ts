import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import { pythonHost, type PythonProcessHandle } from "./host.ts";

interface SpawnOptions {
  env?: Record<string, string>;
  signal?: AbortSignal;
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

export function spawnSync(): never {
  throw Object.assign(new Error("Synchronous subprocesses are unavailable in PythonMonkey"), {
    code: "ENOSYS",
  });
}

export default { execFile, spawn, spawnSync };

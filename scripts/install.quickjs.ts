/**
 * Small runtime surface shared by Node and QuickJS-ng.
 *
 * The emitted ESM tries Node first, then falls back to QuickJS. Runtime-specific
 * values stay inside the two adapters; consumers use only {@link Runtime}.
 */

export interface ExecResult {
  status: number;
  stdout: string;
}

export interface Runtime {
  readonly name: "node" | "quickjs";
  exec(command: string, args?: string[]): ExecResult;
  exists(path: string): boolean;
  getenv(name: string): string | undefined;
  homedir(): string;
  loadFile(path: string): string | null;
  log(message: string): void;
  tmpdir(): string;
}

type DirType = "homedir" | "tmpdir";

const DIR_ENV: Record<DirType, string[]> = {
  homedir: ["HOME", "USERPROFILE"],
  tmpdir: ["TMPDIR", "TMP", "TEMP", "TEMPDIR", "TMP_DIR", "TMP_DIRECTORY", "TEMP_DIRECTORY"],
};

const DIR_FALLBACK: Record<DirType, string> = {
  homedir: "/root",
  tmpdir: "/tmp",
};

/** Resolve a home/temp directory, returning only a path that exists. */
function osDir(
  exists: Runtime["exists"],
  getenv: Runtime["getenv"],
  dirType: DirType,
  runtimeValue?: string,
): string {
  const candidates = [
    runtimeValue,
    ...DIR_ENV[dirType].map((name) => getenv(name)),
    DIR_FALLBACK[dirType],
  ];
  for (const candidate of candidates) {
    const directory = candidate?.trim();
    if (directory && exists(directory)) return directory;
  }
  throw new Error(`Could not resolve an existing ${dirType}`);
}

/** Node adapter. Imports are dynamic so QuickJS never resolves `node:*`. */
async function loadNodeRuntime(): Promise<Runtime> {
  // @ts-expect-error Optional Node runtime module
  const childProcess = await import("node:child_process");
  // @ts-expect-error Optional Node runtime module
  const fs = await import("node:fs");
  // @ts-expect-error Optional Node runtime module
  const nodeOs = await import("node:os");
  // @ts-expect-error Optional Node runtime module
  const nodeProcess = await import("node:process");
  const process = nodeProcess.default ?? nodeProcess;
  const exists = (path: string): boolean => fs.existsSync(path) as boolean;
  const getenv = (name: string): string | undefined => process.env[name] as string | undefined;

  return {
    name: "node",
    exec(command, args = []) {
      const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return {
        status: (result.status ?? (result.error ? 1 : 0)) as number,
        stdout: (result.stdout ?? "") as string,
      };
    },
    exists,
    getenv,
    homedir: () => osDir(exists, getenv, "homedir", nodeOs.homedir() as string),
    loadFile(path) {
      try {
        return fs.readFileSync(path, "utf8") as string;
      } catch {
        return null;
      }
    },
    log(message) {
      process.stderr.write(`[runtime] ${message}\n`);
    },
    tmpdir: () => osDir(exists, getenv, "tmpdir", nodeOs.tmpdir() as string),
  };
}

/** QuickJS adapter over its combined `qjs:std` and `qjs:os` modules. */
async function loadQuickJsRuntime(): Promise<Runtime> {
  // @ts-expect-error QuickJS runtime module
  const os = await import("qjs:os");
  // @ts-expect-error QuickJS runtime module
  const std = await import("qjs:std");
  const exists = (path: string): boolean => {
    const [, errno] = os.stat(path) as [unknown, number];
    return errno === 0;
  };
  const getenv = (name: string): string | undefined => std.getenv(name) as string | undefined;

  return {
    name: "quickjs",
    exec(command, args = []) {
      const pipe = os.pipe() as [number, number] | null;
      if (!pipe) throw new Error(`Could not create an output pipe for ${command}`);
      const [readFd, writeFd] = pipe;
      const nullFd = os.open("/dev/null", os.O_RDWR) as number;
      if (nullFd < 0) {
        os.close(readFd);
        os.close(writeFd);
        throw new Error(`Could not open /dev/null: ${std.strerror(-nullFd)}`);
      }

      let status: number;
      try {
        status = os.exec([command, ...args], {
          block: true,
          stdin: nullFd,
          stdout: writeFd,
          stderr: nullFd,
        }) as number;
      } finally {
        os.close(writeFd);
        os.close(nullFd);
      }

      const output = std.fdopen(readFd, "r");
      if (!output) {
        os.close(readFd);
        throw new Error(`Could not read output from ${command}`);
      }
      try {
        return { status, stdout: output.readAsString() as string };
      } finally {
        output.close();
      }
    },
    exists,
    getenv,
    homedir: () => osDir(exists, getenv, "homedir"),
    loadFile: (path) => std.loadFile(path) as string | null,
    log(message) {
      std.err.puts(`[runtime] ${message}\n`);
      std.err.flush();
    },
    tmpdir: () => osDir(exists, getenv, "tmpdir"),
  };
}

/** Prefer Node when available; QuickJS reaches the fallback on `node:*` failure. */
export async function loadRuntime(): Promise<Runtime> {
  try {
    return await loadNodeRuntime();
  } catch {
    return loadQuickJsRuntime();
  }
}

export const runtime = await loadRuntime();

if (runtime.getenv("INSTALL_RUNTIME_SMOKE") === "1") {
  const result = runtime.exec("printf", ["runtime-smoke"]);
  if (result.status !== 0 || result.stdout !== "runtime-smoke") {
    throw new Error(`Runtime smoke failed with status ${result.status}`);
  }
  runtime.log(`${runtime.name} smoke passed (${runtime.homedir()}, ${runtime.tmpdir()})`);
}

interface PythonBridge {
  eval(source: string): unknown;
}

interface PythonCompletedProcess {
  returncode: number;
  stdout: string | null;
  stderr: string | null;
}

interface PythonHttpResponse {
  status_code: number;
  headers: Record<string, string>;
  content: Iterable<number>;
}

export interface PythonFileHost {
  chmod(path: string, mode: number): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
  exists(path: string): boolean;
  mkdir(path: string, recursive: boolean): Promise<boolean>;
  mkdtemp(prefix: string): Promise<string>;
  readBytes(path: string): Promise<number[]>;
  readDirectory(path: string): Promise<{ name: string; directory: boolean; file: boolean }[]>;
  readTextSync(path: string): string;
  realpath(path: string): Promise<string>;
  remove(path: string, recursive: boolean, force: boolean): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  stat(path: string): Promise<{
    directory: boolean;
    file: boolean;
    mode: number;
    mtimeMs: number;
    size: number;
  }>;
  touch(path: string, atimeMs: number, mtimeMs: number): Promise<void>;
  writeBytes(path: string, content: number[], mode?: number): Promise<void>;
}

export interface PythonPathHost {
  basename(path: string): string;
  dirname(path: string): string;
  fileUrlToPath(url: string): string;
  isAbsolute(path: string): boolean;
  join(parts: string[]): string;
  relative(from: string, to: string): string;
  resolve(parts: string[]): string;
}

export interface PythonProcessResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/** A started subprocess: await {@link wait} for its result, or {@link kill} it. */
export interface PythonProcessHandle {
  /** Terminate the child (SIGKILL). No-op once it has already exited. */
  kill(): void;
  /** Resolve with the child's result once it exits (runs off the main thread). */
  wait(): Promise<PythonProcessResult>;
}

export interface PythonRuntimeHost {
  crypto: {
    randomBytes(length: number): number[];
    sha256(content: number[]): string;
  };
  file: PythonFileHost;
  os: {
    homedir(): string;
    tmpdir(): string;
  };
  path: PythonPathHost;
  http: {
    fetch(
      url: string,
      method?: string,
      headers?: Record<string, string>,
      body?: string,
      timeoutMs?: number,
    ): Promise<{ status: number; headers: Record<string, string>; body: number[] }>;
  };
  process: {
    start(
      command: string,
      args: string[],
      environment: Record<string, string> | undefined,
      input: string | undefined,
    ): PythonProcessHandle;
  };
}

type PythonFunction = (...args: any[]) => any;

const python = (globalThis as typeof globalThis & { python?: PythonBridge }).python;
if (!python) throw new Error("PythonMonkey globalThis.python is unavailable");

function evaluate<T extends PythonFunction>(source: string): T {
  return python!.eval(source) as T;
}

const toThread = evaluate<PythonFunction>("__import__('asyncio').to_thread");
const osPath = {
  basename: evaluate<PythonFunction>("__import__('os').path.basename"),
  dirname: evaluate<PythonFunction>("__import__('os').path.dirname"),
  exists: evaluate<PythonFunction>("__import__('os').path.exists"),
  isAbsolute: evaluate<PythonFunction>("__import__('os').path.isabs"),
  join: evaluate<PythonFunction>("lambda parts: __import__('os').path.join(*list(parts))"),
  realpath: evaluate<PythonFunction>("__import__('os').path.realpath"),
  relative: evaluate<PythonFunction>("__import__('os').path.relpath"),
  resolve: evaluate<PythonFunction>(
    "lambda parts: __import__('os').path.abspath(__import__('os').path.join(*list(parts))) if list(parts) else __import__('os').getcwd()",
  ),
};
const readBytes = evaluate<PythonFunction>("lambda path: list(open(path, 'rb').read())");
const readText = evaluate<PythonFunction>("lambda path: open(path, encoding='utf-8').read()");
const writeBytes = evaluate<PythonFunction>(
  "lambda path, content: open(path, 'wb').write(bytes(int(value) for value in content))",
);
const mkdir = evaluate<PythonFunction>(
  "lambda path, recursive: __import__('os').makedirs(path, exist_ok=recursive) if recursive else __import__('os').mkdir(path)",
);
const listDirectory = evaluate<PythonFunction>(
  "lambda path: [{'name': entry.name, 'directory': entry.is_dir(), 'file': entry.is_file()} for entry in __import__('pathlib').Path(path).iterdir()]",
);
const statPath = evaluate<PythonFunction>(
  "lambda path: {'directory': __import__('os').path.isdir(path), 'file': __import__('os').path.isfile(path), 'mode': __import__('os').stat(path).st_mode, 'mtimeMs': __import__('os').stat(path).st_mtime * 1000, 'size': __import__('os').stat(path).st_size}",
);
const popen = evaluate<PythonFunction>(
  "lambda command, args, environment, input_text: __import__('subprocess').Popen([command, *list(args)], env=dict(environment) if environment is not None else None, stdin=(__import__('subprocess').PIPE if input_text is not None else None), stdout=__import__('subprocess').PIPE, stderr=__import__('subprocess').PIPE, text=True)",
);
const communicate = evaluate<PythonFunction>(
  "lambda proc, input_text: (lambda out: {'returncode': proc.returncode, 'stdout': out[0], 'stderr': out[1]})(proc.communicate(input=input_text))",
);
const killProcess = evaluate<PythonFunction>("lambda proc: proc.kill()");
const requestHttp = evaluate<PythonFunction>(
  "lambda url, method, headers, body, timeout: __import__('httpx').request(method or 'GET', url, headers=dict(headers) if headers is not None else None, content=body, timeout=(timeout / 1000) if timeout is not None else 30, follow_redirects=True)",
);
const chmod = evaluate<PythonFunction>(
  "lambda path, mode: __import__('os').chmod(path, int(mode))",
);
const isDir = evaluate<PythonFunction>("__import__('os').path.isdir");
const rmtree = evaluate<PythonFunction>("__import__('shutil').rmtree");
const rmdir = evaluate<PythonFunction>("__import__('os').rmdir");
const unlink = evaluate<PythonFunction>("__import__('os').unlink");

const host: PythonRuntimeHost = {
  crypto: {
    randomBytes: evaluate<PythonFunction>(
      "lambda length: list(__import__('os').urandom(int(length)))",
    ),
    sha256: evaluate<PythonFunction>(
      "lambda content: __import__('hashlib').sha256(bytes(int(value) for value in content)).hexdigest()",
    ),
  },
  file: {
    async chmod(path, mode) {
      await toThread(chmod, path, mode);
    },
    async copy(source, destination) {
      await toThread(
        evaluate<PythonFunction>("__import__('shutil').copyfile"),
        source,
        destination,
      );
    },
    exists: (path) => Boolean(osPath.exists(path)),
    async mkdir(path, recursive) {
      if (await toThread(osPath.exists, path)) return false;
      await toThread(mkdir, path, recursive);
      return true;
    },
    async mkdtemp(prefix) {
      return toThread(
        evaluate<PythonFunction>("__import__('tempfile').mkdtemp"),
        undefined,
        prefix,
      );
    },
    async readBytes(path) {
      return toThread(readBytes, path);
    },
    async readDirectory(path) {
      return toThread(listDirectory, path);
    },
    readTextSync: (path) => String(readText(path)),
    async realpath(path) {
      return String(await toThread(osPath.realpath, path));
    },
    async remove(path, recursive, force) {
      if (!(await toThread(osPath.exists, path))) {
        if (!force) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return;
      }
      const isDirectory = await toThread(isDir, path);
      const operation = isDirectory ? (recursive ? rmtree : rmdir) : unlink;
      await toThread(operation, path);
    },
    async rename(source, destination) {
      await toThread(evaluate<PythonFunction>("__import__('os').replace"), source, destination);
    },
    async stat(path) {
      return toThread(statPath, path);
    },
    async touch(path, atimeMs, mtimeMs) {
      await toThread(
        evaluate<PythonFunction>(
          "lambda path, atime, mtime: __import__('os').utime(path, (atime / 1000, mtime / 1000))",
        ),
        path,
        atimeMs,
        mtimeMs,
      );
    },
    async writeBytes(path, content, mode) {
      await toThread(writeBytes, path, content);
      if (mode !== undefined) await toThread(chmod, path, mode);
    },
  },
  http: {
    async fetch(url, method, headers, body, timeoutMs) {
      const response = (await toThread(
        requestHttp,
        url,
        method,
        headers,
        body,
        timeoutMs,
      )) as PythonHttpResponse;
      return {
        status: response.status_code,
        headers: Object.fromEntries(Object.entries(response.headers)),
        body: Array.from(response.content),
      };
    },
  },
  os: {
    homedir: evaluate<PythonFunction>("lambda: __import__('pathlib').Path.home().as_posix()"),
    tmpdir: evaluate<PythonFunction>("__import__('tempfile').gettempdir"),
  },
  path: {
    basename: (path) => String(osPath.basename(path)),
    dirname: (path) => String(osPath.dirname(path)),
    fileUrlToPath: evaluate<PythonFunction>(
      "lambda url: __import__('urllib.parse', fromlist=['urlparse']).unquote(__import__('urllib.parse', fromlist=['urlparse']).urlparse(url).path)",
    ),
    isAbsolute: (path) => Boolean(osPath.isAbsolute(path)),
    join: (parts) => String(osPath.join(parts)),
    relative: (from, to) => String(osPath.relative(to, from)),
    resolve: (parts) => String(osPath.resolve(parts)),
  },
  process: {
    start(command, args, environment, input) {
      // Popen (not subprocess.run) so the child is killable: an aborted caller
      // can terminate it instead of leaking a background process. There is no
      // imposed timeout - the child runs to completion (an interactive login may
      // legitimately take minutes); the caller owns cancellation.
      const proc = popen(command, args, environment, input);
      let killed = false;
      return {
        kill() {
          if (killed) return;
          killed = true;
          try {
            killProcess(proc);
          } catch {
            // The child already exited; there is nothing to signal.
          }
        },
        async wait() {
          // communicate() blocks until exit, so run it off the main thread.
          const result = (await toThread(communicate, proc, input)) as PythonCompletedProcess;
          return {
            exitCode: result.returncode,
            ...(result.stdout?.trim() ? { stdout: result.stdout.trim() } : {}),
            ...(result.stderr?.trim() ? { stderr: result.stderr.trim() } : {}),
          };
        },
      };
    },
  },
};

export function installPythonGlobals(): void {
  const globals = globalThis as typeof globalThis & {
    global?: typeof globalThis;
    self?: typeof globalThis;
    window?: typeof globalThis;
    process?: Record<string, unknown>;
  };
  globals.global = globalThis;
  globals.self = globalThis;
  globals.window = globalThis;
  globals.process ??= {
    arch: String(evaluate<PythonFunction>("__import__('platform').machine")())
      .replace("aarch64", "arm64")
      .replace("x86_64", "x64"),
    argv: [],
    browser: true,
    cwd: evaluate<PythonFunction>("__import__('os').getcwd"),
    env: evaluate<PythonFunction>("lambda: dict(__import__('os').environ)")(),
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
      Promise.resolve().then(() => callback(...args)),
    platform: { Darwin: "darwin", Linux: "linux", Windows: "win32" }[
      String(evaluate<PythonFunction>("__import__('platform').system")())
    ],
    version: "v22.0.0",
    versions: {},
  };
}

installPythonGlobals();

export function pythonHost(): PythonRuntimeHost {
  return host;
}

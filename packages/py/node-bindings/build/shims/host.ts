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
    fetch(url: string): Promise<{ status: number; headers: Record<string, string>; body: number[] }>;
  };
  process: {
    run(
      command: string,
      args: string[],
      environment: Record<string, string> | undefined,
      input: string | undefined,
      timeoutMs: number | undefined,
    ): Promise<PythonProcessResult>;
  };
}

export function pythonHost(): PythonRuntimeHost {
  const host = (globalThis as typeof globalThis & {
    __dbxToolsPython?: PythonRuntimeHost;
  }).__dbxToolsPython;
  if (!host) throw new Error("dbx-tools Python runtime host is unavailable");
  return host;
}

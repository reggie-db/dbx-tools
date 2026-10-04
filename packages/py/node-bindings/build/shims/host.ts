export interface PythonFileHost {
  exists(path: string): boolean;
  readTextSync(path: string): string;
}

export interface PythonPathHost {
  isAbsolute(path: string): boolean;
  join(parts: string[]): string;
  resolve(parts: string[]): string;
}

export interface PythonProcessResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface PythonRuntimeHost {
  core: {
    ensureBinary(request: {
      name: string;
      url: string;
      sha256?: string;
      destination: string;
      executable: string;
    }): Promise<void>;
  };
  crypto: {
    sha256(value: string): string;
  };
  file: PythonFileHost;
  os: {
    homedir(): string;
    tmpdir(): string;
  };
  path: PythonPathHost;
  process: {
    run(
      command: string,
      args: string[],
      environment: Record<string, string> | undefined,
      input: string | undefined,
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

/** Portable process invocation request. */
export interface ProcessRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
}

/** Portable process completion record. */
export interface ProcessResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/** Portable HTTP request record. */
export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** Portable HTTP response record. */
export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Portable directory creation request. */
export interface EnsureDirectoryRequest {
  path: string;
  mode?: number;
}

/** Portable UTF-8 file read request. */
export interface ReadTextRequest {
  path: string;
  defaultValue?: string;
}

/** Portable JSON file read request. */
export interface ReadJsonRequest {
  path: string;
  defaultValue?: unknown;
}

/** Portable atomic JSON write request. */
export interface AtomicWriteJsonRequest {
  path: string;
  value: unknown;
  mode?: number;
}

/** Portable path-keyed file-lock request. */
export interface FileLockRequest {
  path: string;
  lockDirectory?: string;
  timeoutMs?: number;
}

/** Host operations supplied to embedded JavaScript capability packages. */
export interface JsBindings {
  runProcess(request: ProcessRequest): Promise<ProcessResult>;
  executeHttp(request: HttpRequest): Promise<HttpResult>;
  ensureDirectory(request: EnsureDirectoryRequest): Promise<void>;
  readTextFile(request: ReadTextRequest): Promise<string | undefined>;
  readJsonFile(request: ReadJsonRequest): Promise<unknown>;
  atomicWriteJsonFile(request: AtomicWriteJsonRequest): Promise<void>;
  acquireFileLease(request: FileLockRequest): Promise<string>;
  releaseFileLease(lease: string): Promise<void>;
}

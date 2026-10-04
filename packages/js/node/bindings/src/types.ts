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

/** Host operations supplied to embedded JavaScript capability packages. */
export interface JsBindings {
  runProcess(request: ProcessRequest): Promise<ProcessResult>;
  executeHttp(request: HttpRequest): Promise<HttpResult>;
}

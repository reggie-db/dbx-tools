/** Map Python OS errors onto Node `fs` error codes such as `ENOENT`. */

export function nodeError(error: unknown, code: string, path: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(`${code}: ${detail}`, { cause: error }), { code, path });
}

/** Rethrow a Python filesystem failure as a Node-shaped error, or rethrow unchanged. */
export function translatePythonError(cause: unknown, path: string): never {
  const message = String(cause);
  if (/FileNotFoundError|Errno 2/.test(message)) throw nodeError(cause, "ENOENT", path);
  if (/FileExistsError|Errno 17/.test(message)) throw nodeError(cause, "EEXIST", path);
  if (/PermissionError|Errno 13/.test(message)) throw nodeError(cause, "EACCES", path);
  throw cause;
}

/** Run a sync Python filesystem call and translate missing-file errors for Node callers. */
export function withPythonPath<T>(path: string, operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    translatePythonError(cause, path);
  }
}

import { pythonHost } from "./host.ts";

function nodeError(error: unknown, code: string, path: string): Error {
  return Object.assign(error instanceof Error ? error : new Error(String(error)), { code, path });
}

function translatePythonError(cause: unknown, path: string): never {
  const message = String(cause);
  if (/FileNotFoundError|Errno 2/.test(message)) throw nodeError(cause, "ENOENT", path);
  if (/FileExistsError|Errno 17/.test(message)) throw nodeError(cause, "EEXIST", path);
  if (/PermissionError|Errno 13/.test(message)) throw nodeError(cause, "EACCES", path);
  throw cause;
}

export async function chmod(path: string, mode: number): Promise<void> {
  await pythonHost().file.chmod(String(path), mode);
}

export async function copyFile(source: string, destination: string): Promise<void> {
  await pythonHost().file.copy(String(source), String(destination));
}

export async function mkdir(
  path: string,
  options: { recursive?: boolean } = {},
): Promise<string | undefined> {
  let created: boolean;
  try {
    created = await pythonHost().file.mkdir(String(path), options.recursive === true);
  } catch (cause) {
    if (/FileExistsError|Errno 17/.test(String(cause))) {
      if (options.recursive) return undefined;
      throw nodeError(cause, "EEXIST", path);
    }
    throw cause;
  }
  if (!created && !options.recursive) throw nodeError(new Error(`EEXIST: ${path}`), "EEXIST", path);
  return created ? String(path) : undefined;
}

export async function mkdtemp(prefix: string): Promise<string> {
  return pythonHost().file.mkdtemp(String(prefix));
}

export async function readdir(
  path: string,
  options: { withFileTypes?: boolean } = {},
): Promise<unknown[]> {
  const entries = await pythonHost().file.readDirectory(String(path));
  if (!options.withFileTypes) return entries.map((entry) => entry.name);
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: () => entry.directory,
    isFile: () => entry.file,
    isSymbolicLink: () => false,
  }));
}

export async function readFile(
  path: string,
  options?: string | { encoding?: string | null },
): Promise<string | Uint8Array> {
  try {
    const bytes = Uint8Array.from(await pythonHost().file.readBytes(String(path)));
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? new TextDecoder(encoding).decode(bytes) : bytes;
  } catch (cause) {
    translatePythonError(cause, path);
  }
}

export async function realpath(path: string): Promise<string> {
  try {
    return await pythonHost().file.realpath(String(path));
  } catch (cause) {
    translatePythonError(cause, path);
  }
}

export async function rename(source: string, destination: string): Promise<void> {
  await pythonHost().file.rename(String(source), String(destination));
}

export async function rm(
  path: string,
  options: { recursive?: boolean; force?: boolean } = {},
): Promise<void> {
  await pythonHost().file.remove(String(path), options.recursive === true, options.force === true);
}

export async function unlink(path: string): Promise<void> {
  if (!pythonHost().file.exists(String(path))) return;
  try {
    await pythonHost().file.remove(String(path), false, false);
  } catch (cause) {
    if (/FileNotFoundError|Errno 2|ENOENT/.test(String(cause))) return;
    translatePythonError(cause, path);
  }
}

export async function stat(path: string): Promise<unknown> {
  let value: Awaited<ReturnType<ReturnType<typeof pythonHost>["file"]["stat"]>>;
  try {
    value = await pythonHost().file.stat(String(path));
  } catch (cause) {
    translatePythonError(cause, path);
  }
  return {
    mode: value.mode,
    mtime: new Date(value.mtimeMs),
    mtimeMs: value.mtimeMs,
    size: value.size,
    isDirectory: () => value.directory,
    isFile: () => value.file,
    isSymbolicLink: () => false,
  };
}

export async function writeFile(
  path: string,
  content: string | ArrayBuffer | ArrayBufferView,
  options: { mode?: number } = {},
): Promise<void> {
  const bytes =
    typeof content === "string"
      ? new TextEncoder().encode(content)
      : content instanceof ArrayBuffer
        ? new Uint8Array(content)
        : new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  await pythonHost().file.writeBytes(String(path), Array.from(bytes), options.mode);
}

export async function open(): Promise<never> {
  throw Object.assign(new Error("File descriptors are unavailable in PythonMonkey"), {
    code: "ENOSYS",
  });
}

export default {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
};

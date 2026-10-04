import { pythonHost } from "./host.ts";

function nodeError(error: unknown, code: string, path: string): Error {
  return Object.assign(error instanceof Error ? error : new Error(String(error)), { code, path });
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
  const created = await pythonHost().file.mkdir(String(path), options.recursive === true);
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

export async function readFile(path: string): Promise<Uint8Array> {
  return Uint8Array.from(await pythonHost().file.readBytes(String(path)));
}

export async function realpath(path: string): Promise<string> {
  return pythonHost().file.realpath(String(path));
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
  await pythonHost().file.remove(String(path), false, false);
}

export async function stat(path: string): Promise<unknown> {
  const value = await pythonHost().file.stat(String(path));
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

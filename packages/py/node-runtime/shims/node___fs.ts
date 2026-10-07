import { Readable, Writable } from "node:stream";

import * as promises from "./node___fs__promises.ts";
import { pythonHost } from "./host.ts";

type Callback<T = undefined> = (error: Error | null, value?: T) => void;

function callback<T>(operation: Promise<T>, done: Callback<T>): void {
  void operation.then(
    (value) => done(null, value),
    (error) => done(error as Error),
  );
}

export function existsSync(path: string): boolean {
  return pythonHost().file.exists(String(path));
}

export function readFileSync(path: string, _encoding?: string): string {
  return pythonHost().file.readTextSync(String(path));
}

export function readdirSync(path: string, options: { withFileTypes?: boolean } = {}): unknown[] {
  const entries = pythonHost().file.readDirectorySync(String(path));
  if (!options.withFileTypes) return entries.map((entry) => entry.name);
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: () => entry.directory,
    isFile: () => entry.file,
    isSymbolicLink: () => false,
  }));
}

export function readlinkSync(path: string): string {
  return pythonHost().file.readLinkSync(String(path));
}

export function realpathSync(path: string): string {
  return pythonHost().file.realpathSync(String(path));
}

realpathSync.native = realpathSync;

export function lstatSync(path: string): unknown {
  const value = pythonHost().file.statSync(String(path));
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

export function createReadStream(path: string): Readable {
  const stream = new Readable({ read() {} });
  void pythonHost()
    .file.readBytes(String(path))
    .then(
      (content) => {
        stream.push(Uint8Array.from(content));
        stream.push(null);
      },
      (error) => stream.destroy(error as Error),
    );
  return stream;
}

export function createWriteStream(path: string, options: { mode?: number } = {}): Writable {
  const chunks: number[] = [];
  return new Writable({
    write(chunk, _encoding, done) {
      chunks.push(...new Uint8Array(chunk));
      done();
    },
    final(done) {
      void pythonHost()
        .file.writeBytes(String(path), chunks, options.mode)
        .then(
          () => done(),
          (error) => done(error as Error),
        );
    },
  });
}

export function mkdir(path: string, options: object | Callback, done?: Callback): void {
  const settings = typeof options === "function" ? {} : (options as { recursive?: boolean });
  const callbackValue = typeof options === "function" ? options : done;
  callback(
    promises.mkdir(path, settings).then(() => undefined),
    callbackValue ?? (() => {}),
  );
}

export function realpath(path: string, done: Callback<string>): void {
  callback(promises.realpath(path), done);
}

export function stat(path: string, done: Callback<unknown>): void {
  callback(promises.stat(path), done);
}

export const lstat = stat;

export function rmdir(path: string, done: Callback): void {
  callback(
    promises.rm(path).then(() => undefined),
    done,
  );
}

export function utimes(path: string, atime: Date, mtime: Date, done: Callback): void {
  callback(
    pythonHost()
      .file.touch(String(path), atime.getTime(), mtime.getTime())
      .then(() => undefined),
    done,
  );
}

export function open(_path: string, _flags: unknown, done: Callback<number>): void {
  done(
    Object.assign(new Error("File descriptors are unavailable in PythonMonkey"), {
      code: "ENOSYS",
    }),
  );
}

export function close(_fd: number, done: Callback): void {
  done(null);
}

export function openSync(): never {
  throw Object.assign(new Error("File descriptors are unavailable in PythonMonkey"), {
    code: "ENOSYS",
  });
}

export function closeSync(): void {}

export const constants = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_SYMLINK: 0,
};

export { promises };

export default {
  close,
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  lstat,
  mkdir,
  open,
  openSync,
  promises,
  readFileSync,
  readdirSync,
  realpath,
  realpathSync,
  readlinkSync,
  rmdir,
  stat,
  lstatSync,
  utimes,
};

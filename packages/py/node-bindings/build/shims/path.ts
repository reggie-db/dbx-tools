import { pythonHost } from "./host.ts";

export const sep = "/";

export function basename(path: string): string {
  return pythonHost().path.basename(String(path));
}

export function dirname(path: string): string {
  return pythonHost().path.dirname(String(path));
}

export function extname(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
}

export function isAbsolute(path: string): boolean {
  return pythonHost().path.isAbsolute(String(path));
}

export function join(...parts: string[]): string {
  return pythonHost().path.join(parts.map(String));
}

export function normalize(path: string): string {
  return resolve(path);
}

export function parse(path: string): {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
} {
  const dir = dirname(path);
  const base = basename(path);
  const ext = extname(base);
  return {
    root: isAbsolute(path) ? sep : "",
    dir,
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base,
  };
}

export function relative(from: string, to: string): string {
  return pythonHost().path.relative(String(from), String(to));
}

export function resolve(...parts: string[]): string {
  return pythonHost().path.resolve(parts.map(String));
}

export const delimiter = process.platform === "win32" ? ";" : ":";
export const posix = { basename, delimiter: ":", dirname, extname, isAbsolute, join, normalize, parse, relative, resolve, sep: "/" };
export const win32 = { basename, delimiter: ";", dirname, extname, isAbsolute, join, normalize, parse, relative, resolve, sep: "\\" };

export default {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  parse,
  posix,
  relative,
  resolve,
  sep,
  win32,
};

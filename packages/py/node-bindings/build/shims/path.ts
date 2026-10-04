import { pythonHost } from "./host.ts";

export function isAbsolute(path: string): boolean {
  return pythonHost().path.isAbsolute(String(path));
}

export function join(...parts: string[]): string {
  return pythonHost().path.join(parts.map(String));
}

export function resolve(...parts: string[]): string {
  return pythonHost().path.resolve(parts.map(String));
}

export default { isAbsolute, join, resolve };

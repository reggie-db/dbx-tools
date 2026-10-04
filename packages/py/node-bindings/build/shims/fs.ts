import { pythonHost } from "./host.ts";

export function existsSync(path: string): boolean {
  return pythonHost().file.exists(String(path));
}

export function readFileSync(path: string, _encoding?: string): string {
  return pythonHost().file.readTextSync(String(path));
}

export default { existsSync, readFileSync };

import { pythonHost } from "./host.ts";

export function homedir(): string {
  return pythonHost().os.homedir();
}

export function tmpdir(): string {
  return pythonHost().os.tmpdir();
}

export default { homedir, tmpdir };

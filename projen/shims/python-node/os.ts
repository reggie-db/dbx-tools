import { pythonHost } from "./host.ts";

export const constants = {
  errno: {
    EEXIST: 17,
    ENOTDIR: 20,
    EISDIR: 21,
    EINVAL: 22,
  },
} as const;

export function homedir(): string {
  return pythonHost().os.homedir();
}

export function tmpdir(): string {
  return pythonHost().os.tmpdir();
}

export default { constants, homedir, tmpdir };

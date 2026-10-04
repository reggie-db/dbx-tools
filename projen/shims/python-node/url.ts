import { pythonHost } from "./host.ts";

export function fileURLToPath(url: string | URL): string {
  return pythonHost().path.fileUrlToPath(String(url));
}

export default { fileURLToPath };

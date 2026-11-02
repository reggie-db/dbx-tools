import { fileURLToPath } from "node:url";

/** Resolve the source or compiled auth bin beside the importing module. */
export function resolveServiceAuthEntrypoint(moduleUrl: string): string {
  const extension = moduleUrl.endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`../bin/dbx-service-auth.${extension}`, moduleUrl));
}

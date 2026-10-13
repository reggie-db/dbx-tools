import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read one source or packaged resource from the appkit-sandbox package root. */
export function readPackageResource(...segments: string[]): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const parent = dirname(moduleDirectory);
  const packageRoot = basename(parent) === "lib" ? dirname(parent) : parent;
  return readFileSync(join(packageRoot, ...segments), "utf8");
}

import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { javascript } from "projen";
import { toPosix } from "./workspace";

/** `tsx <rel>/tasks/<script>` from the monorepo root (works in-repo and installed). */
export function taskScript(project: javascript.NodeProject, script: string, args = ""): string {
  const scriptPath = join(resolveTasksDir(), script);
  const rel = toPosix(relative(resolve(project.outdir), scriptPath));
  return args ? `tsx ${rel} ${args}` : `tsx ${rel}`;
}

/** Locate `tasks/` next to the shared-projen package root (source or `lib/` emit). */
export function resolveTasksDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, "tasks");
    if (existsSync(candidate)) return candidate;
    dir = join(dir, "..");
  }
  throw new Error("@dbx-tools/shared-projen tasks/ directory not found");
}

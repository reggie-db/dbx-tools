/**
 * Per-package type-checker.
 *
 * Runs `tsc --noEmit` against each package's own env tsconfig. Checking each
 * package separately - rather than one root program - is what makes the env
 * enforcement real: a `shared`/`node`/`server` package is compiled with a
 * DOM-free `lib`, and a `ui` package with no `node` types, so misuse of the other
 * runtime fails here. Packages are read from `pnpm-workspace.yaml` (source of
 * truth) via `discoverPackages()`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { logger } from "../log";
import { discoverPackages, repoRoot } from "./workspace";

const log = logger.withTag("projen:typecheck");
const require = createRequire(import.meta.url);
const TSC = require.resolve("typescript/bin/tsc");

interface Target {
  readonly label: string;
  readonly tsconfig: string;
}

function targets(): Target[] {
  const out: Target[] = [];
  for (const p of discoverPackages()) {
    const tsconfig = join(p.dir, "tsconfig.json");
    if (existsSync(tsconfig)) {
      out.push({ label: p.envPath, tsconfig });
    }
  }
  return out;
}

/** Type-check every package; returns the number that failed. */
export function typecheckAll(): number {
  let failures = 0;
  for (const t of targets()) {
    try {
      execFileSync(process.execPath, [TSC, "--noEmit", "-p", t.tsconfig], {
        cwd: repoRoot,
        stdio: "pipe",
      });
      log.success(t.label);
    } catch (err) {
      failures += 1;
      log.error(t.label);
      const stdout =
        err && typeof err === "object" && "stdout" in err
          ? `${(err as { stdout?: Buffer }).stdout ?? ""}`
          : "";
      if (stdout.trim()) process.stderr.write(`${stdout.trim()}\n`);
    }
  }
  return failures;
}

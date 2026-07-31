/**
 * Startup report of the dependency versions this process actually loaded.
 *
 * The demo resolves its `@dbx-tools/*` packages one of two ways - source-linked
 * to `../packages` (the default) or published copies from the registry in
 * `.npmrc` - and once the server is up the two look identical. That ambiguity
 * costs real time: edit a package, restart, watch the old behavior, and go
 * hunting for a bug that was never in the code you changed. So the server says
 * which is which before it serves anything.
 *
 * Versions are read from the RESOLVED package on disk rather than from this
 * app's manifest, so a range, a stale pin, or a link reports what is genuinely
 * loaded instead of what was asked for.
 *
 * @module
 */

import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { json, log } from "@dbx-tools/shared-core";

const logger = log.logger("demo/dependencies");

const require = createRequire(import.meta.url);

/** This app's own directory (`demo/server/appkit-demo`). */
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The demo workspace root; anything resolving outside it came from elsewhere. */
const demoRoot = path.resolve(appDir, "..", "..");

/** Reported for a dependency whose package cannot be resolved from here. */
const UNRESOLVED = "unresolved";

/** Read a `package.json`, or `undefined` when it is missing or malformed. */
function readManifest(file: string): Record<string, unknown> | undefined {
  try {
    return json.parseRecord(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Directory of the installed package named `name`.
 *
 * `<name>/package.json` is the direct route, but a package whose `exports` map
 * omits it throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, so the fallback resolves the
 * entry point and walks up to the first manifest that claims the name.
 */
function packageDir(name: string): string | undefined {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    // Not exported; fall through to the entry-point walk.
  }
  let dir: string;
  try {
    dir = path.dirname(require.resolve(name));
  } catch {
    return undefined;
  }
  for (let parent = dir; ; dir = parent) {
    if (readManifest(path.join(dir, "package.json"))?.name === name) return dir;
    parent = path.dirname(dir);
    if (parent === dir) return undefined;
  }
}

/**
 * How one dependency resolved: its on-disk version, plus where it came from
 * when that is not the demo's own install.
 *
 * A linked package's real path sits outside the demo tree (under the repo's
 * `packages/`), which is exactly what distinguishes source from registry - the
 * symlink is the whole mechanism, so following it is the whole check.
 */
function describe(name: string): string {
  const dir = packageDir(name);
  if (!dir) return UNRESOLVED;
  const version = readManifest(path.join(dir, "package.json"))?.version;
  const label = typeof version === "string" ? version : UNRESOLVED;
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return label;
  }
  if (real.startsWith(`${demoRoot}${path.sep}`)) return label;
  return `${label} (linked from ${path.relative(path.dirname(demoRoot), real)})`;
}

/**
 * Log every declared runtime dependency with the version resolved for it.
 *
 * Call before the app starts so the report precedes any request handling.
 */
export function logDependencies(): void {
  const manifest = readManifest(path.join(appDir, "package.json"));
  const declared = manifest?.dependencies;
  if (!declared || typeof declared !== "object") {
    logger.warn("dependencies:unavailable", { appDir });
    return;
  }
  const resolved: Record<string, string> = {};
  for (const name of Object.keys(declared).sort()) {
    resolved[name] = describe(name);
  }
  logger.info("dependencies", resolved);
}

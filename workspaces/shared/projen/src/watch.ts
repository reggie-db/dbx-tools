/**
 * The barrels + openapi file watchers behind `projen sync --watch`.
 *
 * `sync --watch` runs three long-running processes under `concurrently` (see
 * `tasks/sync.ts`): projen's own `projen --watch` owns re-synth (it re-runs
 * `.projenrc.ts` on any tree change - touch `.projenrc.ts` to force one), while
 * these two focused watchers keep generated OUTPUT fresh without waiting for a
 * full synth:
 *
 *   1. **barrel watch** (`startBarrelWatch`) - a source edit inside a package
 *      rebuilds just that package's `index.ts` barrel.
 *   2. **openapi watch** (`startOpenapiWatch`) - a changed file matching
 *      {@link isTsoaController} regenerates the openapi packages (spec + client) and
 *      their barrels.
 *
 * Generated files matched by {@link isGeneratedFile} are ignored so a watcher does
 * not re-trigger itself on its own barrel/manifest output; vendor/build dirs
 * (`node_modules`/`dist`/`lib`/`.projen`/...) are pruned by file-scan's built-in
 * ignore groups. {@link watchFiles} from `@dbx-tools/shared-file-scan` owns the
 * chokidar wiring; everything here is thin glue.
 */
import { isAbsolute, resolve, sep } from "node:path";
import { watch as fileScan } from "@dbx-tools/shared-file-scan";
import { generateBarrels } from "./barrels";
import { logger } from "./log";
import { generateOpenapi, isTsoaController } from "./openapi";
import { isGeneratedFile, recordedRoots, repoRoot, workspacePackages } from "./workspace";

const log = logger.withTag("projen:watch");
const DEBOUNCE_MS = 250;

/** The workspace package roots (absolute), where every watchable source file lives. */
function watchRoots(): string[] {
  return recordedRoots().map((r) => resolve(repoRoot, r));
}

/**
 * Generated paths (barrels, manifests, tsconfigs, decls) must never drive a watch -
 * they change *because* we generate, so reacting would loop.
 */
function ignoredPath(path: string): boolean {
  const abs = isAbsolute(path) ? path : resolve(repoRoot, path);
  return isGeneratedFile(abs);
}

/** The recorded package dir that owns `abs`, if any (for a targeted barrel rebuild). */
function ownerPackageDir(abs: string, pkgDirs: string[]): string | undefined {
  return pkgDirs.find((dir) => abs === dir || abs.startsWith(dir + sep));
}

/**
 * Shared debounce/flush machinery backed by `watchFiles`. Watches `paths` and, on
 * each debounced batch of non-generated changes, calls `onBatch` with the absolute
 * changed paths. Runs are serialized (a change during a run re-runs once afterwards);
 * watches until SIGINT.
 */
function watchLoop(
  tag: string,
  paths: string[],
  onBatch: (changed: string[]) => void | Promise<void>,
): void {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let rerun = false;

  async function flush(): Promise<void> {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    const relevant = [...pending]
      .map((p) => (isAbsolute(p) ? p : resolve(repoRoot, p)))
      .filter((p) => !ignoredPath(p));
    pending.clear();
    try {
      if (relevant.length) await onBatch(relevant);
    } catch (err) {
      log.error(`${tag} cycle failed:`, err instanceof Error ? err.message : err);
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        setTimeout(() => void flush(), 0);
      }
    }
  }

  const watcher = fileScan.watchFiles(paths, {
    cwd: repoRoot,
    ignoreInitial: true,
    ignore: (path) => ignoredPath(path),
  });
  watcher.on("all", (_event, path) => {
    pending.add(path);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  });
  watcher.on("error", (err) => log.error(`${tag} watcher error:`, err));
  watcher.on("ready", () => log.info(`${tag}: watching for changes … (Ctrl-C to stop)`));

  process.on("SIGINT", () => {
    void watcher.close();
    process.exit(0);
  });
}

/**
 * Watch the workspace package roots; a content edit inside an existing package
 * rebuilds just that package's `index.ts` barrel (no re-synth - `projen --watch`
 * owns that). Paths ignored via {@link isGeneratedFile} never drive a rebuild.
 */
export function startBarrelWatch(): void {
  watchLoop("barrels", watchRoots(), (changed) => {
    const pkgDirs = workspacePackages().map((p) => p.dir);
    const dirs = new Set<string>();
    for (const p of changed) {
      const owner = ownerPackageDir(p, pkgDirs);
      if (owner) dirs.add(owner);
    }
    const n = generateBarrels(dirs.size ? { dirs: [...dirs] } : {});
    if (n) log.success(`rebuilt ${n} barrel${n === 1 ? "" : "s"}`);
  });
}

/**
 * Watch the workspace package roots; a changed file that matches {@link isTsoaController}
 * regenerates the openapi packages (spec + client) and rebuilds their barrels.
 * openapi's heavy deps (tsoa/typescript/openapi-typescript) load lazily inside
 * `generateOpenapi`.
 */
export function startOpenapiWatch(): void {
  watchLoop("openapi", watchRoots(), async (changed) => {
    if (!changed.some(isTsoaController)) return;
    const dirs = await generateOpenapi();
    if (dirs.length) {
      generateBarrels({ dirs });
      log.success(`regenerated openapi (${dirs.length} package${dirs.length === 1 ? "" : "s"})`);
    }
  });
}

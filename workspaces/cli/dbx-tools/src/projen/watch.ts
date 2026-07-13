/**
 * The `dbxtools watch` engine: ONE chokidar process (started by
 * `dbxtools sync --watch`, i.e. the `sync` task run with `--watch`) that keeps
 * the generated tree in sync while you edit. It is the SINGLE watcher -
 * projen's own `--watch` is deliberately NOT used, because it does
 * `fs.watch(<repo>, { recursive: true })` and re-runs `.projenrc.ts` on ANY change
 * anywhere in the tree, so a single source edit triggered a full re-synth. This
 * loop re-synths ONLY when it is actually needed, covering three concerns in one
 * debounced pass:
 *
 *   1. **projenrc watch** - `.projenrc.ts` changed (the config itself) -> full
 *      re-synth (+install, since deps may have changed).
 *   2. **new-project watch** - a package folder appeared/disappeared under a root
 *      (the package SET changed vs `pnpm-workspace.yaml`) -> full re-synth.
 *   3. **barrel watch** - a source file changed inside an existing package ->
 *      rebuild just that package's `index.ts` barrel (NO re-synth). A changed tsoa
 *      controller regenerates the openapi packages first.
 *
 * A re-synth regenerates barrels too (`runSynth` sets `PROJEN_DISABLE_POST`, so we
 * call `generateBarrels()` explicitly after it). Generated files are ignored, so
 * the loop never re-triggers itself. chokidar does the watching (the library);
 * everything here is thin glue. Non-`src` config members (rare) still re-synth.
 */
import { resolve, sep } from "node:path";
import { watch } from "chokidar";
import { logger } from "../log";
import { generateBarrels } from "./barrels";
import { isTsoaController } from "./openapi";
import { packageSetChanged, runSynth } from "./scaffold";
import {
  isGeneratedFile,
  isIgnoredPath,
  readWorkspaceMembers,
  recordedRoots,
  repoRoot,
  toPosix,
  workspacePackages,
} from "./workspace";

const log = logger.withTag("projen:watch");
const DEBOUNCE_MS = 250;

/** The projen config file; an edit here is the one thing that must re-synth. */
const PROJENRC = resolve(repoRoot, ".projenrc.ts");

/** `src` dirs of config-only workspace members (e.g. a non-package config member). */
function configSrcDirs(): string[] {
  return readWorkspaceMembers(repoRoot)
    .filter((m) => toPosix(m).split("/").filter(Boolean).length !== 3)
    .map((m) => resolve(repoRoot, m, "src"));
}

/** Vendor/build/generated paths that must never drive the watch. */
function ignored(p: string): boolean {
  return isIgnoredPath(p) || isGeneratedFile(p);
}

/**
 * A path is CONFIG (edit -> re-synth) if it's under a config member's `src`.
 * `.projenrc.ts` is handled separately by its own check (see {@link PROJENRC}).
 */
function isConfigPath(abs: string, configDirs: string[]): boolean {
  return configDirs.some((dir) => abs === dir || abs.startsWith(dir + sep));
}

/** The recorded package dir that owns `abs`, if any (for a targeted barrel rebuild). */
function ownerPackageDir(abs: string, pkgDirs: string[]): string | undefined {
  return pkgDirs.find((dir) => abs === dir || abs.startsWith(dir + sep));
}

/**
 * Re-synth. A package-set change runs the full flow (`post: true`) so pnpm links
 * the new/removed member and the post-synth component rebuilds barrels; a plain
 * config edit stays fast (`post: false`) and rebuilds barrels here.
 */
function resynth(reason: string, withInstall: boolean): void {
  log.start(`${reason} - re-synthesizing${withInstall ? " (+install)" : ""}`);
  runSynth({ post: withInstall });
  const n = withInstall ? -1 : generateBarrels();
  log.success(n < 0 ? "re-synth complete" : `re-synth complete (${n} barrel${n === 1 ? "" : "s"})`);
}

/**
 * Start the watch loop and watch until interrupted. The `sync` command has
 * already brought the tree up to date before calling this (that is what
 * `dbxtools sync --watch` does), so there is no initial synth here - we just
 * watch and react to subsequent edits.
 */
export function startWatch(): void {
  const workspacePackageRoots = recordedRoots().map((r) => resolve(repoRoot, r));
  const watchPaths = [PROJENRC, ...workspacePackageRoots, ...configSrcDirs()];

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
    const batch = [...pending];
    pending.clear();
    try {
      await runCycle(batch);
    } catch (err) {
      log.error("watch cycle failed:", err instanceof Error ? err.message : err);
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        setTimeout(() => void flush(), 0);
      }
    }
  }

  async function runCycle(batch: string[]): Promise<void> {
    const relevant = batch.map((p) => resolve(p)).filter((p) => !ignored(p));
    if (relevant.length === 0) return;

    // A `.projenrc.ts` edit changes the config itself -> full re-synth (+install,
    // since deps may have changed). This is the trigger projen's own `--watch` used
    // to provide, but without its re-synth-on-every-file-in-the-tree overreach.
    if (relevant.includes(PROJENRC)) {
      resynth("projenrc changed", true);
      return;
    }

    const configDirs = configSrcDirs();
    // A config-member src edit or a changed package set -> full re-synth.
    if (relevant.some((p) => isConfigPath(p, configDirs))) {
      resynth("config changed", false);
      return;
    }
    if (packageSetChanged()) {
      resynth("package set changed", true);
      return;
    }

    // 2.5: a tsoa controller changed -> regenerate the openapi packages (spec + client)
    // and rebuild its barrel. openapi is imported lazily (heavy deps).
    if (relevant.some(isTsoaController)) {
      const { generateOpenapi } = await import("./openapi");
      const dirs = await generateOpenapi();
      if (dirs.length) {
        generateBarrels({ dirs });
        log.success(`regenerated openapi (${dirs.length} package${dirs.length === 1 ? "" : "s"})`);
      }
    }

    // 3: content edit inside existing packages -> rebuild the affected barrels.
    const pkgDirs = workspacePackages().map((p) => p.dir);
    const dirs = new Set<string>();
    for (const p of relevant) {
      const owner = ownerPackageDir(p, pkgDirs);
      if (owner) dirs.add(owner);
    }
    const n = generateBarrels(dirs.size ? { dirs: [...dirs] } : {});
    if (n) log.success(`rebuilt ${n} barrel${n === 1 ? "" : "s"}`);
  }

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    ignored: (p: string) => ignored(p),
  });
  watcher.on("all", (_event, path) => {
    pending.add(path);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  });
  watcher.on("error", (err) => log.error("watcher error:", err));
  watcher.on("ready", () => log.info("watching for changes … (Ctrl-C to stop)"));

  process.on("SIGINT", () => {
    void watcher.close();
    process.exit(0);
  });
}

/**
 * Bootstrap a brand-new, completely empty folder into a working dbx-tools
 * workspace: no `package.json`, no projen, maybe no `pnpm` even installed.
 *
 * `pnpm` and `projen` are dependencies of `@dbx-tools/cli` itself, so once it is
 * resolvable (installed, or fetched transiently via `npx dbxtools`) both are
 * already sitting in `node_modules` - no global `npm install -g pnpm`, no PATH
 * lookup, no network access beyond what installing the engine already required.
 * {@link resolvePnpmLauncher} finds pnpm's own CLI entry the same way `./barrels.ts`
 * resolves barrelsby's (`require.resolve`, run via `execFileSync`), falling back to
 * `npx pnpm` only if pnpm can't be resolved as a dependency (a broken/partial install).
 *
 * Never scaffolds workspace-package folders or sample code - just enough for `pnpm exec projen`
 * (or `dbxtools sync`) to work from here on. Drop a
 * `workspaces/<tag>/<name>/src` folder afterward and it's picked up normally.
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { generateBarrels } from "./barrels";
import { logger } from "../log";
import { runSynth } from "./scaffold";
import { repoRoot } from "./workspace";

const log = logger.withTag("projen:bootstrap");

/** A package.json `bin` field: either a single command string, or a name -> path map. */
type BinField = string | Record<string, string>;

/**
 * How to launch pnpm, as a `[command, ...prefixArgs]` argv prefix.
 *
 * Preferred: pnpm's own CLI entry resolved from `@dbx-tools/cli`'s `pnpm`
 * DEPENDENCY and run via this Node - it works before any global/PATH pnpm exists
 * (the point of bootstrap) and can't pick up a different system pnpm. Fallback,
 * only if that dependency can't be resolved (e.g. a broken/partial install where
 * `pnpm` is not on PATH either): `npx -y pnpm`, since `npx` ships with Node.
 */
function resolvePnpmLauncher(): { command: string; prefixArgs: string[] } {
  try {
    const require = createRequire(import.meta.url);
    // pnpm's own `exports` map is `{ ".": "./package.json" }` - the bare specifier
    // (not a "/package.json" subpath, which isn't separately exported) resolves to
    // its manifest directly.
    const pkgJsonPath = require.resolve("pnpm");
    const pkg = require(pkgJsonPath) as { bin: BinField };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pnpm;
    return { command: process.execPath, prefixArgs: [join(dirname(pkgJsonPath), bin)] };
  } catch {
    return { command: "npx", prefixArgs: ["-y", "pnpm"] };
  }
}

/**
 * Run pnpm with `args` in `repoRoot`, using pnpm resolved from the engine's own
 * dependency (or `npx pnpm` if it can't be resolved - see {@link resolvePnpmLauncher}).
 */
function pnpm(args: string[]): void {
  const { command, prefixArgs } = resolvePnpmLauncher();
  execFileSync(command, [...prefixArgs, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

/** True if `repoRoot` has no `package.json` yet, so `pnpm init` must create one. */
function needsPackageJson(): boolean {
  return !existsSync(join(repoRoot, "package.json"));
}

/**
 * True if `repoRoot` is a genuinely uninitialized folder that needs full
 * bootstrapping - keyed off the ABSENCE of `.projenrc.ts`, a projen workspace's
 * hand-authored source of truth (NOT a generated file). Its presence means "already
 * a workspace, just re-synth" even when every generated file - `package.json`,
 * `pnpm-workspace.yaml`, `.projen/*` - has been wiped by `dbxtools clean`. Keying off
 * `package.json` (which `clean` removes) would wrongly re-bootstrap a merely-cleaned
 * workspace, clobbering it with `pnpm init` defaults instead of regenerating from
 * `.projenrc.ts`.
 */
export function needsBootstrap(): boolean {
  return !existsSync(join(repoRoot, ".projenrc.ts"));
}

const PROJENRC_TEMPLATE = `import { DBXToolsNodeProject } from "@dbx-tools/cli";

// Constructs + configures the monorepo root (scans workspaces/ for packages),
// then synthesizes it. Add packages by dropping a workspaces/<tag>/<name>/src
// folder and re-running projen.
const project = new DBXToolsNodeProject();
project.synth();
`;

/**
 * A minimal seed so the very first `pnpm add` (below) can approve `tsx`'s
 * `esbuild` build script non-interactively - pnpm errors on unapproved build
 * scripts with no TTY, and it only reads `allowBuilds` from a
 * `pnpm-workspace.yaml` that doesn't exist yet on a brand-new folder. The real
 * `DBXToolsNodeProject` synth that follows moments later fully regenerates this
 * file (same `allowBuilds` key), so this is purely a bootstrap seed.
 */
const WORKSPACE_SEED = `packages: []
allowBuilds:
  esbuild: true
`;

/**
 * Turn an empty folder into a functioning dbx-tools workspace: `pnpm init`, seed
 * `pnpm-workspace.yaml`, add `projen`/`typescript`/`tsx` + `dbxToolsSpecifier`,
 * write a minimal `.projenrc.ts` (only if one isn't already there), then run a
 * full synth.
 *
 * @param dbxToolsSpecifier - the `pnpm add` specifier for the engine itself.
 * Defaults to the published `@dbx-tools/cli` package; pass a `file:`/`link:`
 * path to test against a local, unpublished build.
 */
export function bootstrapWorkspace(dbxToolsSpecifier = "@dbx-tools/cli"): void {
  log.start(`bootstrapping an empty workspace in ${repoRoot}`);

  if (needsPackageJson()) {
    pnpm(["init"]);
  }
  const workspaceFile = join(repoRoot, "pnpm-workspace.yaml");
  if (!existsSync(workspaceFile)) {
    writeFileSync(workspaceFile, WORKSPACE_SEED);
  }
  // Pinned (not bare "typescript"/"tsx"): an unpinned install can resolve to
  // whatever a registry currently tags "latest", including an unstable prerelease
  // that breaks projen's `tsc`/`tsx` invocation. Matches the versions
  // `DBXToolsNodeProject` itself adds as root devDeps.
  pnpm(["add", "-D", "projen", "typescript@^5.9.3", "tsx@^4.23.0", dbxToolsSpecifier]);

  const projenrc = join(repoRoot, ".projenrc.ts");
  if (!existsSync(projenrc)) {
    writeFileSync(projenrc, PROJENRC_TEMPLATE);
  }

  // `post: false` - skip projen's own post-synth `pnpm install` (it has no
  // non-interactive answer for "first install / remove stale node_modules?"
  // with no TTY). Reconcile the install ourselves right after instead, with
  // `--force`, which is what pnpm's own confirmation logic treats as
  // pre-answering that exact prompt (`confirmModulesPurge` is false whenever
  // `--force` is set) - then regenerate barrels, since skipping projen's
  // post-synth also skips its barrels-on-resynth component.
  runSynth({ post: false });
  pnpm(["install", "--no-frozen-lockfile", "--force"]);
  generateBarrels();
  log.success("workspace ready - drop a workspaces/<tag>/<name>/src folder to add a package");
}

# Bun migration field notes

Findings from migrating a real downstream workspace (7 packages: shared/node/server
tiers plus a React `app`) off pnpm + `tsx` + Vite and onto the bun engine, following
[the migration runbook in `AGENTS.md`](../AGENTS.md). Everything here is a case where
the runbook's happy path was not enough — a silently wrong flag, a watch mode that
does not watch what you expect, a bundler default that breaks a Databricks deploy.

Companion to [Running Bun on Databricks Apps](./running-bun-on-databricks-apps.md)
and [Bun and pnpm caching on Databricks Apps](./bun-and-pnpm-caching-on-databricks-apps.md),
which cover the deploy path. This note covers the local toolchain.

Verified on bun 1.3.14 (macOS arm64), `@dbx-tools/projen` 0.6.48/0.6.49,
node v25.9.0, tsx 4.23.1.

## TL;DR

- **`--env-file-if-exists` does not exist in bun.** It is accepted, exits 0, and
  loads nothing. Use `--env-file`, which already tolerates a missing file.
- **`bun --watch build.ts` does not rebuild when bundler inputs change.** It watches
  its own import graph; your `src/**` is data to it. A `vite build --watch`
  replacement has to do its own watching.
- **Bun's bundler does not copy `public/`.** Vite did. Nothing warns you.
- **Four `Bun.build` options are effectively mandatory for a Databricks App**:
  `splitting`, `publicPath: "/"`, `external` for self-hosted fonts, and
  `sourcemap: "none"`.
- **`runSynth()` in the engine breaks under bun** because it spawns
  `process.execPath --import tsx`, and under bun `process.execPath` is bun.

## `--env-file-if-exists` is silently ignored

The pre-bun engine's `server` tag ran bare `tsx`, which reads no dotenv, so the
task pointed node at the repo-root `.env` with node's
`--env-file-if-exists=../../../.env`. The `-if-exists` form was deliberate: it keeps
a fresh clone working before anyone writes a `.env`, and a deployed app (env injected
by the bundle, no `.env` shipped) unaffected.

Under bun that flag loads nothing, and says nothing about it:

```console
$ cat custom.env
FOO=from_env_file

$ bun probe.ts                                   # baseline
FOO=undefined
$ bun --env-file=custom.env probe.ts
FOO=from_env_file
$ bun --env-file-if-exists=custom.env probe.ts   # accepted, exit 0, no env
FOO=undefined
```

Worse than an error, because the failure surfaces later as a missing credential.
Use `--env-file`; bun's own flag is already tolerant of a missing path
(`bun --env-file=.nope` runs fine), so the `-if-exists` semantics come for free:

```ts
const envFlag = "--env-file=../../../.env";
p.tasks.tryFind("dev")?.reset(`bun --watch ${envFlag} src/server.ts`);
p.tasks.tryFind("start")?.reset(`bun ${envFlag} src/server.ts`);
```

Note when testing this: bun auto-loads a file literally named `.env`, which masks
the bug. Use a non-default filename to see it.

## `bun --watch build.ts` does not watch bundler inputs

`bun --watch` re-runs a script when a module in **that script's import graph**
changes. A build script's inputs are not imports — they are strings passed to
`Bun.build` — so editing a component triggers nothing:

```console
watcher alive at start: yes
builds after startup: 1
=== A: edit BUNDLER INPUT src/entry.ts ===
builds: 1        # <- no rebuild
=== B: edit build.ts itself ===
builds: 2        # <- rebuilt
```

This matters because the obvious `vite build --watch` replacement is
`bun --watch build.ts`, and it appears to work: the watcher is alive, the first
build succeeded, and there is no error. It just never fires again.

Neither of bun's watch modes covers this case:

- **`bun dev.ts`** (the `app` tag's generated dev server) is `Bun.serve` + HMR on
  its own port. Not usable when the API serves the client, because the HTML the API
  returns carries the `__appkit__` config block every AppKit plugin's UI reads its
  endpoints from. A second server serves a page the app cannot boot from.
- **`bun --watch build.ts`** — the above.

So the watching has to be explicit: `fs.watch` the directories the bundle is built
from and spawn `build.ts` as a **child process** per change. A child, not an
in-process `Bun.build`, because a long-lived process keeps serving its first import
of every changed module from bun's module cache.

Two bugs worth knowing about if you write one:

- **A build triggers its own watcher.** Staging `public/` emits a `rename` event
  against a directory the build only reads, so an event-driven rebuild loops
  forever. Guard with a size+mtime fingerprint map and rebuild only when an input
  actually changed — which also absorbs editors that touch metadata without
  changing content.
- **Fingerprint BEFORE spawning the build, not after.** Capturing after makes every
  edit build twice: the first build's own `public/` event lands while the baseline
  still describes the tree from before the edit, so the edit already being compiled
  reads as a fresh change.

Result after both fixes: exactly one rebuild per edit, stable when idle.

## Bun's bundler does not copy `public/`

Bun emits only what the module graph reaches. It has no notion of a static
directory copied verbatim — the Vite convention an existing app is very likely
relying on. Nothing warns; assets just are not in `dist/`.

Stage it yourself, clearing `dist/` first so a rename does not leave the old file
behind (the server serves the directory, so an orphan is indistinguishable from a
current asset):

```ts
async function copyPublicAssets(): Promise<void> {
  await rm(distDir, { recursive: true, force: true });
  await cp(publicDir, distDir, { recursive: true });
}
```

## Four `Bun.build` options a Databricks App needs

In `bun-build.override.ts` (the hand-authored file merged over the generated
`build.ts` options). Each of these was a real failure, not a preference:

- **`splitting: true`** — keeps every emitted file under the **10 MB per-file
  ceiling the Workspace import API enforces**. Unsplit, a client with Cytoscape +
  the Mastra chat + its Shiki grammars + Mermaid lands in one chunk that trips the
  limit and fails **the upload, not the build** — a much worse place to find out.
  Split: largest chunk 2.1 MB across 374 files, 15 MB total, nothing over 10 MB.
- **`publicPath: "/"`** — AppKit's static server rewrites `/*` to the same
  `index.html`, so a page opened at `/runs/<id>/domains` resolves a relative
  `./chunk-x.js` against that path and 404s on its own bundle. Only shows up on
  nested routes, so a smoke test of `/` misses it.
- **`external: ["/fonts/*"]`** — bun inlines a resolvable font as a base64 data URI
  (hundreds of KB of duplicated typeface in the stylesheet). Marking them external
  keeps self-hosted faces as runtime requests. A bare `/fonts/...` `url()` is an
  unresolvable-build **error** without it.
- **`sourcemap: "none"`** — maps were 34 MB against a 14 MB bundle, and all of it
  ships. A deployed app has no use for them.

## The engine's `runSynth()` breaks under bun

`projen/src/scaffold.ts` re-runs synth as:

```ts
exec.spawnSync(process.execPath, ["--import", "tsx", join(repoRoot, ".projenrc.ts")], …)
```

Under bun `process.execPath` **is bun**, so this becomes
`bun --import tsx .projenrc.ts`, and bun cannot load tsx's loader:

```console
$ bun --import tsx .projenrc.ts
error: Cannot find module './cjs/index.cjs' from ''
```

tsx's entry (`dist/loader.mjs`) does `createRequire(import.meta.url)("./cjs/index.cjs")`,
and under bun that resolution loses its referrer (`from ''`). Minimal repros of
`createRequire` with a relative path, across chunks, and through an `exports`-gated
package all resolve fine under bun, so the trigger is narrower than the general
pattern — but the outcome is reliable with real tsx.

The deeper point is that **loading tsx under bun is meaningless anyway**: bun runs
`.ts` natively. The fix is to stop asking for a loader rather than to fix tsx
resolution:

```console
$ PROJEN_DISABLE_POST=true bun .projenrc.ts
exit=0
```

Affects every `runSynth({ post: true })` caller — `tasks/projenrc.ts`,
`tasks/openapi.ts`, `tasks/sync.ts`. Observable downstream as `bun run openapi`
generating the spec correctly and then failing on its follow-up re-synth; `bunx
projen` afterwards works, so it is recoverable but noisy, and a CI step that checks
exit codes will fail on it.

**Suggested fix:** spawn bun with no loader when running under bun — e.g. key off
`process.versions.bun`, or resolve the runner explicitly instead of trusting
`process.execPath` to be node.

## Migration bookkeeping that is easy to miss

- **Bootstrapping a fresh clone is circular.** projen mirrors
  `workspaces`/`catalog` into `package.json` _during_ synth, but synth's post-step
  runs `bun install`, which fails first. Order that works: hand-seed `workspaces`
  (flat array), `catalog`, and `trustedDependencies` in `package.json` plus
  `bunfig.toml`, then `bun install`, then `bunx projen`. `bun install` migrates
  `pnpm-lock.yaml` automatically. Projen's nested `workspaces: {packages, catalog}`
  object also needed normalizing to bun's flat array form once.
- **`allowBuild` is needed for AppKit, not just bun.** Both managers gate install
  scripts, and the Databricks Apps pnpm install treats `ERR_PNPM_IGNORED_BUILDS` as
  a **fatal deploy failure**. Each AppKit package's postinstall stages the assets
  its plugins serve, so a skipped build is a half-installed dependency:

  ```ts
  for (const name of ["@databricks/appkit", "@databricks/appkit-ui"]) {
    project.pnpmWorkspace?.allowBuild(name);
  }
  ```

- **Don't reset root `compile`/`test`.** The engine already fans each out as
  `bun run --filter '*' <task>` in `preSynthesize` and spawns `eslint` from `test`.
  A leftover pnpm-era `reset()` only duplicates steps. `'*'` is bun's
  workspace-member filter, so a vendored non-member tree (`legacy/`) is excluded
  for free.
- **Root-level `.ts` files need an eslint ignore.** A hand-authored `watch.ts`
  beside the generated `dev.ts`/`build.ts` is not in any tsconfig project, so the
  type-aware parser errors on the file instead of linting it. Add
  `javascript.Eslint.of(project)?.addIgnorePattern("**/watch.ts")` on the **root**,
  where the single workspace-wide eslint config lives.
- **Keep `app.yaml` on npm.** A pre-bundled ESM `server.mjs` needs nothing bun
  provides, so adding bun as a container dependency only buys a cold-start binary
  download. Matches the "pnpm installs, bun runs" guidance in the caching note —
  here bun is not even needed to run.
- **Keep esbuild in the app-build script** if it derives a runtime manifest from
  esbuild's `metafile`; that is build-time only and has no bun equivalent yet.

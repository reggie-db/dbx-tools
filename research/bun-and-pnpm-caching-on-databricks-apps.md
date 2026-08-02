# Bun and pnpm caching on Databricks Apps

Follow-up to [Running Bun on Databricks Apps](./running-bun-on-databricks-apps.md).
Covers how the pnpm store and bun's install cache behave on the platform, whether
they can be shared, and the recommended install/run split.

Verified live on Databricks Apps (AWS), CLI v1.6.0. Container: Node v22.16.0,
pnpm 11.0.8, user `app`, `HOME=/home/app`, app code at `/app/python/source_code`.

For the local toolchain rather than the deploy path, see
[Bun migration field notes](./bun-migration-field-notes.md).

## TL;DR

- The platform's build-phase installer is **pnpm**. Its store lives at
  `/home/app/.local/share/pnpm/store` and **persists across code redeploys**.
- `bun install` uses a **separate** cache (`/home/app/.bun/install/cache`) in a
  different, incompatible format. It does **not** reuse pnpm's store, and you
  cannot make it.
- **Best pattern: let pnpm install, use bun only to run.** One cache, no `bun
  install`, full bun runtime.

## Does `bun install` reuse pnpm's warm store?

**No.** Tested by having pnpm fetch `cowsay`/`is-odd` into its store, then running
`bun install` for the same packages in a standalone subproject inside the app.

- Bun created its own cache at `/home/app/.bun/install/cache` (entries like
  `<hash>.npm`). pnpm's store size was unchanged; installed deps were real
  directories, not symlinks into pnpm's `.pnpm`.
- Databricks does **not** pre-warm bun's cache — on a truly fresh container it
  starts empty. The build-phase install is pnpm-only.
- Bun's cache **does** survive redeploys (it's under `$HOME`, like pnpm's store).
  First `bun install` after a fresh container is cold (~0.24 s here); once warm
  it drops ~10x (~0.02 s). A full stop/start resets `$HOME` and re-cools it.

Net: invoking `bun install` means maintaining **two** caches. Both persist across
redeploys, but neither warms the other.

## Can bun be told to use pnpm's cache?

**No — not in any way that reuses pnpm's packages.** Pointing
`BUN_INSTALL_CACHE_DIR` at a populated pnpm store and installing an
already-cached package caused bun to **re-download** it and write its own entries
into that directory alongside pnpm's. The formats are structurally incompatible:

- **pnpm store:** `v11/files/<hh>/<hash>` content-addressable blobs + `index.db`
  (files stripped of package structure, hardlinked out by hash).
- **bun cache:** per-package folders like `is-odd@3.0.1@@localhost@@@1`.

`BUN_INSTALL_CACHE_DIR` / `bunfig.toml` `[install.cache].dir` only relocate
*bun's own* cache; they can't read pnpm's. The only real "reuse" is at the
resolution level: if node_modules already exists, bun runs against it without
downloading.

## Recommended: pnpm installs, bun runs

**Yes — you can (and should) let the platform's `pnpm install` populate
node_modules, then use bun purely as the runtime with no `bun install`.**
Verified end to end: pnpm installed `bun` + `cowsay` + `chalk` at build time, the
run command was `bash -c "bun app.ts"`, and bun `import`ed the pnpm-installed
libraries and served them. App RUNNING.

Why it works: bun's resolver correctly follows pnpm's non-flat node_modules (the
`.pnpm/` virtual store + symlinks), so `import x from "pkg"` resolves against what
pnpm laid down. Bun as a runtime does not care who installed the deps.

Why it's the best pattern on Databricks:

- **One cache, not two.** pnpm does all downloading into its warm, persistent
  store; bun never creates its own cache because you never call `bun install`.
- **Fast, cached deploys.** pnpm warm-store speed (~250 ms–1.7 s, "Already up to
  date" on redeploys) plus bun's runtime performance.
- **Bun still does everything except installing:** `bun app.ts`,
  `bun run <script>`, `bunx <tool>`, bundler, test runner — all operate against
  on-disk node_modules without downloading.

**The one rule:** do not run `bun install` / `bun add` at runtime — that spawns
the separate bun cache and can rewrite the lockfile. Let pnpm own installation,
let bun own execution.

## Minimal shape

**package.json** (pnpm installs these at build)

```json
{ "dependencies": { "bun": "1.3.14", "cowsay": "1.6.0" } }
```

**pnpm-workspace.yaml**

```yaml
allowBuilds:
  bun: true
```

**app.yaml** (bun just runs)

```yaml
command:
  - bash
  - -c
  - bun app.ts
```

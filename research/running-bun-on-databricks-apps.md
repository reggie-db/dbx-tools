# Running Bun on Databricks Apps

Field notes for running the Bun runtime on Databricks Apps — pnpm build-script
gate, PATH resolution, caching, and a minimal working example.

Verified live on Databricks Apps (AWS), CLI v1.6.0. Container: Node v22.16.0,
pnpm 11.0.8, user `app`, `HOME=/home/app`, app code at `/app/python/source_code`.

## TL;DR that works

`package.json` with `bun` as a dependency + `pnpm-workspace.yaml` with
`allowBuilds: { bun: true }` + `app.yaml` command `bash -c "bun yourfile.ts"`.
Bun resolves by bare name, no `PATH` export. Confirmed RUNNING.

## How Databricks installs Node deps

- Package manager is auto-selected by lockfile: **`pnpm-lock.yaml` → pnpm**,
  otherwise npm (pnpm wins if both are present).
- Install runs in a **BUILD phase before your command**, as a **full install
  (NOT `--prod`)** — so `devDependencies` are installed too.
- Never commit `node_modules/` (10 MB/file limit). Commit the lockfile.
- The app must bind `0.0.0.0:$DATABRICKS_APP_PORT` and stay alive, or it goes
  CRASHED. A command that exits 0 is **not** auto-restarted.

## The two gotchas that cause failure

### 1. pnpm's build-script gate is fatal here

The `bun` npm package delivers its real binary via a `postinstall`
(`node install.js`). pnpm 10+ blocks build scripts by default →
`ERR_PNPM_IGNORED_BUILDS: bun@1.3.14`, which **Databricks treats as a fatal
deploy failure** (vanilla pnpm only warns).

- **Fix:** in `pnpm-workspace.yaml` use **`allowBuilds: { bun: true }`**
  (pnpm v10.26.0+). The legacy `onlyBuiltDependencies` field is **deprecated in
  v11 and silently ignored** — do not use it. `pnpm-workspace.yaml` is used
  purely to hold this setting; you do not need a monorepo.
- **Gate-free alternative:** depend directly on `@oven/bun-linux-x64` (the
  Linux x64 prebuilt binary, ~92 MB, **no postinstall → no gate, no
  `allowBuilds` needed**). But it has **no `bin` field**, so it will not give
  you a `bun` command by itself.

### 2. PATH depends on regular-dep vs workspace layout

Runtime `PATH` includes the **root** `node_modules/.bin`
(`…:.venv/bin:node_modules/.bin`) but **not** any workspace *member's* `.bin`.

- `bun` as a **root/top-level dependency** → pnpm links `bun`/`bunx` into root
  `node_modules/.bin` → **bare `bun` works, no PATH export.** Works as
  `dependencies` or `devDependencies` (prefer `dependencies` for runtime
  semantics — see caveat below).
- `bun` as a **workspace member's** dependency → bin lands in
  `packages/<m>/node_modules/.bin`, which is **not** on PATH → bare `bun`
  fails. You would need `export PATH="$PWD/packages/<m>/node_modules/.bin:$PATH"`
  in the command, or hoist the dep to root.

## dependencies vs devDependencies

Both work — Databricks' build-phase install is a full install (not
`--prod`/`--production`), so a `devDependencies` bun is resolved, its
postinstall runs, and its bin lands on PATH exactly like a regular dependency.
Caveat: this relies on Databricks installing everything at build time. If that
ever changed to prod-only, a devDependency would vanish — so for something your
runtime command depends on, `dependencies` is the semantically safer home.
`allowBuilds: { bun: true }` is required either way.

## Caching (good news)

- pnpm keeps a global content-addressable store at
  **`/home/app/.local/share/pnpm/store`**; `node_modules` is hardlinked from it.
  Warm store → installs are ~250 ms–1.7 s even for the 92 MB binary.
- **Code redeploy** (`databricks apps deploy`): `$HOME` (store) persists, the
  app dir is replaced → often "Already up to date," near-instant.
- **stop → start**: fresh container, cold store, full rebuild (~10–12 s) but
  still well under the 10-minute startup limit.

## Writable dirs (if you must shim manually)

- On PATH **and** writable: `.venv/bin`, root `node_modules/.bin`.
- Writable but **not** on PATH: `/home/app/.local/bin`, `/home/app/bin`, `/tmp`.
- Readonly: `/usr/local/bin`, `/usr/bin`, `/bin`.

## Other ways to get a `bun` command (all verified)

- A **first-party package's `postinstall` runs** during the build phase (needs
  its own `allowBuilds: { '@you/pkg': true }`), in the same filesystem as the
  running app, so a symlink it writes into a PATH dir persists to runtime.
  `bun` can be a dependency of that package and is `require.resolve`-able at
  postinstall time.
- A thin **root** launcher package with `bin: { bun: "..." }` that execs
  `@oven/bun-linux-x64/bin/bun` → clean `bun` command, no build gate, no
  postinstall.

## Deploy tooling gotcha

`workspace:*` deps break the CLI's **local** pre-deploy validation (it shells
out to `npm`, which rejects the `workspace:` protocol). Deploy those with
`databricks apps deploy --skip-validation` — the platform-side pnpm install
handles them fine. Non-workspace projects validate normally.

## Minimal working example

**package.json**

```json
{
  "dependencies": { "bun": "1.3.14" }
}
```

**pnpm-workspace.yaml**

```yaml
allowBuilds:
  bun: true
```

**pnpm-lock.yaml** — generate via `pnpm install --lockfile-only` (do not commit
`node_modules`).

**hello.ts**

```ts
const port = Number(process.env.DATABRICKS_APP_PORT ?? 8000);
console.log(`hello world from bun ${Bun.version} — listening on 0.0.0.0:${port}`);
Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch: () => new Response("hello world\n"),
});
```

**app.yaml**

```yaml
command:
  - bash
  - -c
  - bun hello.ts
```

Deploy: `databricks apps deploy -t dev --profile <PROFILE>`.

Result: the build runs bun's postinstall, `bun hello.ts` launches by bare name,
and the app is RUNNING.

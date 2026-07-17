# dbx-tools-js → dbx-tools migration plan

Folding the `dbx-tools-js` monorepo (Bun + tsdown + changesets AppKit add-ons)
into this repo (`dbx-tools`, a projen-driven pnpm monorepo generator), one
building block at a time, bottom of the dependency tree up.

- **Session for handoff:** `3cc495b5-0b97-4cc2-89b9-ba31f9f945d7`
  (resume with `claude --resume 3cc495b5-0b97-4cc2-89b9-ba31f9f945d7`, or pick
  up on another local agent using this id).
- **Working branch:** `fold-js-shared-into-core`
- **Source repo:** `~/Projects/github-reggie-db/dbx-tools-js`
- **Target repo:** `~/Projects/github-reggie-db/dbx-tools`

## Guiding principles (from the user)

1. **Leverage projen + what's already in this repo.** Don't hand-roll project
   structure — that's what the engine (`@dbx-tools/projen`) is for. A new
   package is just a `src/`-bearing folder under `workspaces/`; projen
   auto-discovers it, generates `package.json`/`tsconfig`/barrel. Per-package
   deps/config go through a mixin in `.projenrc.ts`.
2. **Copy piece by piece, limit new dependencies, omit what's not needed.** A
   lot of `-js` code was project-structuring (its `cli` package: workspace
   walk, package.json writing, release scaffolding) — that's superseded by
   projen and must NOT be copied.
3. **Ask before design decisions.** Package boundaries, where something lands,
   new deps, naming — surface these rather than guessing.
4. **Reuse ported utilities.** When a helper lands (e.g. `string.toSlug`), use
   it to replace bespoke copies elsewhere in the repo.
5. **Naming: don't over-use `protocol`.** The barrel namespaces by filename, so
   `protocol.ServingEndpointSummary` reads confusingly. Name the file after its
   domain: `model.ts` → `model.ServingEndpointSummary`; for genie use
   `genie-model.ts` or similar.
6. **Docstrings: review/refresh on the way in.** No agent-speak ("ported from",
   "no longer used"). No `@deprecated` shims — just remove, or ask.
7. **Generated files are read-only + carry a do-not-edit header.** Written into
   `src/` so barrelsby picks them up like any other module.
8. **Always commit AND push every edit** (including in-flight parallel edits).
   Branch off `main` first (already done: `fold-js-shared-into-core`).

## Conventions in the target repo

- **shared-core** (`workspaces/shared/core` → `@dbx-tools/shared-core`):
  dependency-free, **browser-safe** runtime helpers (agnostic tag, `WebWorker`
  lib — web-standard globals, no node types, no DOM). Concern-split modules,
  namespaced barrel (`export * as async/error/hash/string/object/runtime/...`).
  Consumers write `string.toSlug(...)`, `error.errorMessage(...)`, etc.
- **node-core** (`workspaces/node/core` → `@dbx-tools/node-core`): the Node-only
  half of the shared runtime — `exec` (child_process) + `project` (fs/path repo
  roots). Auto-tagged `node` (node types, ES2022 lib) by living under
  `workspaces/node/`. Anything needing `child_process`/`fs`/`process` depends on
  node-core; keep shared-core browser-safe. `async`/`hash`/`object`/`runtime` stay in
  shared-core — they're isomorphic (web-standard `AbortSignal`/`URL`/`crypto`).
- **shared-core is a universal base dep.** A blanket mixin in `.projenrc.ts`
  adds `@dbx-tools/shared-core@workspace:*` to EVERY workspace package (any tag,
  except shared-core itself), so per-package mixins never declare it. It's light
  and browser-safe — when in doubt, reach for shared-core.
- **`workspaces/node/` = Node-tagged tier, `workspaces/shared/` = browser-safe.**
  A package's folder path drives its tag: put anything that touches `node:*` /
  `child_process` / a Node-only dep under `workspaces/node/` (auto-tags `node`).
  Node-tagged packages: `node-core`, `node-appkit`, `node-file-scan`,
  `node-genie`, `projen` (the engine). Browser-safe (`shared`): `shared-core`,
  `shared-genie`, `shared-model`, `shared-sdk-model`.
- **Extensionless relative imports** (`./model`, not `./model.js`) — the repo
  uses `moduleResolution: bundler`. Strip `.js` from every ported import.
- **Tests:** `node:test` + `node:assert/strict` (NOT `bun:test`/`expect`), run
  via `tsx --test 'test/**/*.test.ts'`. The projen `.gitignore` ignores
  `**/*.test.*`, so **force-add** test files (`git add -f`) — `file-scan` and
  `shared-model` already do this.
- **Prettier:** 2-space, double quotes, semicolons, trailing commas, width 100.
  Run `npx prettier --write` on ported files before committing.
- **Scope preservation:** `PackageIdentifier.of` names packages from folder
  paths. The leading scope segment goes through `string.toSlug` (round-trips
  `dbx-tools` intact); later path segments through `string.tokenize`. Do NOT
  reintroduce a path-preserving `toSlugParts`.

## `-js` internal dependency tree (bottom-up order)

```
shared            LEAF   ✅ DONE (browser-safe half → shared-core; node half → node-core; log + logger in core)
sdk-shared        LEAF   ✅ DONE (as shared-sdk-model, via new codegen subsystem)
model-shared      LEAF   ✅ DONE (as shared-model)
appkit-email-shared LEAF        (zod contract, feature-specific — not started)
genie-shared      → sdk-shared, shared   ✅ DONE (as shared-genie)
genie             → genie-shared, shared (+ @databricks/sdk-experimental)   ✅ DONE (as node-genie; SDK glue → node-appkit)
model             → model-shared, shared   ⏭  NEXT
model-proxy       → model, shared
appkit-config     → shared
appkit-ui         → shared
appkit-email      → appkit-email-shared, shared
appkit-email-ui   → appkit-email-shared, appkit-ui, shared
genie-shared/…    (see genie family above)
appkit-mastra-shared → genie-shared, model-shared
appkit-mastra     → appkit-mastra-shared, genie, model, shared
appkit-mastra-ui  → appkit-email-ui, appkit-mastra-shared, appkit-ui, genie-shared, shared
cli               LEAF   ⛔ SUPERSEDED by projen — do NOT port
```

## Completed work (commits on `fold-js-shared-into-core`)

| Commit | What |
|---|---|
| `383e1b4` | Port `-js shared` helpers → shared-core (`async`, `equal`, `error`, `hash`, `value`, `string`). Skipped `memoize`/`iterable` (already present). `poll`'s `distinct` uses a new dependency-free `deepEqual` (with optional comparator). |
| `cb57991`, `9730812` | Remove duplicate slug logic; package naming now uses shared-core `string.tokenize`/`toSlug`. Deleted `toSlugParts`/`toNameParts`. |
| `8a69baa` | Fix shared mixin self-dependency + negated-guard narrowing in `predicate.ts`. |
| `96b5357` | Port `model-shared` → `@dbx-tools/shared-model` (agnostic `[shared]`, zod). Tidy `.projenrc.ts` (extract `pkg()` + `applyRootDirTsconfig()` helpers, section headers, drop stray `console.log`). |
| `cf4a75b` | Rename shared-model `protocol.ts` → `model.ts`; force-add its test. |
| `8c94f10` | **Codegen subsystem + `shared-sdk-model`** — see below. |
| `6901ffa` | **Codegen on synth (drop task/watch) + port `genie-shared` → `@dbx-tools/shared-genie`** — see below. |
| `0d8e6c1` | **Browser-safe core split**: `exec`/`project` → new `@dbx-tools/node-core`; shared-core now agnostic (`WebWorker` lib); file-scan retagged `node`; AppKit + sdk-experimental hardcoded in `DEFAULT_CATALOG`. See "Resolved: browser-safe core split" below. |
| `f64806a` | **Barrel type-hoisting + `log` in core + `node-appkit` + port `genie` server → `@dbx-tools/node-genie`.** See "Barrel type-hoisting", "node-appkit", and "node-genie" below. |
| `0616cd7` | **Move `file-scan` under `workspaces/node/`**: `@dbx-tools/shared-file-scan` → `@dbx-tools/node-file-scan` (path now matches its `node` nature). |
| (pending commit) | **shared-core is a universal base dep** (added to every workspace package via the blanket mixin, any tag) + **move `projen` engine under `workspaces/node/`** (`@dbx-tools/projen`, `node`-tagged by path). Fixed stale `@dbx-tools/shared-projen` name refs in the CLI bootstrap + engine-root (published name is `@dbx-tools/projen`). |

### shared-core surface now available

`async` (poll/sleep/tieAbortSignal), `error`
(errorMessage/errorMessages/errorNodes/toError), `hash`
(fnvHash/fnvHashWithOptions/toBase32/id), `string`
(tokenize/tokenizeWithOptions/toIdentifier/toSlug/toUniqueSlug/trimToNull/
firstNonEmpty/escapeHtml/toDescription), `object`
(isRecord/toBoolean/deepEqual/NameLike/NonFunctionKeys/DeepEqualComparator), `runtime` (isDatabricksAppEnv),
`log` (logger/isLevelEnabled), plus `functionModule` (memoize), `iterable`,
`predicate`. NOTE: `exec` + `project` moved to **node-core** (not shared-core).

`-js`'s `commonUtils.*` / `stringUtils.*` map onto these: e.g.
`commonUtils.errorMessage` → `error.errorMessage`,
`stringUtils.tokenizeWithOptions` → `string.tokenizeWithOptions`,
`commonUtils.poll` → `async.poll`, `commonUtils.fnvHash` → `hash.fnvHash`.

## Codegen subsystem (commit `8c94f10`; refined to synth-time in the pending commit)

Ported `-js`'s `dbxtools codegen` into the projen engine.

Files:
- `workspaces/node/projen/src/codegen.ts` — `generateCodegen()`. Scans
  `workspacePackages()` for a `package.json` `codegen.inputs` field, runs each
  `.d.ts` through `stripImports` (TS compiler API drops imports, rewrites
  imported type refs → `unknown`) + `preprocess` (export-promote, JSDoc →
  `@description`) → `ts-to-zod`. Writes read-only `src/<name>.ts` (schemas +
  inferred types), cleans stale generated modules. Uses
  `header()`/`makeReadonly()`/`makeWritable()`/`isReadonly()` from
  `generated.ts`. **No Bun APIs** — portable Node fs.
- `src/project.ts` — the post-synth component (renamed `GeneratedBarrels` →
  `GeneratedSource`) now runs `generateCodegen()` then `generateBarrels()` on
  every synth's `postSynthesize` pass (after `NodeProject`'s own install, so
  `node_modules/...` inputs resolve; before barrels, so a freshly generated
  module gets namespaced in the same pass).
- `.projenrc.ts` — `ts-to-zod` in the projen engine deps;
  `@databricks/sdk-experimental` catalog entry; the `shared-sdk-model` mixin
  (zod dep, SDK devDep, `codegen.inputs` field).

Engine dep added: **`ts-to-zod`** (only new external dep; uses the already-present
`typescript`). Verified: synth generates 74 zod schemas from the Databricks
dashboards `.d.ts` into `workspaces/shared/sdk-model/src/dashboards.ts`
(read-only, idempotent), barrel exposes `dashboards`, compiles clean.

### Codegen runs on synth — no task, no watcher (pending commit)

Per the user: codegen inputs (the SDK `.d.ts`) change rarely, so a standalone
`codegen` task and a `sync --watch` watcher are overkill. Removed both
(`registerRootTasks` no longer registers `codegen`; the `codegen --watch` entry
is gone from `tasks/sync.ts`; `tasks/codegen.ts` and the now-unused
`isCodegenInput` export are deleted). Codegen now runs only as part of synth's
post-synthesize pass (see `GeneratedSource`). This also dissolves the old
chicken-and-egg bootstrap note: a brand-new codegen package's `src/` is seeded
by the same synth that discovers it (post-synth runs after discovery), so no
manual stub is needed going forward.

## `shared-sdk-model` (commit `8c94f10`)

- `workspaces/shared/sdk-model` → `@dbx-tools/shared-sdk-model`, tag
  `[shared]`. `zod` runtime dep, `@databricks/sdk-experimental` devDep,
  `codegen.inputs` = the dashboards `model.d.ts`.
- `src/dashboards.ts` is fully generated (read-only). Barrel:
  `export * as dashboards`. Consumers use
  `dashboards.genieMessageSchema` etc.
- Replaces `-js`'s `sdk-shared`. The 5 schemas `genie-shared` needs are all
  present: `genieSpaceSchema`, `messageStatusSchema`, `genieQueryAttachmentSchema`,
  `genieAttachmentSchema`, `genieMessageSchema` (+ `MessageStatus` type).

## `shared-genie` (NEW — pending commit)

Ported `-js genie-shared` → `@dbx-tools/shared-genie`, tag `[shared]`
(browser-safe zod contracts + event vocabulary + detectors). Server-side `genie`
(chat/space driver) is a separate, larger follow-up — see NEXT.

- `src/genie-model.ts` ← `-js genie-shared/src/protocol.ts`. Renamed per the
  naming rule so the barrel reads `genieModel.GenieMessageSchema`. SDK schemas
  imported via **option (a)**: `import { dashboards } from
  "@dbx-tools/shared-sdk-model"`, then destructure-alias the 5 it extends
  (`const { genieMessageSchema: SDKGenieMessageSchema, ... } = dashboards`), and
  `export type MessageStatus = dashboards.MessageStatus`. Keeps the generated
  sdk-model barrel clean (no hand-written flat re-export).
- `src/event.ts` ← `-js genie-shared/src/event.ts`. Import repointed
  `./protocol.js` → `./genie-model`.
- Shared helper repoint: `stringUtils.tokenizeWithOptions` →
  `string.tokenizeWithOptions` (`import { string } from "@dbx-tools/shared-core"`).
- Mixin: `pkg("*/shared-genie", "shared")` adds `zod@catalog:` +
  `@dbx-tools/shared-sdk-model@workspace:*` (shared-core is free via the blanket
  shared mixin).
- **Test:** ported `-js genie/test/event.test.ts` → `test/event.test.ts` on
  `node:test` + `node:assert/strict` (force-added past the `.test.*` gitignore).
  38 tests pass. One porting nuance: `node:assert` `deepEqual` is strict about
  present-but-`undefined` keys where Bun's `toEqual` ignored them, so exact
  detector-output comparisons go through a local `equalPayload` helper that
  prunes `undefined` keys first.

### ✅ Resolved: browser-safe core split (`node-core`) + isomorphic lib

The earlier rough edge — a browser-safe consumer type-checking core's
node-dependent source under its own node-free tsconfig — is fixed by splitting
core, not by references:

- **`exec` + `project` → `@dbx-tools/node-core`** (`workspaces/node/core`,
  auto-tagged `node`). These are the only genuinely Node-only core modules
  (import `node:*`, use `Buffer`/`process.cwd()`/`import.meta.main`), and had
  zero internal deps, so they extracted cleanly. Repointed all importers (cli,
  projen, file-scan) — every one was already `node`-tagged.
- **shared-core is now browser-safe** (dropped its `node` tag + `types:["node"]`
  override). `async`/`hash`/`object`/`runtime` stayed — they're isomorphic (web-standard
  `AbortSignal`/`URL`/`crypto`, guarded `process` read off `globalThis`).
- **Agnostic tsconfig floor gained the `WebWorker` lib** (`AGNOSTIC_COMPILER_OPTIONS`
  in `tags.ts`) so isomorphic code type-checks its web-platform globals without
  DOM or node types. The `node` tag's lib was bumped ES2020 → ES2022 (Node 18+;
  `exec` uses `Array.at`/`Error.cause`).
- **file-scan** was retagged `node` (it shells out + uses chokidar/console) — it
  had been mis-typed `shared` and silently failing whole-program compile. In the
  pending commit it also MOVED to `workspaces/node/file-scan` and was renamed
  `@dbx-tools/shared-file-scan` → `@dbx-tools/node-file-scan` so its path matches
  its `node` nature (the `node` tag auto-applies; only the projen engine consumes
  it, so the repoint was contained).

Result: `shared-core` and `shared-genie` (and every package) compile clean;
38/38 genie tests pass. AppKit + sdk-experimental are now hardcoded engine
defaults in `DEFAULT_CATALOG` (this repo is Databricks-steered), so the per-repo
`addCatalog` overrides were dropped.

## Barrel type-hoisting (NEW — pending commit)

The barrel generator now HOISTS type exports to each package's top level, on top
of the `export * as <ns>` namespace lines. A TYPE (interface / type alias /
`export type`) that is UNIQUE across the package (declared in exactly one module)
is re-emitted as `export type { X } from "./src/mod"`, so consumers write
`GenieMessage` instead of `genieModel.GenieMessage`. Rules:

- **Types only.** Values (functions, classes, consts, enums) are NOT hoisted -
  they keep the module namespace (`string.toSlug(...)`), so runtime call sites
  stay explicitly namespaced. (Per user direction.)
- **Unique only.** A type name declared by 2+ modules is ambiguous → namespace-only.
- **No namespace collisions.** A type whose name equals a generated namespace id
  (e.g. a `mixin` value's module) is left namespace-only.
- **`export type { ... }`** is required under `isolatedModules` (TS1205).
- A hand-authored `exports.ts` still wins; names it declares aren't hoisted.

Implementation: `workspaces/node/projen/src/module-exports.ts` extracts a
module's own named exports via **oxc-parser** (fast, TS-aware; `exportKind`
distinguishes type vs value, declaration kinds tag interfaces/aliases).
Overloaded functions are de-duped per module. `barrels.ts` tallies type-name
uniqueness across the package's modules and appends the `export type { ... }`
lines. Engine dep added: **`oxc-parser`**. Existing consumers were rewritten to
the flat type form (`iterable.OneOrMany` → `OneOrMany`, `predicate.Predicate` →
`Predicate`, `async.PollContext` → `PollContext`, etc.), keeping namespaces only
for value calls.

## `log` in shared-core (NEW — pending commit)

Ported `-js shared/log.ts` → `shared-core/src/log.ts` — the one logger the whole
monorepo shares (`log.logger("tag")`, `log.isLevelEnabled`). Browser-safe:
`process` / `Bun` / `window` reached through `globalThis` and guarded; consola
and `node:util` load lazily (console fallback covers their absence). consola is
an **optional peer** of shared-core (`peerDependenciesMeta.optional`), pinned via
the hardcoded `DEFAULT_CATALOG` `consola` entry.

## `node-appkit` (NEW — pending commit)

`@dbx-tools/node-appkit` (`workspaces/node/appkit`, `node`-tagged) — the base for
Node-side AppKit + experimental-SDK helpers. Houses `context.ts`: the SDK
`Context`/`AbortSignal` adapter (`toContext`, `ContextLike`) ported from `-js`
`apiUtils`, using shared-core `async.tieAbortSignal`. The SDK is a runtime dep
here so the browser-safe shared-core stays SDK-free. (Only the cancellation glue
genie needs was ported; `errorContext`/`getWorkspaceUrl`/`getWorkspaceId` were
left for a later pass.)

## `node-genie` (NEW — pending commit) — server chat/space driver

Ported `-js genie` → `@dbx-tools/node-genie` (`workspaces/node/genie`,
`node`-tagged): `chat.ts` (`genieChat` low-level poll stream + `genieEventChat`
event stream) and `space.ts` (`getGenieSpace` + `genieSampleQuestions`). Import
repoints: `logUtils.logger` → `log.logger`; `apiUtils.toContext`/`ContextLike` →
node-appkit `context.*`; `commonUtils.poll`/`PollContext` → `async.poll` /
flat `PollContext`; `commonUtils.errorMessage` → `error.errorMessage`;
`stringUtils.firstNonEmpty` → `string.firstNonEmpty`; genie-shared values via the
`genieModel`/`event` namespaces, types flat. `@databricks/appkit` is an OPTIONAL
peer (lazy-imported; env-var auth fallback). The `-js` `chat.ts`/`poll-chat.ts`
runtime smoke tests were NOT ported (they hit a live workspace).

## Later passes (not yet scoped)

- `model` / `model-proxy` — server model resolution/ranking + local OpenAI proxy.
- `appkit-*` family — needs `@databricks/appkit` (peer), React (`ui` tag), Mastra.
  These are the heaviest; scope each individually.
- `appkit-email-shared` — small zod contract, easy, can slot in anytime.

## How to verify a pass

```sh
cd ~/Projects/github-reggie-db/dbx-tools
pnpm exec projen                       # synth: discover + generate + install
(cd workspaces/shared/<pkg> && pnpm exec projen compile)   # type-check
(cd workspaces/shared/<pkg> && pnpm exec projen test)      # node:test
pnpm dbxtools barrels                   # regenerate barrels
# confirm existing package names/tags unchanged (snapshot before/after)
```

Existing packages' names and tags must stay unchanged across a pass — snapshot
`package.json` `name` + `dbxToolsConfig.tags` before/after synth and diff.

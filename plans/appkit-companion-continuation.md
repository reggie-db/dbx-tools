# AppKit companion continuation plan

Continuing the AppKit companion package work inside this projen-driven pnpm
monorepo. The target shape is a set of focused `@dbx-tools/*` packages that
augment Databricks AppKit while keeping runtime boundaries clear:
browser-safe contracts in `workspaces/shared`, Node/AppKit integrations in
`workspaces/node`, CLIs in `workspaces/cli`, and React/Vite foundations in
`workspaces/ui`.

This file tracks completed package work, current conventions, and follow-up
items needed to make the repo easier to publish, document, and maintain.

## Guiding principles (from the user)

1. **Leverage projen + what's already in this repo.** Don't hand-roll project
   structure — that's what the engine (`@dbx-tools/projen`) is for. A new
   package is just a `src/`-bearing folder under `workspaces/`; projen
   auto-discovers it, generates `package.json`/`tsconfig`/barrel. Per-package
   deps/config go through a mixin in `.projenrc.ts`.
2. **Copy piece by piece, limit new dependencies, omit what's not needed.** A
   lot of historical code was project-structuring (workspace walk,
   package.json writing, release scaffolding) — that's superseded by projen and
   must NOT be copied.
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
8. **Always commit AND push every edit** when working in a commit-oriented
   session.

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
  Node-tagged packages: `node-core`, `node-appkit`, `node-appkit-mastra`,
  `node-databricks`, `node-databricks-zerobus`, `node-email`, `node-genie`,
  `node-model`, `node-path`, `projen` (the engine). Browser-safe (`shared`):
  `shared-core`, `shared-email`, `shared-genie`, `shared-mastra`, `shared-model`,
  `shared-sdk-model`.
- **Extensionless relative imports** (`./model`, not `./model.js`) — the repo
  uses `moduleResolution: bundler`. Strip `.js` from every ported import.
- **Tests:** `node:test` + `node:assert/strict` (NOT `bun:test`/`expect`), run
  via `tsx --test 'test/**/*.test.ts'`. The projen `.gitignore` ignores
  `**/*.test.*`, so **force-add** test files (`git add -f`) — `file-scan` and
  `shared-model` already do this.
- **Prettier:** 2-space, double quotes, semicolons, trailing commas, width 100.
  Run `npx prettier --write` on ported files before committing.
- **READMEs are hand-written, not generated.** The engine's `initProject` drops
  projen's `sample README placeholder` SampleReadme component, so a package `README.md` is
  owned entirely outside projen (never read-only, never overwritten on synth).
  Write a real one per package from current behavior in code and adjacent package
  READMEs; do it at the end of a package pass to avoid churn mid-step.
- **Scope preservation:** `PackageIdentifier.of` names packages from folder
  paths. The leading scope segment goes through `string.toSlug` (round-trips
  `dbx-tools` intact); later path segments through `string.tokenize`. Do NOT
  reintroduce a path-preserving `toSlugParts`.

## Package dependency tree (bottom-up order)

```
shared            LEAF   ✅ DONE (browser-safe half → shared-core; node half → node-core; log + logger in core)
sdk-shared        LEAF   ✅ DONE (as shared-sdk-model, via new codegen subsystem)
model-shared      LEAF   ✅ DONE (as shared-model)
appkit-email-shared LEAF   ✅ DONE (as shared-email)
genie-shared      → sdk-shared, shared   ✅ DONE (as shared-genie)
genie             → genie-shared, shared (+ @databricks/sdk-experimental)   ✅ DONE (as node-genie; SDK glue → node-appkit)
model             → model-shared, shared   ✅ DONE (as node-model; AppKit glue → node-appkit)
model-proxy       → model, shared   ✅ DONE (as cli/model-proxy → @dbx-tools/model-proxy)
appkit-config     → shared   ✅ DONE (folded into node-appkit: config + createApp/lakebase auto-config; `appkit-env` CLI)
appkit-ui         → shared   (React `ui` tag — deferred, skip -ui pass)
appkit-email      → appkit-email-shared, shared   ✅ DONE (as node-email)
appkit-email-ui   → appkit-email-shared, appkit-ui, shared
genie-shared/…    (see genie family above)
appkit-mastra-shared → genie-shared, model-shared   ✅ DONE (as shared-mastra)
appkit-mastra     → appkit-mastra-shared, genie, model, shared   ✅ DONE (as node-appkit-mastra)
appkit-mastra-ui  → appkit-email-ui, appkit-mastra-shared, appkit-ui, genie-shared, shared
zerobus           → shared (+ @databricks/zerobus-ingest-sdk)   ✅ DONE (as node-databricks-zerobus; cloud/workspace infra → node-databricks)
cli               LEAF   ⛔ SUPERSEDED by projen — do NOT port
```

## Completed work

| Commit               | What                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `383e1b4`            | Port `shared` helpers → shared-core (`async`, `equal`, `error`, `hash`, `value`, `string`). Skipped `memoize`/`iterable` (already present). `poll`'s `distinct` uses a new dependency-free `deepEqual` (with optional comparator).                                                                                                                                                                                                         |
| `cb57991`, `9730812` | Remove duplicate slug logic; package naming now uses shared-core `string.tokenize`/`toSlug`. Deleted `toSlugParts`/`toNameParts`.                                                                                                                                                                                                                                                                                                          |
| `8a69baa`            | Fix shared mixin self-dependency + negated-guard narrowing in `predicate.ts`.                                                                                                                                                                                                                                                                                                                                                              |
| `96b5357`            | Port `model-shared` → `@dbx-tools/shared-model` (agnostic `[shared]`, zod). Tidy `.projenrc.ts` (extract `pkg()` + `applyRootDirTsconfig()` helpers, section headers, drop stray `console.log`).                                                                                                                                                                                                                                           |
| `cf4a75b`            | Rename shared-model `protocol.ts` → `model.ts`; force-add its test.                                                                                                                                                                                                                                                                                                                                                                        |
| `8c94f10`            | **Codegen subsystem + `shared-sdk-model`** — see below.                                                                                                                                                                                                                                                                                                                                                                                    |
| `6901ffa`            | **Codegen on synth (drop task/watch) + port `genie-shared` → `@dbx-tools/shared-genie`** — see below.                                                                                                                                                                                                                                                                                                                                      |
| `0d8e6c1`            | **Browser-safe core split**: `exec`/`project` → new `@dbx-tools/node-core`; shared-core now agnostic (`WebWorker` lib); file-scan retagged `node`; AppKit + sdk-experimental hardcoded in `DEFAULT_CATALOG`. See "Resolved: browser-safe core split" below.                                                                                                                                                                                |
| `f64806a`            | **Barrel type-hoisting + `log` in core + `node-appkit` + port `genie` server → `@dbx-tools/node-genie`.** See "Barrel type-hoisting", "node-appkit", and "node-genie" below.                                                                                                                                                                                                                                                               |
| `0616cd7`            | **Move the path toolkit under `workspaces/node/`**. The current package is `@dbx-tools/node-path`, covering find, match, ignore, scan, and watch helpers.                                                                                                                                                                                                                                                                                  |
| `f660b77`            | **shared-core is a universal base dep** (added to every workspace package via the blanket mixin, any tag) + **move `projen` engine under `workspaces/node/`** (`@dbx-tools/projen`, `node`-tagged by path).                                                                                                                                                                                                                                |
| `1a30148`            | Split shared-core `value.ts` → `object.ts` (isRecord/toBoolean/NameLike/NonFunctionKeys) + `runtime.ts` (isDatabricksAppEnv).                                                                                                                                                                                                                                                                                                              |
| `2be03d0`            | Fold `deepEqual`/`DeepEqualComparator` into `object.ts`; drop `equal.ts`.                                                                                                                                                                                                                                                                                                                                                                  |
| `c11c842`            | **Port `model` server → `@dbx-tools/node-model`** + reorganize node-appkit into `databricks.ts` (SDK glue: `toContext`/`ContextLike`/`isAppEnv`) / `appkit.ts` (execution context: `WorkspaceClientLike`/`tryGetExecutionContext`/`ensureInitialized`) / `plugin.ts` (plugin lookup: `data`/`instance`/`require`). Moved `isDatabricksAppEnv` out of shared-core `runtime.ts` → `databricks.isAppEnv` (Node-only). See "node-model" below. |
| `45ab168`            | **Port `model-proxy` → `@dbx-tools/model-proxy`** (`workspaces/cli/model-proxy`, `cli`-tagged, ships the `model-proxy` bin). See "model-proxy" below.                                                                                                                                                                                                                                                                                      |
| `e7065e1`            | **READMEs are hand-written** (engine no longer seeds projen's `sample README placeholder` SampleReadme; `initProject` drops the README component). Wrote real READMEs for all ported packages. **Port `appkit-email-shared` → `@dbx-tools/shared-email`** (browser-safe zod email contract).                                                                                                                                               |
| `867d4b3`            | **Config subsystem + port `appkit-config`.** Added `config` (app.yaml/bundle/env resolution) to node-appkit and `name`/`resolveProjectRoots`/`parseGitRemote`/`stat` to node-core's `project`. (appkit-config first landed as its own package here.)                                                                                                                                                                                       |
| `ea50ded`            | **Fold `appkit-config` into `node-appkit`** (it added no deps beyond `@databricks/appkit`, already present) + extract the env CLI to **`@dbx-tools/appkit-env`** (`cli/appkit-env`, `appkit-env` bin). Port `net` (URL/email/IP helpers) into shared-core. **Port `appkit-email` → `@dbx-tools/node-email`** (SMTP/outbox, markdown->HTML, sender policy, `send_email` Mastra tool, AppKit `email` plugin).                                |
| `7d05a94`            | **New `@dbx-tools/node-databricks`** (generic Databricks/cloud infra, no AppKit requirement: workspace URL/id + cloud provider/region + node DNS) + **port `zerobus` → `@dbx-tools/node-databricks-zerobus`**. See "node-databricks" below.                                                                                                                                                                                                |
| `8ca913f`            | **Port `appkit-mastra-shared` → `@dbx-tools/shared-mastra`** (browser-safe wire contract; `protocol.ts` → `wire.ts`).                                                                                                                                                                                                                                                                                                                      |
| `9e60173`            | **Port `appkit-mastra` → `@dbx-tools/node-appkit-mastra`** (the full AppKit Mastra agent layer, one package). Added `net`/`http`/`token`/`error.errorContext` to shared-core along the way. **Server-side migration complete.** See "shared-mastra + node-appkit-mastra" below.                                                                                                                                                            |
| `3b4fbe7`            | **projen engine uses shared-core `log`**; deleted its own `log.ts`. Added `success`/`start` to shared-core `Logger`; moved `pluralize` → shared-core `string`.                                                                                                                                                                                                                                                                             |
| (pending commit)     | **Rename `node-file-scan` → `@dbx-tools/node-path`** (`workspaces/node/path`). It's the path toolkit (find/match/ignore/scan/watch), not just file matching. Only the projen engine consumed it.                                                                                                                                                                                                                                           |

### shared-core surface now available

`async` (poll/sleep/tieAbortSignal), `error`
(errorMessage/errorMessages/errorNodes/toError), `hash`
(fnvHash/fnvHashWithOptions/toBase32/id), `string`
(tokenize/tokenizeWithOptions/toIdentifier/toSlug/toUniqueSlug/trimToNull/
firstNonEmpty/escapeHtml/toDescription/pluralize), `object`
(isRecord/toBoolean/deepEqual/NameLike/NonFunctionKeys/DeepEqualComparator),
`log` (logger/isLevelEnabled; `Logger` has debug/info/warn/error + `success`/
`start` consola sugar), `net` (urlBuilder/parseEmails/isEmail/parseIp/parseCidr/
ipInCidr), `http`, `token`, `error.errorContext`, plus `functionModule`
(memoize), `iterable`, `predicate`. NOTE: `exec` + `project` moved to
**node-core**; `isDatabricksAppEnv` moved to **node-appkit**
(`databricks.isAppEnv`) — neither is in shared-core. The **projen engine uses
shared-core `log`** (its own `log.ts` was deleted); `pluralize` moved to
shared-core `string`.

Historical `commonUtils.*` / `stringUtils.*` helpers map onto these: e.g.
`commonUtils.errorMessage` → `error.errorMessage`,
`stringUtils.tokenizeWithOptions` → `string.tokenizeWithOptions`,
`commonUtils.poll` → `async.poll`, `commonUtils.fnvHash` → `hash.fnvHash`.

## Codegen subsystem (commit `8c94f10`; refined to synth-time in the pending commit)

Codegen now lives in the projen engine.

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
- Replaces the older SDK schema package. The 5 schemas `genie-shared` needs are all
  present: `genieSpaceSchema`, `messageStatusSchema`, `genieQueryAttachmentSchema`,
  `genieAttachmentSchema`, `genieMessageSchema` (+ `MessageStatus` type).

## `shared-genie` (NEW — pending commit)

Ported `original genie-shared` → `@dbx-tools/shared-genie`, tag `[shared]`
(browser-safe zod contracts + event vocabulary + detectors). Server-side `genie`
(chat/space driver) is a separate, larger follow-up — see NEXT.

- `src/genie-model.ts` ← `original genie-shared/src/protocol.ts`. Renamed per the
  naming rule so the barrel reads `genieModel.GenieMessageSchema`. SDK schemas
  imported via **option (a)**: `import { dashboards } from
"@dbx-tools/shared-sdk-model"`, then destructure-alias the 5 it extends
  (`const { genieMessageSchema: SDKGenieMessageSchema, ... } = dashboards`), and
  `export type MessageStatus = dashboards.MessageStatus`. Keeps the generated
  sdk-model barrel clean (no hand-written flat re-export).
- `src/event.ts` ← `original genie-shared/src/event.ts`. Import repointed
  `./protocol.js` → `./genie-model`.
- Shared helper repoint: `stringUtils.tokenizeWithOptions` →
  `string.tokenizeWithOptions` (`import { string } from "@dbx-tools/shared-core"`).
- Mixin: `pkg("*/shared-genie", "shared")` adds `zod@catalog:` +
  `@dbx-tools/shared-sdk-model@workspace:*` (shared-core is free via the blanket
  shared mixin).
- **Test:** ported `original genie/test/event.test.ts` → `test/event.test.ts` on
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
- **Path tooling** was retagged `node` because it shells out and uses
  chokidar/console. The current package is `@dbx-tools/node-path`; only the
  projen engine consumes it, so the repoint was contained.

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

Ported `shared/log.ts` → `shared-core/src/log.ts` — the one logger the whole
monorepo shares (`log.logger("tag")`, `log.isLevelEnabled`). Browser-safe:
`process` / `Bun` / `window` reached through `globalThis` and guarded; consola
and `node:util` load lazily (console fallback covers their absence). consola is
an **optional peer** of shared-core (`peerDependenciesMeta.optional`), pinned via
the hardcoded `DEFAULT_CATALOG` `consola` entry.

## `node-appkit` — Node-side Databricks/AppKit glue

`@dbx-tools/node-appkit` (`workspaces/node/appkit`, `node`-tagged) — the base for
Node-side Databricks + AppKit helpers. Three modules with clear scopes:

- **`databricks.ts`** — generic Databricks SDK glue, NO AppKit. The
  `Context`/`AbortSignal` cancellation adapter (`toContext`, `ContextLike`) built
  on shared-core `async.tieAbortSignal`, plus `isAppEnv` (Databricks App
  env-shape detection, moved out of shared-core). `@databricks/sdk-experimental`
  is a runtime dep here so the browser-safe shared-core stays SDK-free.
- **`appkit.ts`** — generic AppKit runtime: `WorkspaceClientLike` /
  `ExecutionContextLike` types + `tryGetExecutionContext` / `ensureInitialized`.
- **`plugin.ts`** — AppKit plugin lookup only: `data` / `instance` / `require` +
  `PluginContextLike`.

`@databricks/appkit` is an OPTIONAL peer (only `appkit.ts`/`plugin.ts` need it;
`databricks.ts` consumers needn't install it).

## `node-genie` — server chat/space driver

Ported `original genie` → `@dbx-tools/node-genie` (`workspaces/node/genie`,
`node`-tagged): `chat.ts` (`genieChat` low-level poll stream + `genieEventChat`
event stream) and `space.ts` (`getGenieSpace` + `genieSampleQuestions`). Import
repoints: `logUtils.logger` → `log.logger`; `apiUtils.toContext`/`ContextLike` →
node-appkit `databricks.*`; `commonUtils.poll`/`PollContext` → `async.poll` /
flat `PollContext`; `commonUtils.errorMessage` → `error.errorMessage`;
`stringUtils.firstNonEmpty` → `string.firstNonEmpty`; genie-shared values via the
`genieModel`/`event` namespaces, types flat. `@databricks/appkit` is an OPTIONAL
peer (lazy-imported; env-var auth fallback). The `chat.ts` / `poll-chat.ts`
runtime smoke tests were NOT ported (they hit a live workspace).

## `node-model` — server model resolver

Ported `original model` → `@dbx-tools/node-model` (`workspaces/node/model`,
`node`-tagged): `classes.ts` (chat-class ordering + `parseModelClass` /
`classesAtOrBelow`), `fallback.ts` (offline static floor), `serving.ts` (cached
`/serving-endpoints` listing via AppKit `CacheManager` + `fuse.js` fuzzy resolve

- embedding-dimension probe), `resolve.ts` (`rankModels` / `resolveModel` /
  `selectModel`). Repoints: `commonUtils.errorMessage` → `error.errorMessage`;
  `logUtils.logger` → `log.logger`; `stringUtils.tokenizeWithOptions` →
  `string.tokenizeWithOptions`; `appkitUtils.WorkspaceClientLike` →
  node-appkit `appkit.WorkspaceClientLike`; shared-model values via `model.*` /
  `classify.*` namespaces, types flat. New dep `fuse.js`; `@databricks/appkit` is a
  RUNTIME dep here (CacheManager is used directly, not lazy). Ported the two pure
  tests (`classes.test.ts` + `resolve.test.ts`, 25 cases) to `node:test`;
  force-added past the `.test.*` gitignore.

## `model-proxy` — local OpenAI-compatible proxy (CLI)

Ported `original model-proxy` → `@dbx-tools/model-proxy` (`workspaces/cli/model-proxy`,
`cli`-tagged — the first non-engine CLI package). A loopback OpenAI-compatible
proxy in front of Databricks Model Serving: `backend.ts` (default-auth
WorkspaceClient + fuzzy resolve via node-model + per-request auth headers),
`server.ts` (thin `node:http` pass-through to `<endpoint>/invocations`, streams
SSE/JSON back), `defaults.ts`, and `cli.ts` (commander `serve`/`chat`/`models`/
`resolve`). Split the all-in-one `cli.ts` into an exported `buildProgram`
/`runCli` in `src/cli.ts` + a thin `bin/model-proxy.ts` (mirrors cli-dbx-tools).
Repoints: `@dbx-tools/model` → node-model (`serving.*` values + flat
`ResolvedModel`; `ServingEndpointSummary` from shared-model); `logUtils.logger`
→ `log.logger`; `commonUtils.errorMessage` → `error.errorMessage`. `commander`
comes from the `cli` tag; the SDK is a runtime dep. Ships the `model-proxy` bin;
`--help` verified. No tests existed for this surface yet.

## `shared-email` — email wire contract

Ported `original appkit-email-shared` → `@dbx-tools/shared-email`
(`workspaces/shared/email`, `shared`-tagged, zod-only, browser-safe). Renamed
`protocol.ts` → `email.ts` per the naming rule, so the barrel reads
`email.emailMessageSchema` (types hoisted flat: `EmailMessage`, `EmailResult`,
`EmailAttachment`, `EmailSenders`). Unblocks the `appkit-email` sender later.

## `appkit-config` — folded into `node-appkit`

Ported `original appkit-config` and folded it into **node-appkit** (it added no deps
beyond `@databricks/appkit`, which node-appkit already carries — per the "don't
split a package that adds no deps" rule). The auto-config surface is now the
`createApp` module of node-appkit (`create-app`, `lakebase-resolver`,
`pgaddress`, `provision`): a drop-in `createApp` that resolves Lakebase Postgres
(env / config / Lakebase Autoscaling REST, with reverse-lookup / pick /
auto-create) and grants the AppKit cache schema before delegating to AppKit's
`createApp`.

The env CLI was extracted to its own `cli` package **`@dbx-tools/appkit-env`**
(`cli/appkit-env`, `appkit-env` bin) — `env-export.ts` (pure) + a commander bin
that runs `createApp.autoConfigure` and prints the env diff as shell/windows/json.

The config-resolution subsystem it needed landed as:

- **node-appkit `config.ts`** — `resolveConfigValue` + `app.yaml`/bundle-validate
  readers + env flatten (zod + `yaml`; `Bun.YAML.parse` → the `yaml` package).
- **node-core `project.ts`** — added `name` / `resolveProjectRoots` /
  `parseGitRemote` / `stat` alongside the existing sync `root` (sync, spawnSync).

Repoints: `configUtils.resolveConfigValue` → sibling `./config`
(`resolveConfigValue`); `projectUtils.name` → node-core `project.name`;
`logUtils`→`log`, `commonUtils.errorMessage`→`error`,
`commonUtils.isDatabricksAppEnv`→`isAppEnv`, `stringUtils`→`string`.

## `node-email` — server-side email add-on

Ported `original appkit-email` → `@dbx-tools/node-email` (`workspaces/node/email`,
`node`-tagged). SMTP transport (nodemailer) with a local file-outbox fallback,
markdown→HTML rendering (`marked` + `juice` inlining), on-behalf-of sender
derivation + allow-list policy, the approval-gated `send_email` Mastra tool, and
the AppKit `email` plugin. Consumes the browser-safe
[`shared-email`](#shared-email--email-wire-contract) contract (`email.*`
namespace for schema values, types flat). New shared-core module `net` (ported
from `original net.browser.ts`) supplies `net.parseEmails` for the allow-list. New
catalog pins: `marked`, `@mastra/core`. AppKit + Mastra are runtime deps.

## `node-databricks` + `node-databricks-zerobus`

New **`@dbx-tools/node-databricks`** (`workspaces/node/databricks`, `node`-tagged)
holds generic Databricks/cloud infra that needs the SDK / DNS / cloud metadata
but NOT the AppKit plugin runtime: `workspace` (getWorkspaceUrl/Id from the
AppKit exec ctx when present, else a default `WorkspaceClient`, else env),
`cloud` (provider/region detection via the AWS/GCP/Azure IP-range feeds +
24h disk cache; ported from `original cloud.ts`), `net` (node DNS `resolveHostIps` +
`getPublicIp` over shared-core's browser-safe `net`), and `http`
(`createFetchError` + header/cookie readers). Repoints the `original commonUtils`/
`netUtils`/`logUtils` surface onto shared-core (`error`/`hash`/`functionModule`/
`log`/`net`) and node-core (`project.stat`).

**`@dbx-tools/node-databricks-zerobus`** (ported from `original zerobus`) is the thin
Zerobus ingest wrapper (`createSdk` region-aware endpoint + `createStream`). It
uses the Zerobus SDK directly and node-databricks for region resolution - no
AppKit dep (per the "keep a package's heavy/specific dep out of node-appkit"
rule).

## `shared-mastra` + `node-appkit-mastra`

`shared-mastra` (browser-safe wire contract, marker grammar, routes; ported from
`appkit-mastra-shared`, `protocol.ts` → `wire.ts`) and `node-appkit-mastra` (the
full AppKit Mastra agent layer, ported from `appkit-mastra`: 24 modules -
plugin/server/agents/model/genie/memory/mcp/observability/chart/history/threads/
…). Kept as ONE package: nearly every module needs `@mastra/core` and the plugin
composes memory/mcp/observability/server together, so the heavy deps (`pg`,
`fastembed`, `mcp`, `observability`, `express`, `otel`) can't be gated apart.
Named `node-appkit-mastra` because it's the AppKit-specific composition.
Repoints the full shared util surface onto shared-core
(`error`/`hash`/`functionModule`/`async`/`string`/`log`/`net`/`http`/`token`),
node-appkit (`appkit`/`plugin`/`databricks`), node-core (`project`), and the new
`node-genie`/`node-model` packages (values namespaced, types flat). New catalog
pins for the `@mastra/*` + `@opentelemetry/api` stack. Also landed in shared-core
along the way: `net` (URL/email/IP), `http` (headers/cookies/fetch-error),
`token` (JWT scopes), and `error.errorContext` (HTTP-status/message classifier).

**Server-side migration is complete.** Every non-UI package is in place.

## Later passes (not yet scoped)

- **React UI packages** (`ui-appkit`, email UI, Mastra UI) —
  need a `ui`-tagged React setup; deliberately skipped in the server-side pass.
  Scope each package individually and keep shared contracts in `workspaces/shared`.
- **Documentation site** — turn the package READMEs into a generated docs site
  with one source of truth. Keep package READMEs as the canonical package pages.
  Add front matter or a lightweight manifest only if the static-site generator
  needs nav metadata. Generate package navigation from `pnpm-workspace.yaml` and
  `package.json` names/tags instead of maintaining a second package list. Include
  an `llms.txt`/`llms-full.txt` output for agent-readable package docs. Preserve
  AppKit-style page shape: introduction, prerequisites or install, quick start,
  key features, configuration or runtime behavior, programmatic access,
  module/API map, adjacent packages, and examples.
- **Docs lint/check** — add a docs validation task that checks every workspace
  package has a README, no README contains placeholder text, links to local
  packages resolve, and package names in README headings match `package.json`.
- **API extraction** — evaluate TypeDoc or API Extractor for generated API
  reference pages, but keep narrative usage docs in READMEs so GitHub, npm, and
  the docs site all share the same prose.
- **UI package export maps** — `@dbx-tools/ui-appkit` and `@dbx-tools/ui-email`
  declare `./react` subpaths that point at `src/react/index.ts`, but those
  subpath barrels are not present in the current tree. Either generate the React
  subpath barrels or update the export maps and docs to the package-root
  namespace shape before publishing.
- **Examples as docs fixtures** — keep example README pages short, but link each
  example to the production package concept it exercises (`cli`, `server`,
  `openapi`, `ui`, AppKit server/client).

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

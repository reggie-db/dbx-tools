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
  dependency-free, node-tagged runtime helpers. Concern-split modules,
  namespaced barrel (`export * as async/equal/error/hash/string/value/...`).
  Consumers write `string.toSlug(...)`, `error.errorMessage(...)`, etc.
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
shared            LEAF   ✅ DONE (folded into shared-core)
sdk-shared        LEAF   ✅ DONE (as shared-sdk-model, via new codegen subsystem)
model-shared      LEAF   ✅ DONE (as shared-model)
appkit-email-shared LEAF        (zod contract, feature-specific — not started)
genie-shared      → sdk-shared, shared   ⏭  NEXT (unblocked)
genie             → genie-shared, shared (+ @databricks/sdk-experimental)
model             → model-shared, shared
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
| (pending commit) | **Codegen subsystem + `shared-sdk-model`** — see below. |

### shared-core surface now available

`async` (poll/sleep/tieAbortSignal), `equal` (deepEqual + comparator), `error`
(errorMessage/errorMessages/errorNodes/toError), `hash`
(fnvHash/fnvHashWithOptions/toBase32/id), `string`
(tokenize/tokenizeWithOptions/toIdentifier/toSlug/toUniqueSlug/trimToNull/
firstNonEmpty/escapeHtml/toDescription), `value`
(isRecord/toBoolean/isDatabricksAppEnv/NameLike/NonFunctionKeys), plus
pre-existing `exec`, `functionModule` (memoize), `iterable`, `predicate`,
`project`.

`-js`'s `commonUtils.*` / `stringUtils.*` map onto these: e.g.
`commonUtils.errorMessage` → `error.errorMessage`,
`stringUtils.tokenizeWithOptions` → `string.tokenizeWithOptions`,
`commonUtils.poll` → `async.poll`, `commonUtils.fnvHash` → `hash.fnvHash`.

## Codegen subsystem (NEW — this session, pending commit)

Ported `-js`'s `dbxtools codegen` into the projen engine, mirroring
`openapi.ts` exactly (discovery by manifest field, lazy heavy-dep load,
read-only stamped output, task + `--watch` + `sync.ts` watcher).

Files:
- `workspaces/shared/projen/src/codegen.ts` — `generateCodegen()` +
  `isCodegenInput()`. Scans `workspacePackages()` for a `package.json`
  `codegen.inputs` field, runs each `.d.ts` through `stripImports` (TS compiler
  API drops imports, rewrites imported type refs → `unknown`) + `preprocess`
  (export-promote, JSDoc → `@description`) → `ts-to-zod`. Writes read-only
  `src/<name>.ts` (schemas + inferred types), cleans stale generated modules.
  Uses `header()`/`makeReadonly()`/`makeWritable()`/`isReadonly()` from
  `generated.ts`. **No Bun APIs** — portable Node fs.
- `workspaces/shared/projen/tasks/codegen.ts` — one-shot (regen + re-synth) or
  `--watch` (regen + rebuild barrels on input change). Mirrors `openapi.ts`
  task.
- `src/project.ts` — registered `codegen` task in `registerRootTasks`.
- `tasks/sync.ts` — added `codegen --watch` to the `concurrently` watcher set.
- `.projenrc.ts` — added `ts-to-zod` to the `shared-projen` engine deps;
  added `@databricks/sdk-experimental` catalog entry; added the
  `shared-sdk-model` mixin (zod dep, SDK devDep, `codegen.inputs` field).

Engine dep added: **`ts-to-zod`** (only new external dep; uses the already-present
`typescript`). Verified: `dbxtools codegen` generated 74 zod schemas from the
Databricks dashboards `.d.ts` into `workspaces/shared/sdk-model/src/dashboards.ts`
(read-only), barrel exposes `dashboards`, compiles clean.

### ⚠️ Known rough edge: chicken-and-egg bootstrap

Auto-discovery only sees a package once its `src/` holds a module file, but
codegen writes INTO `src/` — so a brand-new codegen-only package isn't
discovered until it has content, and codegen (which reads `workspacePackages()`)
won't generate into an undiscovered package. **Worked around** this session by
seeding a one-line stub `src/dashboards.ts`, synthing (package discovered,
`package.json` written with the `codegen` field), then running `dbxtools
codegen` (overwrites the stub). Once generated + committed, the file is present
so future clones/synths are fine.

**Follow-up to consider (ask user):** make `codegen` discovery independent of
`workspacePackages()` — scan the filesystem for any `package.json` with a
`codegen` field (like `-js` did) so a codegen-only package needs no seed. Or
run codegen as part of the synth pre-pass. Low priority; the seed works.

## `shared-sdk-model` (NEW — this session, pending commit)

- `workspaces/shared/sdk-model` → `@dbx-tools/shared-sdk-model`, tag
  `[shared]`. `zod` runtime dep, `@databricks/sdk-experimental` devDep,
  `codegen.inputs` = the dashboards `model.d.ts`.
- `src/dashboards.ts` is fully generated (read-only). Barrel:
  `export * as dashboards`. Consumers use
  `dashboards.genieMessageSchema` etc.
- Replaces `-js`'s `sdk-shared`. The 5 schemas `genie-shared` needs are all
  present: `genieSpaceSchema`, `messageStatusSchema`, `genieQueryAttachmentSchema`,
  `genieAttachmentSchema`, `genieMessageSchema` (+ `MessageStatus` type).

## ⏭ NEXT: port `genie-shared` → `@dbx-tools/shared-genie`

Scope agreed with user: **genie-shared only** this pass (browser-safe zod
contracts + event vocabulary + detectors). The server-side `genie` package
(chat/space driver) is a SEPARATE, larger follow-up (needs
`@databricks/sdk-experimental` at runtime + `apiUtils`/`logUtils`/`commonUtils`
from `-js shared` that aren't in shared-core yet).

Steps:
1. Create `workspaces/shared/genie/src/` with two modules (rename `protocol.ts`
   per the naming rule — suggest **`genie-model.ts`** so the barrel reads
   `genieModel.GenieMessageSchema`; keep **`event.ts`** as-is):
   - `genie-model.ts` ← `-js genie-shared/src/protocol.ts` (550 lines). Wire
     schemas that `.extend()` the SDK schemas + event vocabulary + status
     helpers.
   - `event.ts` ← `-js genie-shared/src/event.ts` (362 lines). Event detectors
     over `GenieMessage` snapshots; imports from `./protocol.js` → `./genie-model`.
2. **Repoint imports:**
   - `import { …Schema, type MessageStatus } from "@dbx-tools/sdk-shared"` →
     `from "@dbx-tools/shared-sdk-model"` — BUT that barrel namespaces as
     `dashboards`, so it's `import { dashboards } from "@dbx-tools/shared-sdk-model"`
     then `dashboards.genieMessageSchema`. **Decision needed:** either (a) import
     the namespace and alias (`const { genieMessageSchema: SDKGenieMessageSchema }
     = dashboards`), or (b) have sdk-model also flat-re-export via a hand-written
     `src/index`-style module. Recommend (a) to keep the generated barrel clean.
   - `import { stringUtils } from "@dbx-tools/shared"` →
     `import { string } from "@dbx-tools/shared-core"`; `stringUtils.tokenizeWithOptions`
     → `string.tokenizeWithOptions` (the only shared helper genie-shared uses).
   - Strip all `.js` extensions.
3. **Mixin in `.projenrc.ts`:** add `pkg("*/shared-genie", "shared")` mixin
   adding `zod@catalog:` + `@dbx-tools/shared-sdk-model@workspace:*`. (shared-core
   comes free via the blanket shared mixin.)
4. **Tests:** `-js` has no `genie-shared` test dir; the event tests live in the
   `genie` package (`genie/test/event.test.ts`). Consider porting the
   event-detector portions that only need genie-shared, to `node:test`.
5. Synth, barrels, compile, verify. Force-add any test. Commit + push.

## Later passes (not yet scoped)

- `genie` (server chat driver) — forces porting `apiUtils`/`logUtils` (+ the
  appkit context helpers) from `-js shared` into shared-core's server surface,
  and taking `@databricks/sdk-experimental` as a runtime dep. Big.
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

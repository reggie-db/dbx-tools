# AGENTS.md

Orientation for AI agents / new contributors. Read this first.

## Canonical agent instructions

This file is the canonical repo instruction set for Codex, Claude, Cursor, and
other coding agents. Keep tool-specific files such as `CLAUDE.md` and Cursor
rules as thin pointers back here so instructions do not drift.

If an older section below conflicts with the current README/package state or the
Databricks/AppKit positioning guidance near the top of this file, prefer the
newer guidance and the current source tree.

When you update docs, README positioning, or agent instructions:

- Make the change in `AGENTS.md` first when it affects future-agent behavior.
- Keep the root `README.md` focused on Databricks developer value, not internal
  projen mechanics.
- Put detailed monorepo/projen/generator instructions in
  `workspaces/node/projen/README.md` and link to it from root docs instead of
  repeating them.
- If the user asks to commit/push as updates are made, commit a focused docs
  change and push the active branch after validation.
- Do not mention any predecessor repo or migration source in public docs. Treat
  this repository as the continuation/current product.
- Do not hand-maintain a second docs tree. The GitHub Pages site is generated
  from root/package READMEs by `docs/scripts/sync-readmes.mjs`.

## What this repo is

`dbx-tools` is primarily a set of companion packages for Databricks developers
building Databricks Apps, AppKit backends, Mastra agents, Genie workflows, Model
Serving integrations, approval-gated email flows, and AppKit-oriented React UI.

The repo also includes a projen/pnpm workspace generator because the packages are
dogfooded here, but that is contributor tooling, not the primary product story.
Keep generator details in `workspaces/node/projen/README.md` and
`workspaces/cli/dbx-tools/README.md`.

Primary package areas:

- `workspaces/node/appkit` and `workspaces/cli/appkit-env` — AppKit defaults,
  Lakebase env/config resolution, execution-context helpers, plugin lookup, SDK
  cancellation, and cache-schema provisioning.
- `workspaces/node/appkit-mastra`, `workspaces/shared/mastra`, and
  `workspaces/ui/mastra` — Mastra inside AppKit, shared route/wire contracts,
  and the matching React chat UI.
- `workspaces/node/genie` and `workspaces/shared/genie` — low-level Genie
  drivers, typed async events, snapshot diffing, and browser-safe Genie
  contracts.
- `workspaces/node/model`, `workspaces/shared/model`, and
  `workspaces/cli/model-proxy` — intent-based Model Serving endpoint selection,
  shared schemas/classification, and local OpenAI-compatible proxying.
- `workspaces/node/email`, `workspaces/shared/email`, and `workspaces/ui/email`
  — approval-gated email tool/runtime, shared payload schemas, and React email
  approval/compose surfaces.
- `workspaces/ui/appkit` — AppKit UI/Tailwind/Vite foundation used by feature UI
  packages.
- `workspaces/node/databricks` and `workspaces/node/databricks-zerobus` —
  workspace/cloud/Zerobus infrastructure helpers.
- `workspaces/shared/core`, `workspaces/node/core`, and `workspaces/node/path`
  — cross-runtime and Node utility foundations.

- **`workspaces/`** — real content goes here.
- **`example-workspaces/`** — seed/example packages when present. Do not make
  root docs primarily about examples.

> Local dir is `dbx-tools/`; the GitHub repo is `reggie-db/dbx-tools`
> (default branch **`main`**).

## README and docs rules

The READMEs are the current source of truth and should be suitable to lift into a
future docs site. Use an AppKit-docs-like structure:

- short package description;
- `Key features:` list;
- explicit "why use this over native AppKit" section when the package overlaps
  AppKit functionality;
- quick-start/import examples using the actual exported package paths;
- configuration/runtime behavior details;
- module/subpath map;
- links to adjacent packages instead of repeating their content.

Root README rules:

- Lead with features this repo brings to Databricks developers.
- Explain that the packages augment Databricks/AppKit where native surfaces are
  low-level, repetitive, or missing sensible defaults.
- Include a "Relationship To Native AppKit" section.
- Do not lead with projen, workspace discovery, generated files, barrels, mixins,
  or package-scanning internals.
- Link to `workspaces/node/projen/README.md` and
  `workspaces/cli/dbx-tools/README.md` only under contributor/development
  context.

Package README rules:

- Describe functionality achieved by importing the package, not just file names.
- Include concrete examples and developer benefits.
- Avoid repeating adjacent package docs; link instead.
- Keep browser-safe shared packages framed as contracts/schemas/types, and Node
  packages framed as runtime behavior.
- For UI packages, document public subpaths such as `@dbx-tools/ui-mastra/react`
  or `@dbx-tools/ui-appkit/vite`; do not use generated package-root namespaces
  unless the package export map exposes them.
- Do not publicly mention any predecessor repo, branch, or migration source.

Docs site rules:

- Source of truth is `README.md` plus `workspaces/**/README.md`.
- `docs/scripts/sync-readmes.mjs` generates `.docs-build/site`.
- `docs/vitepress.config.mts` builds that generated tree with VitePress.
- `.github/workflows/docs.yml` builds and deploys GitHub Pages from generated
  README content.
- Generated files under `.docs-build/` are build artifacts; never commit them.
- If navigation is wrong, update the generator. If prose is wrong, update the
  source README.

## Native AppKit overlap guidance

Use native AppKit first when it already provides the needed surface. AppKit has
first-party plugins and UI for Analytics, Genie, Files, Lakebase, Model Serving,
Jobs, Vector Search, beta Agents, AppKit UI primitives, and standard plugin
lifecycle behavior.

When a `dbx-tools` package overlaps native AppKit, the README must explicitly say
why to use this package anyway:

- `@dbx-tools/node-appkit`: use when bootstrapping/config is the pain point:
  Lakebase/Postgres env before plugin setup, layered config lookup, safe
  execution context fallback, typed sibling plugin lookup, SDK cancellation, or
  cache-schema grants.
- `@dbx-tools/node-appkit-mastra`: use when the app wants Mastra's larger plugin
  ecosystem, tool model, memory/storage, workflows, MCP support, and
  `@mastra/client-js` stream shape while preserving AppKit OBO auth and AppKit
  tool-provider plugins. Native AppKit Agents are the simpler choice when the
  AppKit agent model is enough.
- `@dbx-tools/ui-mastra`: use when the server is `node-appkit-mastra` and the UI
  needs Mastra stream handling, approvals, thread sidebar, model picker,
  feedback, exports, and `[chart:<id>]` / `[data:<id>]` embeds. Native AppKit UI
  is enough for general components or native Genie/Serving hooks.
- `@dbx-tools/node-genie`: use when Genie is one capability inside an agent or
  custom backend and you need async iterators, snapshot diffing, typed events,
  custom SSE/logging/tests, or chart/data planning. Native AppKit Genie is the
  right choice for a standalone Genie chat plugin/UI.
- `@dbx-tools/shared-genie`: use for browser-safe Genie schemas/event vocabulary
  independent of AppKit transport.
- `@dbx-tools/node-model`: use when endpoint choice is the problem: fuzzy human
  names, capability classes (`chat-thinking`, `chat-balanced`, `chat-fast`,
  `embedding`), class ceilings, cached enriched catalogues, model pickers, and
  fallbacks. Native AppKit Serving is best when the endpoint alias is known.
- `@dbx-tools/model-proxy`: use for local OpenAI-compatible clients and tools
  that know `OPENAI_BASE_URL` but not AppKit.
- `@dbx-tools/ui-appkit`: use as a stable foundation/re-export for dbx-tools UI
  packages and hosts, not as a replacement for `@databricks/appkit-ui` in simple
  app code.

Concrete examples to preserve in docs:

- Genie here can emit async semantic events and feed AI/chart/data planning,
  rather than only providing a standalone chat route.
- Mastra here brings a large plugin/support ecosystem while remaining mounted as
  an AppKit plugin with Databricks OBO auth.
- Model tooling here resolves intent to serving endpoint ids instead of forcing
  every app to hard-code a serving endpoint alias.
- Email here adds human approval, sender policy, SMTP/outbox behavior, and UI
  surfaces around a Mastra tool.

## Vocabulary (important)

- **tag** — a label a workspace package carries (Bit-style; it names the target
  _environment_ — React/Vite, Node, agnostic, …). A package can carry MANY tags,
  or none. Tags are NOT npm scopes. They come from three sources, unioned and
  deduped: (1) tags already on a project you attached yourself, (2) matches in
  `workspacePackageTagPaths`, (3) the cumulative dash-join of the folder's path
  segments relative to its root (`ui/app` → `[ui, ui-app]`).
- **scope** — reserved for the npm `@scope/` in package identifiers (e.g. the
  `@dbx-tools` in `@dbx-tools/ui-app`). Don't call tags "scopes".
- **workspace package** — a `src`-bearing folder under a `workspacePackageRoots`
  root (e.g. `workspaces/ui/app`), named `@<scope>/<path-dash-joined>`.

## Mental model

- **`new DBXToolsNodeProject(options?)` gives you a configured monorepo root**
  (`project.ts`). It extends projen's `NodeProject`, merging its opinionated
  defaults (`defaultNodeProjectOptions`/`defaultTypeScriptProjectOptions`, root-aware
  functions keyed off `options.parent`: pnpm, no jest/eslint/github/release/depsUpgrade,
  no `devEngines.packageManager`, since pnpm 11 errors if that and
  `packageManager` are both set; projen's built-in prettier runs on the ROOT only)
  under anything you pass. You then call
  `project.synth()` yourself. A normal consuming `.projenrc.ts` is two lines:
  `const project = new DBXToolsNodeProject(); project.synth();`. Both classes
  share `DBXToolsCommonOptions` (`scope`, `workspacePackageRoots`,
  `workspacePackageTagPaths`, `defaultTagMixins`), which
  `extends` the component option bags directly — `DBXToolsConfigOptions` (`tags`)
  and `DBXToolsPNPMWorkspaceOptions` (`packages`/`catalog`/`allowBuilds`) — so those
  are top-level options, not nested fields. Both implement the single
  `DBXToolsProject` interface (`project.ts`; extends projen's `NodeProject`):
  `scope`/`packageIdentifier`/`packageNameFor` plus the config
  COMPONENTS as fields (projen-style, like `project.eslint?.addRules(...)`) —
  `project.dbxToolsConfig` (implements
  `ITagging`: `tags` + `addTags`, distinct/order-preserving, read/written directly on
  `package.json` `dbxToolsConfig.tags` — never cached on a field) and
  `project.pnpmWorkspace` (implements `IPnpmWorkspace`:
  `addPackages`/`addCatalog`/`allowBuild`; ROOT-only, so `undefined` on a child).
  Call methods on those fields directly (`project.dbxToolsConfig.addTags(...)`), not
  via delegator methods on the project.
- **`pnpm-workspace.yaml` is the source of truth**, emitted by the
  `DBXToolsPNPMWorkspace` component (`pnpm-workspace.ts`) exposed as the root's
  `project.pnpmWorkspace` field. The root scans the filesystem ONCE at synth
  (under each `workspacePackageRoots` root, default `["workspaces"]`) and the
  file's `packages:` list is sourced from `project.subprojects` at synth via a
  thunk (so member order/timing never matters) — every discovered package becomes
  a real subproject, no manual member list. Mutate it through the typed methods
  `project.pnpmWorkspace?.addCatalog(name, version)` / `.allowBuild(name)` /
  `.addPackages(glob)` (or `file.addOverride(...)` for any other pnpm setting), not
  by editing the YAML. Discovery is TWO functions in `workspace.ts`:
  `scanPackages(root, roots)` walks the filesystem (synth time; returns each
  package's path + the tags implied by its path, reading no manifest), while
  `workspacePackages()` reads the recorded members back from `pnpm-workspace.yaml`
  and augments each with the `name` + `tags` from its own `package.json` — what
  every post-synth command (`barrels`, the watcher, `openapi`) uses.
- **Discovery + tag resolution.** Under each `workspacePackageRoots` root (this
  repo passes `["workspaces", "example-workspaces"]`), ANY `src`-bearing folder at
  ANY depth is a package. Its path relative to the root is decomposed into
  cumulative dash-join **tag candidates**: `ui/app` → `[ui, ui-app]`;
  `dir/another/path` → `[dir, dir-another, dir-another-path]`. Each candidate is
  looked up in **`workspacePackageTagPaths`** (`Record<token, string[]>`,
  default: identity over the tag names) and the union of matches — together with
  any tags already on a pre-attached project — is the package's applied tags,
  possibly NONE (then only the agnostic default applies). The deduped tag list is
  written to each package's `package.json` under **`dbxToolsConfig.tags`** (the
  per-package source of truth, surfaced post-synth as `workspacePackages()[].tags`)
  and read back via the `DBXToolsConfig` component (`pkg.dbxToolsConfig.tags`, the
  basis a `project.mixin(...)` dispatches on). No declaration needed — drop a `src/`
  folder, re-synth.
- **A root may already hold in-tree subprojects.** If a discovered folder matches
  a subproject already attached to the root, it is NOT re-created — the resolved
  tags are unioned onto it (`dbxToolsConfig.addTags` for a DBXTools project, else
  `addWorkspacePackageTags`). The root itself can also carry tags (a `""`/`"."`
  key in `workspacePackageTagPaths`, or the `tags` option).
- **Every package is a `DBXToolsTypeScriptProject`** (extends
  `typescript.TypeScriptProject`). The root's scan constructs one per discovered
  folder with `parent: root`; you can also `new DBXToolsTypeScriptProject({parent,
...})` directly to attach a package WITHOUT auto-discovery. Every package gets
  the agnostic tsconfig floor (`AGNOSTIC_COMPILER_OPTIONS`: ES2022, no DOM/node) at
  construction; the class then points `main`/`types`/`exports` at the package-root
  `index.ts` barrel, applies any explicit `tasks`, optionally emits
  `vite.config.ts`, and locks `package.json`. Per-tag deps/tsconfig/tasks are
  layered afterward by the tag MIXINS the root applies (see below).
  projen OWNS that package's `package.json`/`tsconfig.json`/tasks/`README.md`/
  `.projen/`; baseline projen features are off to match the root (`SUBPROJECT_
DEFAULTS`; `sampleCode: false` stops projen dropping template `src/` files).
- **Tags are ONE map of mixins.** `tags.ts` — `WORKSPACE_TAG_MIXINS`
  (`Record<WorkspaceTag, IMixin>`, keyed by tag name). Each entry is a
  `tagMixin(name, fn)` that, for every package carrying the tag, adds the tag's
  projen-native `deps`/`devDeps` (`@catalog:` specifiers) and OVERRIDES the
  generated tsconfig via `applyCompilerOptions` (projen enums, e.g.
  `TypeScriptJsxMode.REACT_JSX`) — layered over the `AGNOSTIC_COMPILER_OPTIONS`
  floor so tag `lib`/`jsx`/`types`/`target` win. Some also `applyTasks` / emit
  `vite.config.ts`:
  - `ui` → Vite/React (DOM + `vite/client` types, jsx, `vite.config.ts`)
  - `server` → Node (`@types/node`, `tsoa` + `experimentalDecorators`, no DOM)
  - `node` → Node (`@types/node`, no DOM)
  - `cli` → Node + `commander` + `@clack/prompts`
  - `shared` → agnostic (the `AGNOSTIC_COMPILER_OPTIONS` floor: no DOM, no Node)
  - `openapi` → generated, read-only clients (`openapi-fetch`, DOM libs)
    Enforcement is real via each package's generated `tsconfig` `lib`/`types`:
    `document` in `shared`/`server` fails `tsc`; `process`/`node:*` in `ui` fails.
- **Per-package behavior is MIXINS** (`mixin.ts`; `constructs` `IMixin`). A mixin
  is `{ supports(c), applyTo(c) }`, applied with the constructs-native
  `construct.with(...mixins)` — it runs each across the construct's whole subtree
  (tree captured at call time), so a root-level `project.with(...)` or
  `project.mixin(...)` reaches every matching child. Package predicates live in
  `project.ts` under an exported `predicate` namespace, as plain callable
  `@dbx-tools/shared-core` predicates (narrowing a construct):
  `predicate.hasName("*/shared-core", ...)` (npm name glob via `match.toPathMatcher`,
  `→ Project`), `predicate.hasTag(tag, ...tags)` (all tags required,
  `→ DBXToolsProject`), and `predicate.inRelPath("workspaces", ...)` (root-relative
  folder prefix, `→ Project`). Compose them with `.and()`/`.or()`/`.negate()` - e.g.
  `predicate.hasName("*/shared-core").and(predicate.hasTag("node"))` - keeping
  `predicate.hasTag` in the same `.and(...)` (or last when chaining) so its
  `DBXToolsProject` narrowing survives (a later non-tag `.and` re-widens to `Project`).
  Build the mixin with `mixin(predicate, consumer)` (`mixin.ts`) and hand it to
  `project.with(...)`; `DBXToolsNodeProject.mixin(predicate, consumer)` is chainable
  sugar over exactly that. A `FileBase` guard as the predicate targets any generated file. The root
  applies the built-in tag mixins (**`WORKSPACE_TAG_MIXINS`**,
  `tags.ts`) during its own construction, selected by the `defaultTagMixins` option
  (omit = all, `false` = none, or a subset list) - e.g. the `server` mixin adds
  `express`/`tsoa` + `dev`/`start` tasks. Consumers apply their own AFTER
  construction with `project.mixin(...)` (see `.projenrc.ts`), so user mixins run
  after the defaults.
- **Names**: `pkg.packageNameFor(relPath)` → `PackageIdentifier.of(scope, relPath)`
  (`project.ts`): normalized, lowercased, the root-relative path dash-joined as
  `@<scope>/<seg-seg-...>` (e.g. `workspaces/shared/core` → `@dbx-tools/shared-core`,
  `workspaces/cli/dbx-tools` → `@dbx-tools/cli-dbx-tools`). The `scope` option
  defaults to the resolved project `name`; the `name` option, if omitted, is
  auto-detected (git remote → folder name). This repo passes `scope: "dbx-tools"`,
  giving `@dbx-tools/*` packages. The engine keeps its derived name UNLESS
  overridden — which it is, to the clean `@dbx-tools/cli` (see Gotchas).

## Layout

```
.projenrc.ts                              # new DBXToolsNodeProject({...}) + user mixins + the dbxtools root task
workspaces/
  cli/dbx-tools/                          # the CLI package (`dbx-tools` / `@dbx-tools/cli`)
    bin/dbxtools.ts                       # commander entry: sync | barrels | openapi | clean
    bin/publish.ts                        # projen release tasks (pack / publish / CI)
    index.ts                              # CLI helpers + re-export of `@dbx-tools/shared-projen`
    src/
      bin.ts, log.ts                      # pnpm/bin resolution + consola logger (CLI runtime)
      engine.ts                           # re-export barrel for the projen engine public API
      name.ts, collection.ts              # other CLI helpers
  shared/projen/                          # the projen engine (`@dbx-tools/shared-projen`)
    index.ts                              # generated barrel (public API surface)
    src/
      project.ts                          # DBXToolsProject + DBXToolsNode/TypeScriptProject + PackageIdentifier/naming, applyCompilerOptions/applyTasks, SHARED_COMPILER_OPTIONS, root init
      mixin.ts                            # mixin() factory (tag table lives in tags.ts)
      pnpm-workspace.ts                   # DBXToolsPNPMWorkspace (YamlFile) + IPnpmWorkspace + Catalog/DEFAULT_CATALOG
      tags.ts                             # WORKSPACE_TAG_MIXINS (one IMixin per tag) + AGNOSTIC_COMPILER_OPTIONS
      workspace.ts                        # discovery: scanPackages (fs) + workspacePackages (pnpm-yaml + manifest)
      barrels.ts                          # barrelsby driver (root index.ts, header + read-only)
      watch.ts                            # generic file-watch util (watchLoop + watchRoots) the sync --watch task watchers forward to
      scaffold.ts                         # packageSetChanged() + runSynth({ post })
      bootstrap.ts                        # bootstraps a COMPLETELY EMPTY folder (see Commands)
      openapi.ts                          # openapi generator (tsoa controllers -> spec + client)
      clean.ts, generated.ts, files.ts, vite.ts
  openapi/<name>/                        # generated from tsoa controllers, same root as the source
example-workspaces/
  cli/main/ server/api/ shared/core/ shared/fun/ shared/neat/ ui/app/   # seed examples, each a real subproject
```

## Commands (the `dbxtools` CLI)

```sh
pnpm install                 # link workspace + engine
pnpm exec projen             # synth all generated config (+ install + barrels)
pnpm exec projen sync --watch # watch while editing (concurrently: projenrc + barrels + openapi watchers)
pnpm dbxtools sync           # bootstrap an empty folder, OR re-synth an existing workspace (one-shot)
pnpm dbxtools sync --watch   # watch: projenrc re-synth (.projenrc.ts only) + barrels + openapi watchers, via concurrently
pnpm dbxtools barrels        # rebuild every package's root index.ts barrel
pnpm -r compile              # type-check every package (projen's per-package compile: tsc --build)
pnpm dbxtools openapi        # generate the openapi packages from tsoa controllers
pnpm dbxtools clean          # remove generated files (read-only ones); interactive picker, -y to skip
```

- **`projen sync --watch` is the always-on watcher** (the generated `sync` task run
  with `--watch`, also the VS Code folder-open task). `sync`'s `receiveArgs` forwards
  `--watch` to `tasks/sync.ts`, which does ONE initial full synth, then runs three
  focused watchers under `concurrently` - each its own task script sharing the generic
  `watchLoop`/`watchRoots` (`watch.ts`), each keyed to the smallest input that can
  invalidate its output: `tasks/projenrc.ts` (watches `.projenrc.ts` plus any
  `syncResynthPaths` from the root project option, persisted as
  `dbxToolsConfig.syncResynthPaths`; on edit runs a full re-synth + install - the
  intelligent stand-in for stock `projen --watch`, which re-synths on ANY tree change),
  `tasks/barrels.ts --watch` (a source edit rebuilds just that package's barrel), and
  `tasks/openapi.ts --watch` (a changed tsoa controller regenerates the openapi
  packages). The concern-specific glue lives in the task; `watch.ts` only owns the
  shared debounce/serialize/ignore-generated/SIGINT machinery. Touch `.projenrc.ts`
  (or a listed `syncResynthPaths` file) to force a re-synth for a structural change
  it doesn't spell out (e.g. a new package folder). Stock `projen --watch` is
  deliberately NOT used: it `fs.watch`es the whole repo recursively and re-synths
  (full post, so it installs) on EVERY file change, so a mere source edit forced a
  full re-synth + install.
- **`dbxtools sync` on a completely empty folder bootstraps it** (`bootstrap.ts`):
  `pnpm init`, seed a minimal `pnpm-workspace.yaml` (so the very next step can
  approve `tsx`'s `esbuild` build script non-interactively), `pnpm add -D
projen typescript@^5.9.3 tsx@^4.23.0 <engine specifier>`, write a minimal
  `.projenrc.ts` if none exists, synth (`post: false` - skips projen's own
  post-synth install, which has no non-interactive answer for "remove this
  stale node_modules?" with no TTY), then reconcile the install itself
  (`pnpm install --no-frozen-lockfile --force` - `--force` is what makes pnpm's
  own confirmation logic treat that prompt as pre-answered) and regenerate
  barrels. Scaffolds **no** package folders or sample code - just enough for
  `pnpm exec projen`/`dbxtools sync` to work from here on.
- **`dbxtools sync` on an existing workspace** just runs projen once (full synth,
  installs, regenerates barrels via the post-synth component).
- **`dbxtools sync --watch`** forwards to `projen sync --watch`, which does one
  initial full synth, then (via `concurrently`) runs the projenrc watcher alongside
  the barrel + openapi watchers. The projenrc watcher re-synths (+install) when
  `.projenrc.ts` or a configured `syncResynthPaths` entry changes; the barrel watcher
  rebuilds just the edited package's barrel, and the openapi watcher regenerates the
  `openapi` packages when a tsoa controller changes.
- **Barrels regenerate on every full (post) synth**: a post-synth projen `Component`
  (`GeneratedBarrels` in `project.ts`) runs on any `runSynth({ post: true })` - the
  plain `pnpm exec projen`, `sync`'s initial synth, and the projenrc watcher's
  re-synth all install and rebuild barrels through it. Fast paths skip it: the
  standalone barrel watcher calls `generateBarrels()` directly on edits (no synth),
  and `bootstrap` runs `runSynth` with `PROJEN_DISABLE_POST` set, doing its own
  install + barrels afterward.
- **`dbxtools clean`** (`clean.ts`) deletes generated files. It doesn't hardcode a
  list: every file the toolchain writes is read-only (see below), so a read-only file
  under the repo (skipping vendor/build/VCS, but INCLUDING `.projen/*`) is a clean
  target. It shows a `@clack/prompts` picker with all files preselected (uncheck to
  keep); `-y` removes them all non-interactively. Safe to run - `.projenrc.ts` imports
  the engine by SOURCE path, so `npx tsx .projenrc.ts` (or `pnpm exec projen`)
  regenerates everything afterward.

Barrels re-export every exporting file under `src/` except names starting with
`_`; a package's barrel lives at its ROOT (`index.ts`), re-exporting `./src/*`.

## Generated files — DO NOT edit by hand

- **Per-package** (`package.json`, `tsconfig.json`, `.projen/*`, `README.md`,
  `.gitignore`, …): owned by that package's projen subproject.
- **Root** (root `tsconfig*.json`, `.vscode/*`, per-package `vite.config.ts`):
  read-only + projen marker, emitted from `files.ts`. `pnpm-workspace.yaml` is the
  `DBXToolsPNPMWorkspace` component (`pnpm-workspace.ts`).
- **barrels** (`<root>/<tags...>/<name>/index.ts`): read-only, do-not-edit header,
  written by barrelsby. Marked generated in `.gitattributes` (`annotateGenerated`).
- **openapi** (`<root>/openapi/<name>/`): fully generated from tsoa
  controllers - spec, types, and client.

Change a tag, a hook, or `.projenrc.ts` and re-synth — never edit generated files.

## Gotchas

- **pnpm v11** gates build scripts behind `allowBuilds` in `pnpm-workspace.yaml`
  (NOT `onlyBuiltDependencies`) — `esbuild: true` is the default. Add allowances
  via `project.pnpmWorkspace?.allowBuild(name)` (or `.addCatalog`/`.addPackages`, or
  `file.addOverride(...)` for any other pnpm setting), not by editing the YAML.
- **The engine is dogfooded as a normal auto-discovered package**, not a hand-
  authored special case: it lives at `workspaces/cli/dbx-tools` (tag `cli`,
  name `dbx-tools`), which auto-discovery would otherwise render as
  `@dbx-tools/cli-dbx-tools`. `.projenrc.ts` applies (via `project.mixin(...)`) a
  mixin matching `predicate.hasName("*/cli-dbx-tools").and(predicate.hasTag("cli"))` that:
  overrides the name to `@dbx-tools/cli` (`p.package.addField("name", ...)`),
  adds its bin (`p.package.addBin({ dbxtools: "./bin/dbxtools.ts" })`), depends on
  `@dbx-tools/shared-projen`, and bumps its tsconfig to ES2022 lib/target +
  `rootDir: "."` - extra includes for `index.ts`/`bin/**/*.ts` (the `cli` tag's
  defaults are ES2020 + `src/**/*.ts` only, which doesn't cover code outside
  `src/`). The projen engine itself lives in `workspaces/shared/projen`
  (`@dbx-tools/shared-projen`); a `shared`/`projen` mixin adds its deps
  (`projen`, `constructs`, `barrelsby`, `@dbx-tools/shared-file-scan`, ...).
- **The root keeps the engine itself resolvable across synths** via
  `engineSelfDependency()` (`project.ts`): resolves the `@dbx-tools/cli`
  package (`dbx-tools`) via `require.resolve` when installed; if that
  path passes through a `node_modules` segment (an installed/external
  consumer), it adds that name as a root devDep - reusing WHATEVER specifier is
  already in the consumer's current `package.json` for it (`file:`, `link:`, a
  version, anything) rather than computing one, since overwriting a `file:`/
  `link:` install with a version range would silently repoint it at the
  registry. If the path does NOT pass through `node_modules` (this repo's own
  dogfooding - relative-imported, no package resolution involved), it returns
  `undefined` and adds nothing. The root also adds `tsx`, `typescript`, and
  `@types/node`.
- **`DBXToolsNodeProject` defaults `packageManager: PNPM`** (projen's
  `packageManager` is readonly after construction); pass a different one only if
  you know what you're doing, since the whole toolchain assumes pnpm workspaces.
- **Type-checking is projen's own per-package `compile`** (`tsc --build` against
  each package's tag tsconfig), not a `dbxtools` command - the tag `lib`/`types`
  overrides are what make misuse fail. Check one package with `pnpm exec projen
compile` (or `pnpm compile`) in its dir, or all of them with `pnpm -r compile`.
- **Tool bins are resolved lazily** (a memoized function, not a module-level
  const): `barrels.ts` resolves barrelsby this way. Resolving eagerly broke merely
  _importing_ the engine (which the barrel pulls in) whenever a consumer's install
  of that tool was an unusual version with a narrower `exports` map.
- Repo is `type: module`. Packages get a `module: ESNext` + `moduleResolution:
bundler` overlay (`SHARED_COMPILER_OPTIONS` in `project.ts`) because projen's
  default `module: CommonJS` breaks the ESM sources' `import.meta`; `bundler`
  honors the `exports` map, so a bare `@dbx-tools/<pkg>` import resolves to that
  package's ROOT `index.ts` barrel — packages type-check against each other with
  no build step. Cross-package imports still need the workspace dep declared
  (`p.addDeps("@dbx-tools/shared-core@workspace:*")` in a `project.mixin(...)`) and MUST
  use the package name (`@dbx-tools/shared-file-scan`), never a relative path into
  another package's `src/` (e.g. `../../../../shared/file-scan/src/find`).
- Everything runs on portable Node: subprocesses use `execFileSync(process.execPath, …)`;
  read-only is `fs.chmodSync` (Node maps it to the Windows read-only attribute).
  `bootstrap.ts` resolves `pnpm`'s own CLI the same way (`require.resolve`, not a
  PATH lookup) - `pnpm` is a regular dependency of the engine for exactly this.
- **`package.json` is forced read-only by default** on the root and every
  subproject, so the whole generated tree is consistent. The `DBXToolsConfig`
  component sets the manifest's `FileBase.readonly = true` in its CONSTRUCTOR (projen
  still rewrites the file each synth - clears the bit, writes, restores). Opt a
  package out by setting `p.package.file.readonly = false` directly - done in the
  constructor rather than `preSynthesize` precisely so a later opt-out wins at synth.
  The CLI package does exactly this so its own `package.json` stays writable.
  Source/sample files the developer owns (`.projenrc.ts`, each package's `README.md`,
  `src/*`) stay writable regardless.
- **OpenAPI** (`openapi.ts`, `dbxtools openapi`): scans **every discovered**
  `server`/`node` package for **tsoa** controllers (classes with
  `@Route`/`@Get`/... - no JSDoc/YAML). For each, tsoa's `generateSpec` infers an
  OpenAPI 3 spec from the decorators + TS types, then openapi-typescript +
  openapi-fetch produce a read-only `<sourcePackage root>/openapi/<name>`
  package (`openapi.json` + `src/schema.ts` + `src/client.ts`) - colocated under
  the SAME root as the controller it came from (`example-workspaces/server/
api`'s controllers generate `example-workspaces/openapi/api`), not a hardcoded
  root. tsoa/typescript/openapi-typescript are lazy-loaded (only `dbxtools
openapi` / a watched controller edit needs them). The openapi watcher (started by
  `projen sync --watch`, under `concurrently`) regenerates it automatically when a
  controller changes.

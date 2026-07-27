# AGENTS.md

Orientation for AI agents / new contributors. Read this first.

## Canonical agent instructions

This file is the canonical repo instruction set for Codex, Claude, Cursor, and
other coding agents. Keep tool-specific files such as `CLAUDE.md` and Cursor
rules as thin pointers back here so instructions do not drift.

Before authoring or changing an AppKit-facing plugin, package, or its docs, read
`docs/appkit-best-practices.md`. It is the distilled house-rule version of the
`databricks/appkit` repo and the AppKit v0 docs (plugin authoring, code style,
documentation style), so `dbx-tools` packages stay shaped like first-party AppKit
ones.

If an older section below conflicts with the current README/package state or the
Databricks/AppKit positioning guidance near the top of this file, prefer the
newer guidance and the current source tree.

When you update docs, README positioning, or agent instructions:

- Make the change in `AGENTS.md` first when it affects future-agent behavior.
- Keep the root `README.md` focused on Databricks developer value, not internal
  projen mechanics.
- Put detailed monorepo/projen/generator instructions in
  `projen/README.md` and link to it from root docs instead of
  repeating them.
- If the user asks to commit/push as updates are made, commit a focused docs
  change and push the active branch after validation.
- Do not mention any predecessor repo or migration source in public docs. Treat
  this repository as the continuation/current product.
- Do not hand-maintain a second docs tree. The GitHub Pages site is generated
  from root/package READMEs by `docs/scripts/sync-readmes.mjs`, with generated
  TypeScript API pages from `docs/scripts/generate-api-docs.mjs`.

## What this repo is

`dbx-tools` is primarily a set of companion packages for Databricks developers
building Databricks Apps, AppKit backends, Mastra agents, Genie workflows, Model
Serving integrations, approval-gated email flows, and AppKit-oriented React UI.

The repo also includes a projen/pnpm workspace generator because the packages are
dogfooded here, but that is contributor tooling, not the primary product story.
Keep generator details in `projen/README.md` and
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
- `workspaces/node/appkit-web-search` — web-search add-on: `web_search` (the
  Databricks Model Serving NATIVE web-search tool — the model searches the web
  server-side and returns answer + citations; resolves its OWN web-capable model
  via `@dbx-tools/model`, Gemini→GPT, independent of the agent's chat model) +
  `web_fetch` (got-scraping page fetch). A provider→tool-spec map (OpenAI
  Responses `{"type":"web_search"}`, Gemini Chat `{"google_search":{}}`), an
  optional URL allow-list (built on `@dbx-tools/path`'s `match`) filtering
  citations / refusing disallowed fetches, per-tool approval gating, and the
  AppKit `web-search` plugin. Same shape as node-email.
- `workspaces/node/teams`, `workspaces/shared/teams`, and `workspaces/ui/teams`
  — Teams Adaptive Card add-on. The headline surface is `POST
/api/teams/messages`, a REAL Microsoft Teams messaging endpoint an Azure Bot
  registration can point at: it validates the inbound Bot Service JWT
  (signature + trusted issuer + audience === `appId`, the check that stops
  another bot's validly-signed token driving your agent), pins the reply
  destination to the token's `serviceurl` claim, acknowledges `200` BEFORE
  running the agent (Bot Service retries an unacknowledged activity, so a
  synchronous reply means duplicate cards), and delivers the card over the
  Connector API. `POST /api/teams/activity` runs the same turn synchronously for
  local/non-Teams callers, with the conversation id mapped onto the agent's
  memory thread. It is the Teams-shaped analogue of how the Mastra plugin
  exposes MCP at a path — the protocol is the interface. A turn runs in TWO
  passes: the agent ANSWERS normally first (tools included, no
  `structuredOutput`, nothing about cards in the prompt), then a second
  `structuredOutput` pass reformats that answer into a `CardSpec`. Both passes
  matter — asking for the answer and the card shape in one request makes the
  model treat FORMATTING as the task, so it never calls its tools and replies
  with a placeholder card ("I don't have a real system connected"). Answering
  first is what makes this endpoint's CONTENT identical to the streaming
  endpoint's; only the presentation differs. For that parity the turn also needs
  the agent's per-turn Mastra `RequestContext` — user-scoped tools (`ask_genie`
  above all) read the AppKit user off it and only the agent plugin can build one,
  so `appkit-mastra` exposes `createRequestContext()` on its `exports()` and
  node-teams resolves it structurally (`resolveCardContextFactory`). It resolves
  its agent from the sibling Mastra plugin by registered NAME (`agentPlugin`,
  default `mastra`) so this package takes no dependency on
  `@dbx-tools/appkit-mastra`. The
  `allowUnauthenticated` config serves `/messages` with NO token validation for
  local development and is IGNORED unless `NODE_ENV=development`, so a
  production build cannot be talked into it by an env var (the demo uses it to
  render live cards). Card recovery is layered because a prompt-injected schema
  is best-effort: a card the agent composed with `create_teams_card` short-
  circuits the format pass, a FULL Adaptive Card document (what a capable model
  often returns when asked for "an Adaptive Card") is read back into the spec
  vocabulary, the payload Mastra REJECTED is salvaged off the thrown error
  (`details.value`), and the answer text is the last resort — so a formatting
  miss costs structure, never the answer. Host embed markers (`[data:<id>]`,
  `[chart:<id>]`) are stripped since a card has no slot to render them; the
  answering pass asks for the values instead. Also a
  deterministic `CardSpec` -> Adaptive Card 1.5 builder, the
  `create_teams_card` Mastra tool + AppKit `teams` plugin (`POST /api/teams/card`,
  `POST /api/teams/post`, optional incoming webhook), browser-safe card +
  activity schemas, and a React `TeamsChat` / `AdaptiveCardView` /
  `AdaptiveCardGallery` built on the `adaptivecards` JS renderer (which ships no
  markdown parser — `ui-teams` installs `marked` as its `onProcessMarkdown`).
  Same add-on shape as node-email.
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
- Link to `projen/README.md` and
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
- `docs/scripts/sync-readmes.mjs` generates the Starlight site under
  `.docs-build/site`.
- `docs/scripts/generate-api-docs.mjs` generates TypeDoc Markdown into the same
  Starlight content tree from package `index.ts` exports.
- `.github/workflows/docs.yml` builds and deploys GitHub Pages from generated
  README and API content.
- Generated files under `.docs-build/` are build artifacts; never commit them.
- If navigation is wrong, update the generator. If prose is wrong, update the
  source README.

## Native AppKit overlap guidance

For the authoring conventions themselves (manifest shape, lifecycle, execution
interceptors, route registration, exports vs client config, errors, doc style),
see `docs/appkit-best-practices.md`. This section is only about WHEN to reach for
a `dbx-tools` package instead of the native one.

Use native AppKit first when it already provides the needed surface. AppKit has
first-party plugins and UI for Analytics, Genie, Files, Lakebase, Model Serving,
Jobs, Vector Search, beta Agents, AppKit UI primitives, and standard plugin
lifecycle behavior.

When a `dbx-tools` package overlaps native AppKit, the README must explicitly say
why to use this package anyway:

- `@dbx-tools/appkit`: use when bootstrapping/config is the pain point:
  Lakebase/Postgres env before plugin setup, layered config lookup, safe
  execution context fallback, typed sibling plugin lookup, SDK cancellation, or
  cache-schema grants.
- `@dbx-tools/appkit-mastra`: use when the app wants Mastra's larger plugin
  ecosystem, tool model, memory/storage, workflows, MCP support, and
  `@mastra/client-js` stream shape while preserving AppKit OBO auth and AppKit
  tool-provider plugins. Native AppKit Agents are the simpler choice when the
  AppKit agent model is enough.
- `@dbx-tools/ui-mastra`: use when the server is `node-appkit-mastra` and the UI
  needs Mastra stream handling, approvals, thread sidebar, model picker,
  feedback, exports, `[chart:<id>]` / `[data:<id>]` embeds, or the features the
  native AppKit chat surface lacks: CONCURRENT multi-thread streaming (run many
  conversations at once, switch freely, cancel any one), and a mid-turn STEERING
  QUEUE (submit while running to enqueue; queue drains oldest-first, or send any
  item now to interrupt). Native AppKit UI is enough for general components or
  native Genie/Serving hooks.
- `@dbx-tools/genie`: use when Genie is one capability inside an agent or
  custom backend and you need async iterators, snapshot diffing, typed events,
  custom SSE/logging/tests, or chart/data planning. Native AppKit Genie is the
  right choice for a standalone Genie chat plugin/UI.
- `@dbx-tools/shared-genie`: use for browser-safe Genie schemas/event vocabulary
  independent of AppKit transport.
- `@dbx-tools/model`: use when endpoint choice is the problem: fuzzy human
  names, capability classes (`chat-thinking`, `chat-balanced`, `chat-fast`,
  `embedding`), class ceilings, cached enriched catalogues, model pickers, and
  fallbacks. Native AppKit Serving is best when the endpoint alias is known.
- `@dbx-tools/cli-model-proxy`: use for local OpenAI-compatible clients and
  tools that know `OPENAI_BASE_URL` but not AppKit. Installs the
  `dbx-tools-model-proxy` bin plus the short `dbxt-model-proxy` alias.
- `@dbx-tools/ui-appkit`: use as a stable foundation/re-export for dbx-tools UI
  packages and hosts, not as a replacement for `@databricks/appkit-ui` in simple
  app code.
- `@dbx-tools/ui-branding`: use to theme dbx-tools/AppKit UI to a brand — a
  `BrandProvider`/`BrandIcon`/`BrandLogo` React surface plus the
  `[data-brand]` token bridge that re-skins AppKit's semantic tokens from a
  portable `BrandContext`. Inert until a brand is applied, so it never gets in
  the way of default AppKit. Not a replacement for AppKit's own theming when the
  default palette is fine.
- `@dbx-tools/appkit-web-search`: AppKit has no first-party web-search or
  page-fetch surface, so use this whenever an agent must look things up on the
  open web or read a user-supplied URL — with a policy layer (URL allow-list +
  optional per-tool approval) controlling which sites are reachable and which
  calls pause for a human. `web_search` uses the Databricks NATIVE web-search
  tool and resolves its own web-capable model (so an agent on a non-web model
  still searches); `web_fetch` uses got-scraping. Same add-on shape as
  node-email (Mastra tool pair + AppKit plugin priming a shared runtime).
- `@dbx-tools/teams`: AppKit has no Teams / Adaptive Card surface, so use this
  whenever a Microsoft Teams channel should be able to chat with the app's
  agents, or an agent should emit a Teams card. Two things it buys: a real Bot
  Framework messaging endpoint (`POST /api/teams/messages`, JWT-validated and
  Connector-delivered — paste it into an Azure Bot registration) plus the
  synchronous `POST /api/teams/activity` for local callers, so the wire format IS
  the Teams protocol rather than a bespoke chat API; and a policy layer around a
  card — the model works in the small `CardSpec` vocabulary instead of raw
  Adaptive Card JSON, a deterministic builder guarantees a schema-valid Adaptive
  Card 1.5 document, and posting is gated behind an explicitly configured
  incoming webhook. `@dbx-tools/ui-teams`'s `TeamsChat` renders a whole
  conversation of cards with the `adaptivecards` JS renderer. Same add-on shape
  as node-email.

Concrete examples to preserve in docs:

- Genie here can emit async semantic events and feed AI/chart/data planning,
  rather than only providing a standalone chat route.
- Mastra here brings a large plugin/support ecosystem while remaining mounted as
  an AppKit plugin with Databricks OBO auth.
- Model tooling here resolves intent to serving endpoint ids instead of forcing
  every app to hard-code a serving endpoint alias.
- Email here adds human approval, sender policy, SMTP/outbox behavior, and UI
  surfaces around a Mastra tool.
- Web search here gives agents an open-web `web_search` (Databricks native
  web-search tool, on its own web-capable model) + `web_fetch` behind a URL
  allow-list and optional approval gate, a surface AppKit doesn't ship.
- Teams here gives an app a real Teams bot messaging endpoint — JWT-validated
  inbound, Connector-API delivered outbound (the MCP-style "expose the real
  protocol at a path" move) — compiles a model's small `CardSpec` into a valid
  Adaptive Card, and renders a whole Teams conversation with the `adaptivecards`
  JS renderer (with optional webhook posting), a surface AppKit doesn't ship.

## Shared utilities - check here before writing a helper

`@dbx-tools/shared-core` is the browser-safe base EVERY workspace package
already depends on (the `.projenrc.ts` blanket rule adds it), so importing from
it never costs a new dependency. Before adding a small helper to a package,
check whether one of these already exists; if the helper would be useful to a
second package, put it in shared-core rather than duplicating it.

- `json` - `parse(text, fallback?)` and `parseRecord(text)`. Use these for ANY
  JSON that comes from outside the process (request body, env var, config file,
  subprocess stdout, third-party API) instead of `JSON.parse` in a try/catch.
  Keep bare `JSON.parse` only where a throw is the correct outcome.
- `string` - `toLabel` / `capitalize` (humanizing an identifier: do not
  hand-roll `charAt(0).toUpperCase()`), `toSlug` / `toUniqueSlug`, `trimToNull`
  / `trimToEmpty` / `firstNonEmpty` (coercing an unknown JSON field to a
  string), `parseList` (a config value that may be an array OR one
  comma/whitespace-separated env string), `escapeHtml`, `pluralize`.
- `object` - `isRecord` (narrowing parsed JSON), `deepEqual` (never compare via
  `JSON.stringify`), `toBoolean`, plus the lazy `Sequence` transforms.
- `async` - `sleep`, `tieAbortSignal`, `poll`. Do not import
  `node:timers/promises` for a delay.
- `error` (`toError` / `errorMessage` / `errorContext`), `log.logger`,
  `hash.id` (id generation - no `nanoid`), `net.urlBuilder`,
  `http.createFetchError`, `function.memoize`, `predicate`, `token`.

Node-only equivalents live in `@dbx-tools/core` (`exec.spawn`/`spawnSync`,
`project.root`/`name`/`repositoryUrl`/`npmRegistry`) and `@dbx-tools/path`
(`findFiles`, `watchFiles`, `toPathMatcher`, `ignorePatterns`). The projen
engine uses these too - it must not re-probe `npm prefix` / `git rev-parse` on
its own.

Cross-package contracts that are easy to duplicate by accident:

- `@dbx-tools/shared-model` `openaiResponses.REASONING_TYPES` - the Claude
  extended-thinking block types. Both wire sanitizers (Responses and Chat
  Completions) MUST strip the same set; Anthropic signs these blocks, so a
  replay that mutates one is rejected.
- `@dbx-tools/model` `invoke.*_PATH` / `*Url` - the Databricks serving paths
  (`invocations`, `responses`, `open-responses`, `chat/completions`). Never
  hard-code a `/serving-endpoints/...` string in a consumer.

Package-local modules that exist so a helper is written once, listed here because
each was previously duplicated across sibling files:

- `node/appkit-web-search` `src/html-text.ts` - `htmlToText` /
  `htmlFragmentToText` / `decodeHtmlEntities`, shared by `fetch.ts` and
  `scrape.ts`.
- `node/appkit-web-search` `search.ts` `resolveWebSearchContext()` - the OBO
  client + host + config resolution the tool, plugin, and search paths all need.
- `ui/mastra` `src/support/clipboard.ts` and `src/support/download.ts` - copy
  (with the insecure-context `execCommand` fallback) and blob download. Do not
  touch `navigator.clipboard` or `URL.createObjectURL` directly in a component.

When a helper is worth sharing, add it to the module map in the owning package's
README as well; the docs site is generated from those READMEs, so an undocumented
utility is an invisible one.

## Formatting and diff hygiene

`pnpm run format` is `prettier . --write` over the WHOLE repo, and `.prettierignore`
does not exclude `workspaces/`. Some committed files predate the current
`printWidth: 100` and were never reformatted, so a repo-wide run rewraps them and
churns dozens of lines that have nothing to do with your change.

Prefer `pnpm exec prettier --write <the files you edited>`. Run the repo-wide
`format` task only when reformatting the repo IS the change. Either way, check
`git status` / `git diff --stat` before finishing and revert files you did not
mean to touch, so a behavior change is not buried in reflowed whitespace.

Lint is `pnpm run eslint` (root `.eslintrc.json`, ESLint 8 / `eslintrc` mode, run
over `workspaces`). It autofixes, so it can reformat too.

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
  and `DBXToolsPNPMWorkspaceOptions` (`catalog`/`allowBuilds`/`workspaceYaml`) — so those
  are top-level options, not nested fields. Both implement the single
  `DBXToolsProject` interface (`project.ts`; extends projen's `NodeProject`):
  `scope` plus the config
  COMPONENTS as fields (projen-style, like `project.eslint?.addRules(...)`) —
  `project.dbxToolsConfig` (a `DBXToolsConfig` component: a `tags` array you push
  to plus an index signature for any other key, deduped and written to
  `package.json` `dbxToolsConfig` at synth, never cached on a field) and
  `project.pnpmWorkspace` (a `PnpmWorkspaceState`:
  `addCatalog`/`allowBuild`; ROOT-only, so `undefined` on a child).
  Reach those fields directly (`project.dbxToolsConfig.tags.push(...)`), not
  via delegator methods on the project.
- **`pnpm-workspace.yaml` is the source of truth**, and projen's OWN
  `javascript.PnpmWorkspaceYaml` writes it — `NodePackage` creates that component
  for every pnpm project, so the engine adds no file of its own. What the engine
  supplies is the OPTIONS object it renders, via
  `pnpmOptions.workspaceYamlOptions`; `PnpmWorkspaceState` (`pnpm-workspace.ts`)
  holds that object and is exposed as the root's `project.pnpmWorkspace` field.
  The root scans the filesystem ONCE at synth (under each `workspacePackageRoots`
  root, default `["workspaces"]`) and the file's `packages:` list is filled from
  `project.subprojects` in the root's `preSynthesize` (so member order/timing
  never matters) — every discovered package becomes a real subproject, no manual
  member list. Mutate it through the typed methods
  `project.pnpmWorkspace?.addCatalog(name, version)` / `.allowBuild(name)` — or,
  for any other pnpm setting, the root's
  `workspaceYaml` option, which is projen's fully typed `PnpmWorkspaceYamlOptions`
  (`overrides`, `packageExtensions`, `catalogs`, …) rather than an
  `addOverride("...")` string path. Never edit the YAML.
  Because projen spreads `workspaceYamlOptions` inside `NodePackage`'s own
  constructor, `PnpmWorkspaceState` keeps STABLE mutable array/object references
  (a spread copies them by reference) and mutates them in place — a getter would
  fire before the root has scanned a single package, and the schema is only
  serialized at synth.
  Do NOT "simplify" those mutators into projen's public
  `file.addOverride("catalog.<name>", …)`. It was tried and measured, and it is
  worse twice over: `addOverride` SPLITS its path on `.`, so a dotted dependency
  name renders as a nested object (`socket.io` → `socket: {io: …}`) — a catalog
  entry no `catalog:` specifier resolves, with no error — and an override for a
  key the schema did not already emit is appended LAST, burying `packages`
  beneath the catalog (seeding `packages: []` does not help; `omitEmpty` strips
  it before overrides apply). `packages`/`catalog` are plain object keys here, so
  neither hazard exists. A regression test pins the dotted-name case.
  The file is ROOT-only, but nothing enforces that: projen attaches a
  `PnpmWorkspaceYaml` to EVERY pnpm project, and a member's copy stays off disk
  only because nothing feeds its schema, so `omitEmpty` drops it. Setting any
  workspace-schema option on a MEMBER (projen's own `allowScripts`, for one) makes
  it real, and a nested `pnpm-workspace.yaml` makes that package look like its own
  workspace root. Keep those options on the root.
  Beyond members/catalog/`allowBuilds`, the engine sets a couple of pnpm settings
  for every workspace (`DEFAULT_WORKSPACE_YAML`), each overridable per repo via
  `workspaceYaml`:
  **`catalogMode: manual`** (the catalog is generated, so `pnpm add` must never
  write into it) and **`verifyDepsBeforeRun: warn`** (packages resolve siblings
  from source, so a stale `node_modules` after a branch switch warns on the next
  task instead of surfacing as a confusing type error). Discovery is TWO functions in `workspace.ts`:
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
  basis an `applyToProjects({ tags })` selection dispatches on). No declaration
  needed: drop a `src/` folder, re-synth.
- **A root may already hold in-tree subprojects.** If a discovered folder matches
  a subproject already attached to the root, it is NOT re-created — the resolved
  tags are pushed onto its `dbxToolsConfig.tags` (deduped at synth). The root
  itself can also carry tags (a `""`/`"."`
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
  - `cli` → Node + `commander` + `@clack/prompts` + a RUNTIME `tsx`; a generated
    `bin/<name>.mjs` launcher per `bin/<name>.ts` entry (see Gotchas); a
    package-rooted tsconfig (`rootDir: "."` + `index.ts`/`bin/**/*.ts` includes,
    since a CLI compiles code outside `src/`); and a DERIVED `exports` map (`.`,
    a `./<module>` subpath per top-level `src` module, `./package.json`). A CLI
    should need no per-package tsconfig or exports config.
  - `shared` → agnostic (the `AGNOSTIC_COMPILER_OPTIONS` floor: no DOM, no Node)
  - `openapi` → generated, read-only clients (`openapi-fetch`, DOM libs)
    Enforcement is real via each package's generated `tsconfig` `lib`/`types`:
    `document` in `shared`/`server` fails `tsc`; `process`/`node:*` in `ui` fails.
- **Per-package behavior is MIXINS** (`mixin.ts`; `constructs` `IMixin`). A mixin
  is `{ supports(c), applyTo(c) }`, applied with the constructs-native
  `construct.with(...mixins)` — it runs each across the construct's whole subtree
  (tree captured at call time), so a root-level `root.with(...)` reaches every
  matching child. Package predicates live in `project-predicate.ts` (exported as
  the `projectPredicate` namespace), as plain callable
  `@dbx-tools/shared-core` predicates (narrowing a construct):
  `projectPredicate.hasIdentifierName("shared-core", ...)` (unscoped npm name glob via
  `match.toPathMatcher`, `→ Project`), `projectPredicate.hasTag(tag, ...tags)` (all tags
  required, `→ DBXToolsProject`), and `projectPredicate.hasPath("workspaces/**", ...)`
  (root-relative folder glob, `→ Project`), plus the `isProject()` /
  `isDBXToolsProject()` guards. Three more match the name from a different angle:
  `hasName` (the RAW projen `project.name`, verbatim, no `PackageIdentifier`
  normalizing), `hasIdentifierPackageName` (the parsed full `@scope/name`), and
  `hasIdentifierScope` (the parsed scope alone). Compose them with `.and()`/`.or()`/`.negate()` - e.g.
  `projectPredicate.hasIdentifierName("shared-core").and(projectPredicate.hasTag("node"))`
  - keeping `hasTag` in the same `.and(...)` (or last when chaining) so its
    `DBXToolsProject` narrowing survives (a later non-tag `.and` re-widens to `Project`).
    Build the mixin with `mixin.create(predicate, consumer)` (`mixin.ts`) and hand it to
    `construct.with(...)`. A `FileBase` guard as the predicate targets any generated file.
    **`project.applyToProjects(construct, options?, ...callbacks)` is the ergonomic
    front-end** and what `.projenrc.ts` actually uses: it AND-s the
    `{ name, identifierPackageName, identifierScope, identifierName, tags, path }`
    globs into one predicate (each a glob or list, `!` to negate), then applies the
    mixin for you. Selection defaults to DBXTools CHILD projects, so the callback
    receives the richer `DBXToolsProject`; `includeRoots: true` adds the parentless
    tree root, and `includeNonDBXToolsProjects: true` adds plain projen `Project`s
    and (via an overload) widens the callback parameter to `Project`, which drops
    `dbxToolsConfig`. The root applies the built-in tag mixins (**`WORKSPACE_TAG_MIXINS`**,
    `tags.ts`) during its own construction, selected by the `defaultTagMixins` option
    (omit = all, `false` = none, or a subset list) - e.g. the `server` mixin adds
    `express`/`tsoa` + `dev`/`start` tasks. Consumers apply their own AFTER
    construction with `applyToProjects(...)` (see `.projenrc.ts`), so user mixins run
    after the defaults.
- **Names**: `PackageIdentifier.of(scope, relPath)`
  (`project.ts`): normalized, lowercased, the root-relative path dash-joined as
  `@<scope>/<seg-seg-...>` (e.g. `workspaces/shared/core` → `@dbx-tools/shared-core`,
  `workspaces/cli/dbx-tools` → `@dbx-tools/cli-dbx-tools`). The `scope` option
  defaults to the resolved project `name`; the `name` option, if omitted, is
  auto-detected (git remote → folder name). This repo passes `scope: "dbx-tools"`,
  giving `@dbx-tools/*` packages. The engine keeps its derived name UNLESS
  overridden — which it is, to the clean `@dbx-tools/cli` (see Gotchas).

## Layout

```
.projenrc.ts                              # new DBXToolsNodeProject({...}) + user mixins + the dbx-tools root task
workspaces/
  cli/dbx-tools/                          # the CLI package (`@dbx-tools/cli`, `dbx-tools` + `dbxt` bins)
    bin/dbx-tools.ts                      # commander entry: sync | barrels | openapi | clean
    index.ts                              # generated barrel (public API surface)
    src/
      bootstrap.ts                        # bootstraps a COMPLETELY EMPTY folder (see Commands)
      cli.ts, pnpm.ts, root.ts            # CLI runtime helpers (bin/pnpm resolution, root init)
  openapi/<name>/                        # generated from tsoa controllers, same root as the source
projen/                                   # the projen engine (`@dbx-tools/projen`), top-level, NOT a workspace member
  index.ts                                # generated barrel (public API surface)
  src/
    project.ts                            # DBXToolsProject + DBXToolsNode/TypeScriptProject + PackageIdentifier/naming, applyToProjects, applyCompilerOptions/applyTasks, SHARED_COMPILER_OPTIONS, root init
    project-predicate.ts                  # projectPredicate namespace (isProject/isDBXToolsProject/hasName/hasIdentifierPackageName/hasIdentifierScope/hasIdentifierName/hasTag/hasPath, .and/.or/.negate)
    mixin.ts                              # mixin.create() factory (tag table lives in tags.ts)
    pnpm-workspace.ts                     # PnpmWorkspaceState (options for projen's native PnpmWorkspaceYaml) + Catalog/DEFAULT_CATALOG + AllowBuilds/DEFAULT_ALLOW_BUILDS + DEFAULT_WORKSPACE_YAML
    tags.ts                               # WORKSPACE_TAG_MIXINS (one IMixin per tag) + AGNOSTIC_COMPILER_OPTIONS
    workspace.ts                          # discovery: scanPackages (fs) + workspacePackages (pnpm-yaml + manifest)
    barrels.ts                            # barrel generator (root index.ts, header + read-only)
    codegen.ts, module-exports.ts         # ts-to-zod codegen + exports-map generation
    watch.ts                              # generic file-watch util (watchLoop + watchRoots) the sync --watch task watchers forward to
    scaffold.ts                           # runSynth({ post })
    release.ts                            # DBXToolsRelease: bump task + tag-driven publish workflow
    openapi.ts                            # openapi generator (tsoa controllers -> spec + client)
    clean.ts, generated.ts, tsconfig.ts, vite.ts, vscode.ts, engine-root.ts, dbx-tools-config.ts
  tasks/                                  # projen task scripts (bump, sync, barrels, openapi, projenrc, clean)
example-workspaces/
  cli/main/ server/api/ shared/core/ shared/fun/ shared/neat/ ui/app/   # seed examples, each a real subproject
```

## Commands

Everything below the install line is a projen TASK the engine registers on the
root, so run it with `pnpm run <task>`. The `dbx-tools` CLI is NOT needed here -
see "The `dbx-tools` CLI" for the one case it exists for.

```sh
pnpm install                 # link workspace + engine
pnpm exec projen             # synth all generated config (+ install + barrels)
pnpm run sync                # one-shot full synth through the sync task
pnpm run sync --watch        # watch while editing (concurrently: projenrc + barrels + openapi watchers)
pnpm run barrels             # rebuild every package's root index.ts barrel
pnpm run openapi             # generate the openapi packages from tsoa controllers
pnpm run clean               # remove generated files (read-only ones); interactive picker, -y to skip
pnpm -r compile              # type-check every package (projen's per-package compile: tsc --build)
pnpm -r --no-bail test       # run every package's node:test suite, without stopping at the first failure
pnpm run eslint              # lint (autofix) every package under workspaces
pnpm run format              # prettier over the WHOLE repo - see "Formatting and diff hygiene" first
```

A cross-package change is verified by all three of `pnpm exec projen`,
`pnpm -r compile`, and `pnpm -r --no-bail test`: synth catches a manifest or
barrel that no longer matches the source tree, compile catches a moved export,
and the tests catch behavior. Use `--no-bail` so one broken package does not hide
the state of the rest.

## The `dbx-tools` CLI

`@dbx-tools/cli` ships the `dbx-tools` bin (aliased `dbxt`). It exists for the
one thing projen cannot do for itself: a folder with no `.projenrc.ts` or
toolchain installed yet, where there are no tasks to run. `dbx-tools sync`
bootstraps that folder and then forwards to projen from then on.

Inside an established workspace the CLI only forwards, so prefer the
`pnpm run <task>` forms above - do not document `dbx-tools barrels` /
`dbx-tools openapi` / `dbx-tools clean` as the way to run engine tasks.

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
- **`dbx-tools sync` on a completely empty folder bootstraps it** (`bootstrap.ts`):
  `pnpm init`, seed a minimal `pnpm-workspace.yaml` (so the very next step can
  approve `tsx`'s `esbuild` build script non-interactively), `pnpm add -D
projen typescript@^5.9.3 tsx@^4.23.0 <engine specifier>`, write a minimal
  `.projenrc.ts` if none exists, synth (`post: false` - skips projen's own
  post-synth install, which has no non-interactive answer for "remove this
  stale node_modules?" with no TTY), then reconcile the install itself
  (`pnpm install --no-frozen-lockfile --force` - `--force` is what makes pnpm's
  own confirmation logic treat that prompt as pre-answered) and regenerate
  barrels. Scaffolds **no** package folders or sample code - just enough for
  `pnpm exec projen`/`dbx-tools sync` to work from here on.
- **`dbx-tools sync` on an existing workspace** just runs projen once (full synth,
  installs, regenerates barrels via the post-synth component) - which is exactly
  what `pnpm run sync` does directly, so prefer that once a workspace exists.
- **`pnpm run sync --watch`** forwards to `projen sync --watch`, which does one
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
- **`pnpm run clean`** (`clean.ts`) deletes generated files. It doesn't hardcode a
  list: every file the toolchain writes is read-only (see below), so a read-only file
  under the repo (skipping vendor/build/VCS, but INCLUDING `.projen/*`) is a clean
  target. It shows a `@clack/prompts` picker with all files preselected (uncheck to
  keep); `-y` removes them all non-interactively. Safe to run - `.projenrc.ts` imports
  the engine by SOURCE path, so `npx tsx .projenrc.ts` (or `pnpm exec projen`)
  regenerates everything afterward.

Barrels re-export every exporting file under `src/` except names starting with
`_`; a package's barrel lives at its ROOT (`index.ts`), re-exporting `./src/*`.

## Working on the packages via the `demo/` app

`demo/` is a standalone downstream CONSUMER: it installs `@dbx-tools/*` from the
registry in `demo/.npmrc` (a local verdaccio), so by default it runs PUBLISHED
package versions, not your working tree. To iterate on the CLIENT UI packages
against the running demo WITHOUT a bump/publish/reinstall each time, use dev-link:

```sh
node demo/scripts/dev-link.mjs          # link the client UI packages to workspaces source
# server (serves dist/, unchanged) + a client build-watch that rebuilds on UI edits:
pnpm --filter @dbx-tools/demo-appkit-server dev
pnpm --filter @dbx-tools/demo-appkit-app exec vite build --watch
node demo/scripts/dev-link.mjs --unlink # restore the registry-consumer resolution
```

`dev-link` adds the client-reachable workspace packages (the closure of the
client app's `@dbx-tools/*` deps: `ui-*` + browser-safe `shared-*`) as pnpm
workspace members and switches the client app's deps to `workspace:*`; it edits
only transient, gitignored files (`pnpm-workspace.yaml`, the app manifest, a
`.dev-link.json` sidecar), and `--unlink` restores them. It is deliberately
CLIENT-ONLY: linking the SERVER packages double-installs their `@databricks/appkit`
/ `@mastra/*` (same version, different peer-hash) so AppKit singletons like
`CacheManager` break ("not initialized"); the browser build avoids this via
vite's React `dedupe`, which tsx has no equivalent for. Server changes still go
through the publish cycle. See `demo/README.md` for the full two-mode explanation.

## Generated files — DO NOT edit by hand

- **Per-package** (`package.json`, `tsconfig.json`, `.projen/*`, `README.md`,
  `.gitignore`, …): owned by that package's projen subproject.
- **Root** (root `tsconfig*.json`, `.vscode/*`, per-package `vite.config.ts`):
  read-only + projen marker, emitted from `files.ts`. `pnpm-workspace.yaml` is
  projen's native `javascript.PnpmWorkspaceYaml`, fed the options
  `PnpmWorkspaceState` (`pnpm-workspace.ts`) holds; unlike the engine's own files
  it is NOT read-only, since projen writes it with `readonly: false`.
- **barrels** (`<root>/<tags...>/<name>/index.ts`): read-only, do-not-edit header,
  written by the engine's own generator (`barrels.ts`). Marked generated in
  `.gitattributes` (`annotateGenerated`).
- **openapi** (`<root>/openapi/<name>/`): fully generated from tsoa
  controllers - spec, types, and client.
- **cli launchers** (`<cli package>/bin/<name>.mjs`): read-only + executable,
  one per `bin/<name>.ts` entry, emitted by the `cli` tag (`cli-bin.ts`).
- **`.github/workflows/*.yml` except `docs.yml`**: projen-owned. `docs.yml` is
  the one hand-written workflow, so it is the only one to edit directly.

Change a tag, a hook, or `.projenrc.ts` and re-synth — never edit generated files.

## Gotchas

- **pnpm gates build scripts behind the `allowBuilds` MAP** in
  `pnpm-workspace.yaml` — `esbuild: true` is the default. Do NOT switch this to
  projen's own `allowScripts` option: for pnpm that renders
  `onlyBuiltDependencies`, and the pnpm this repo installs with (10.33) contains
  ZERO references to that key or to `ignoredBuiltDependencies` — its only build
  gate is `allowBuilds`. Emitting the list would install with every build script
  silently skipped, so keep `PnpmWorkspaceState.allowBuild` writing the map even
  though projen's schema also types the lists. Add allowances via
  `project.pnpmWorkspace?.allowBuild(name)` (or `.addCatalog`, or
  the root's typed `workspaceYaml` option for any other pnpm setting), not by
  editing the YAML. Only ALLOWANCES are declared: a dependency that is never
  allowed needs no entry, because `strictDepBuilds` is deliberately off, so pnpm
  warns (`Ignored build scripts: ...`) and installs. Turning it on would make
  every unreviewed postinstall a hard failure and force a declined entry for each
  one. A stale `node_modules` can report an allowance you just added as still
  unreviewed; re-run with `pnpm install --force`.
- **The `.gitignore` does NOT blanket-exclude dot-paths, and must not start
  again.** `ignore.ignorePatterns` is called with `{ test: false, dot: false }`
  (`project.ts`). The `dot` group is a SCANNING concern - skip `.git` and caches
  when walking the tree - and emitting it into a `.gitignore` breaks the repo in
  a way that hides itself. `**/.*` excludes dot-DIRECTORIES, git never descends
  into an excluded directory, so every per-file `!/.projen/tasks.json` negation
  projen emits to FORCE its generated files into git becomes a no-op. Files
  already in the index keep working, so nothing appears wrong; only newly
  generated ones are silently unaddable. That is exactly what happened here - 7
  packages had their `.projen/*.json` committed and 27 could not - and it stayed
  invisible for months. Ignore CONTENTS (`.idea/*`), never the directory, so a
  later negation can still reach inside. Verify any ignore change with
  `git add --dry-run <path>`, never `git check-ignore` alone, which reports the
  per-file rule and hides the parent-directory one that actually decides.
- **Dot-paths that must stay out of git are named explicitly.** The engine adds
  the secrets and editor set (`.env`, `.env.*` with `!.env.example` /
  `!.env.sample`, `.idea/*`); `.projenrc.ts` adds this repo's generated
  dot-directories (`.docs-build/`, `.astro/`, `.worktrees/`). A new generated
  dot-directory needs a line in one of those two places - it will otherwise show
  up as untracked, which is the intended failure mode now (loud, not silent).
- **The published tarball is an ALLOWLIST, not everything on disk.** Every
  package gets `files: ["index.ts", "src"]` at construction
  (`addPackageFiles`, `project.ts`); the `cli` tag adds `"bin"` for its
  launchers. `lib/`, `test/`, `.projen/`, and `tsconfig*` are deliberately
  withheld - none is reachable through the `exports` map, and shipping them
  quadrupled the tarball (shared-core went 67 files -> 16). If a package needs
  to ship a path outside `src`, add it with `addPackageFiles(p, "...")` from a
  tag or an `applyToProjects` block; do NOT hand-edit the manifest, which is
  projen-owned and read-only.
- **`arethetypeswrong` is RED on node10/node16 by design.** Packages publish
  TypeScript SOURCE (`exports` points at `index.ts`) and compile under
  `moduleResolution: bundler`, so only the `bundler` column is green. That is
  the supported consumption model: a bundler (Vite) or tsx, never bare Node
  `require`/`import` of the published package. A red node16 row is therefore
  expected output, not a regression to "fix" - changing it would mean
  abandoning source-first resolution, which is what lets workspace packages
  type-check against each other with no build step.
- **`pnpm-lock.yaml` is UNTRACKED, and nothing in CI may depend on it existing.**
  It is covered by `.gitignore`'s `**/*-lock.yaml`, but it had been committed
  before that rule existed and an ignore rule cannot untrack an already-tracked
  path, so it stayed in the index for a long time while appearing to be ignored.
  That state hid itself: `git check-ignore pnpm-lock.yaml` consults the index and
  reports a TRACKED file as not ignored, never mentioning the rule that matches
  it - only `--no-index` shows the rule. It has since been `git rm --cached`ed.
  The reason to keep it out is that a lockfile resolved here can carry a
  private-registry fingerprint; verify with
  `rg -c 'localhost:4873|/Users/' pnpm-lock.yaml` before ever committing one.
- **Do NOT set `workflowPackageCache: true`, and do not add `cache: pnpm` to a
  hand-written workflow.** `actions/setup-node`'s package cache keys off a
  lockfile in the tree; with `pnpm-lock.yaml` untracked the step fails the job
  outright with "Dependencies lock file is not found". Turning it off removes
  the `Setup Node.js` step from `build.yml` entirely, which is harmless - it
  never pinned a `node-version`, so the runner's preinstalled Node is used
  either way, exactly as before.
- **No CI install is `--frozen-lockfile`, and that is deliberate.** With no
  committed lockfile there is usually nothing to freeze against, and frozen
  turns that into a hard failure of a PUBLISH, which is the worst place to
  discover it. That is not hypothetical: it broke the v0.3.38 release and the
  docs deploy at once. `build.yml` additionally needs a mutable install because
  its self-mutation job exists to commit regenerated files back to the PR. The
  cost of this choice is that CI resolves dependencies fresh, so a bad upstream
  publish can break a build that nothing here changed.
- **Keep `link:` specifiers RELATIVE in `.pnpmfile.cjs`.** An absolute
  `path.resolve(__dirname, ...)` is recorded verbatim as the lockfile specifier,
  which pins the lockfile to one developer's home directory and leaks that path.
  Every install elsewhere then fails comparing `link:/Users/<someone>/...`
  against `link:/home/runner/...`. Relative resolves against the IMPORTING
  package's directory, so it only works while the importer's depth is known -
  today the repo root is the sole importer of `@dbx-tools/projen`.
- **There is no Dependabot, and third-party actions are on major tags.** Both
  were tried and removed: SHA pins with no updater just rot, and Dependabot PRs
  edit projen-GENERATED workflows, which the next synth reverts and the build's
  self-mutation check then fails. Reintroducing either means solving that
  generated-file conflict first.
- **eslint is still eslintrc, and that is projen's limit, not a choice.**
  projen (0.101.x) emits `.eslintrc.json` and has no flat-config support, so
  the `eslint` task sets `ESLINT_USE_FLAT_CONFIG=false` to make eslint 9 load
  it. That escape hatch disappears in eslint 10, so the eslint major is pinned
  until projen can emit `eslint.config.*`. Do not hand-write a flat config
  beside the generated one - two configs is worse than one stale one.
- **The engine is dogfooded as a normal auto-discovered package**, not a hand-
  authored special case: it lives at `workspaces/cli/dbx-tools` (tag `cli`,
  name `dbx-tools`), which auto-discovery would otherwise render as
  `@dbx-tools/cli-dbx-tools`. `.projenrc.ts` selects it with
  `project.applyToProjects(root, { identifierName: "cli-dbx-tools", tags: "cli" }, ...)` and:
  overrides the name to `@dbx-tools/cli` (`p.package.addField("name", ...)`),
  adds its bins - `dbx-tools` plus the short `dbxt` alias, both pointing at
  `./bin/dbx-tools.mjs` (npm exposes every `bin` key as its own command) - and
  depends on `@dbx-tools/projen`. That is ALL it declares: tsconfig
  (`rootDir: "."` + the `index.ts`/`bin/**/*.ts` includes) and the `exports` map
  come from the `cli` tag, so a CLI needs no per-package config for either.
  It is the ONLY package in the repo that overrides its name: every other one,
  CLIs included, keeps what discovery derives from its path
  (`workspaces/cli/model-proxy` -> `@dbx-tools/cli-model-proxy`,
  `workspaces/cli/appkit-env` -> `@dbx-tools/cli-appkit-env`). To rename a
  package, MOVE ITS FOLDER - do not add a name override.
  The projen engine itself lives in `projen`
  (`@dbx-tools/projen`). It is NOT a workspace member and no mixin reaches it, so
  it is synthesized by its own `projen/.projenrc.ts`, which declares its deps
  inline (`projen`, `constructs`, `oxc-parser`, `@dbx-tools/path`, ...) - edit
  that `deps: [...]` list, then re-synth from inside `projen/`.
- **A CLI's `bin` points at a generated `.mjs` launcher, never the `.ts` entry.**
  Node can't run the `.ts` directly, and the obvious fix - a
  `#!/usr/bin/env -S npx tsx` shebang - only works inside a workspace checkout,
  because `npx` resolves tsx from the CALLER'S cwd. After `npm i -g
@dbx-tools/cli` that cwd is unrelated to the package, so every first run
  stalled to download tsx (and failed outright offline). So the `cli` tag makes
  `tsx` a RUNTIME dep (not the baseline devDep, which it removes) and emits
  `bin/<name>.mjs` beside each `bin/<name>.ts` (`cli-bin.ts`,
  `addCliBinLaunchers`). The launcher reaches tsx through a bare
  `import { register } from "tsx/esm/api"`, which NODE resolves relative to the
  launcher's own location - i.e. the CLI's own `node_modules` - then hands off to
  the `.ts`. Entries are discovered by scanning `bin/` at synth, so a new CLI
  only needs its `.ts` file plus a `package.json` bin naming the `.mjs`.
  Compiled `lib/` output is NOT a usable bin target: the sources use
  extensionless imports (`moduleResolution: bundler`), which Node ESM can't
  resolve without tsx.
- **CLI command names are `dbx-tools-<name>` plus a short `dbxt-<name>` alias**,
  and the `bin/` entry file is named after the primary command - so
  `bin/dbx-tools-model-proxy.ts` backs `dbx-tools-model-proxy` /
  `dbxt-model-proxy`. `@dbx-tools/cli` is the degenerate case of the same rule
  (`bin/dbx-tools.ts` -> `dbx-tools` / `dbxt`). Note the package name and the
  command deliberately DIVERGE (`@dbx-tools/cli-model-proxy` ships
  `dbx-tools-model-proxy`), so `npx @dbx-tools/cli-model-proxy` can't pick a bin
  on its own - name the command: `npx --package @dbx-tools/cli-model-proxy
dbx-tools-model-proxy`, or just install it.
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
  each package's tag tsconfig), not a `dbx-tools` command - the tag `lib`/`types`
  overrides are what make misuse fail. Check one package with `pnpm exec projen
compile` (or `pnpm compile`) in its dir, or all of them with `pnpm -r compile`.
- **Heavy tools are resolved lazily** (a memoized `require`, not a module-level
  import): `module-exports.ts` loads `oxc-parser` this way, and `codegen.ts` /
  `openapi.ts` do the same for `typescript` / `ts-to-zod` / `tsoa`. Resolving
  eagerly broke merely _importing_ the engine (which the barrel pulls in) whenever
  a consumer's install of that tool was an unusual version with a narrower
  `exports` map.
- **Prefer projen's own type guards over `instanceof` for projen classes.**
  `projectPredicate.isProject` calls `Project.isProject(c)`, which tests for
  `Symbol.for("projen.Project")` (stamped by every `Project` constructor) instead
  of an identity check against one loaded class. That matters here because the
  engine pins its OWN `projen` dependency (`PROJEN_VERSION`) separately from a
  consuming root's, so two copies can resolve and `instanceof` would fail
  silently. Engine-owned classes (`DBXToolsNodeProject` /
  `DBXToolsTypeScriptProject`) carry no such symbol and correctly stay on
  `instanceof`. Same reasoning for tree walks: `project.node.findAll()` is
  projen/constructs' native preorder walk, so there is no hand-rolled recursion
  over `subprojects`.
- **There is exactly ONE TypeScript parser in the engine: `oxc-parser`**, behind
  `module-exports.ts`. Both of the barrel generator's AST needs go through it -
  `moduleStatements(file)` (is this file a module at all; what does a hand-authored
  `exports.ts` declare) and `moduleExports(file)` (the package-unique names to
  hoist). An earlier version parsed the same files a second time with
  `@typescript-eslint/typescript-estree`; both emit the same ESTree node types, so
  that dep was dropped. Add new static analysis on `moduleStatements`, not a
  second parser.
- Repo is `type: module`. Packages get a `module: ESNext` + `moduleResolution:
bundler` overlay (`SHARED_COMPILER_OPTIONS` in `project.ts`) because projen's
  default `module: CommonJS` breaks the ESM sources' `import.meta`; `bundler`
  honors the `exports` map, so a bare `@dbx-tools/<pkg>` import resolves to that
  package's ROOT `index.ts` barrel — packages type-check against each other with
  no build step. Cross-package imports still need the workspace dep declared
  (`p.addDeps("@dbx-tools/shared-core@workspace:*")` in an `applyToProjects(...)`) and MUST
  use the package name (`@dbx-tools/path`), never a relative path into
  another package's `src/` (e.g. `../../../../node/path/src/find`).
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
- **OpenAPI** (`openapi.ts`, `pnpm run openapi`): scans **every discovered**
  `server`/`node` package for **tsoa** controllers (classes with
  `@Route`/`@Get`/... - no JSDoc/YAML). For each, tsoa's `generateSpec` infers an
  OpenAPI 3 spec from the decorators + TS types, then openapi-typescript +
  openapi-fetch produce a read-only `<sourcePackage root>/openapi/<name>`
  package (`openapi.json` + `src/schema.ts` + `src/client.ts`) - colocated under
  the SAME root as the controller it came from (`example-workspaces/server/
api`'s controllers generate `example-workspaces/openapi/api`), not a hardcoded
  root. tsoa/typescript/openapi-typescript are lazy-loaded (only `pnpm run
openapi` / a watched controller edit needs them). The openapi watcher (started by
  `pnpm run sync --watch`, under `concurrently`) regenerates it automatically when a
  controller changes.
- **Brand theming is a `[data-brand]` token bridge, opt-in by detection.**
  `@dbx-tools/ui-branding` writes portable `--brand-color-*` / `--brand-font-*`
  CSS vars, but the UI components style off AppKit's shadcn semantic tokens
  (`--primary`, `--ring`, `--sidebar-primary`, ...). The bridge that connects
  them is `ui-branding/src/brand-bridge.css`, scoped to `:root[data-brand]` and
  `@import`ed from `ui-appkit/styles.css` (so it travels with EVERY feature UI
  package via the shared base — `ui-appkit` deps `ui-branding`). It is INERT
  until `applyBrandContext()` (via `BrandProvider applyToDocument`) sets the
  `data-brand` attribute, so default AppKit is never disturbed. It is
  identity-only (primary/accent/ring/sidebar-primary + fonts); it deliberately
  does NOT remap neutrals (`--background`/`--foreground`/`--muted`/`--border`)
  because the brand carries a single light palette — remapping neutrals would
  break dark mode. To theme a host: wrap in `<BrandProvider applyToDocument>`
  (pass `context` for a non-default brand). New semantic tokens to re-skin go in
  `brand-bridge.css`, not per-component.
- **Chart branding is server-side, on the Echarts option.** The `[data-brand]`
  CSS bridge can't reach an Echarts chart (it renders to canvas, not styled
  DOM), so charts are themed the way email is: by inlining brand values at build
  time. `mastra({ brand })` takes a portable `BrandContext`; the chart planner
  (`appkit-mastra/src/chart.ts` `planToEchartsOption`) merges a
  `brandChartTheme(brand)` into every spec (`themed(...)`) - a series `color`
  cycle seeded from `colors.primary`/`colors.accent` plus a colorblind-friendly
  spread, and a base `textStyle` (font `typography.sans`, color
  `colors.foreground`). Omit `brand` for the default Echarts look. Add new
  themed properties in `brandChartTheme`/`themed`, not per-chart-type.
- **Web search uses the Databricks NATIVE tool + its own model.**
  `appkit-web-search` `web_search` does NOT scrape — it POSTs the query to a
  serving endpoint with the provider's web-search tool spec attached and the
  model answers with citations. The tool spec is provider-specific
  (`provider.ts`: `WEB_SEARCH_PROVIDERS` — openai→Responses `{type:web_search}`,
  gemini→Chat `{google_search:{}}`; overridable via `WEB_SEARCH_TOOLS`). The
  web-search model is resolved SEPARATELY from the agent's chat model because
  the agent may run on a model without web search. Resolution runs against the
  LIVE catalogue (`@dbx-tools/model` `listServingEndpoints` + `resolveModel`,
  filtered to `supportsWebSearch`) so it never returns a non-deployed id;
  Gemini→GPT fallback order. An explicit unsupported model errors; when NO
  native model is deployed it returns null and `runWebSearch` uses the
  DuckDuckGo scrape fallback (`scrape.ts`, got-scraping GET — a POST trips DDG's
  202 bot challenge; `scrapeFallback`/`WEB_SEARCH_SCRAPE_FALLBACK` gates it,
  default on). Native is always preferred. `search.ts` calls the serving REST
  surface through the OBO client's `apiClient.request({payload})` (same pattern
  as `appkit/src/lakebase-resolver.ts`). `web_fetch` also uses got-scraping.
- **Generated API-docs links are ABSOLUTE, base-prefixed, and verify-and-drop.**
  Starlight serves every content page at a trailing-slash directory route
  (`/api/<pkg>/namespace-x/`), so a bare relative link between flat sibling
  pages resolves as a nested child → 404. `docs/scripts/generate-api-docs.mjs`
  `slugifyApiFiles` therefore rewrites intra-package links to
  `${base}/api/<pkg>/<slug>` (base derived like `sync-readmes.mjs` from
  `GITHUB_REPOSITORY`), which resolves identically from index/namespace/symbol
  pages, and DROPS (unwraps to text) any link whose target page doesn't exist on
  disk. When adding a docs generator change, keep links absolute — never emit a
  bare or `./`-relative cross-page link.
- **Model display names.** `ServingEndpointSummary` carries an optional
  `displayName` alongside `name` (the invoke id). It flows through `/models`
  (wire `ServingEndpointsResponseSchema`) automatically. Derivation lives in the
  pure `@dbx-tools/shared-model` `display.toModelDisplayName(name, provided?)`
  (browser-safe, reuses `shared-core`'s `string.tokenizeWithOptions`): prefer a
  Databricks-provided name (a `display_name`/`displayName`/`name` endpoint tag or
  an external-model name — extracted in `node/model` `serving.ts`), else strip
  leading vendor prefixes (`databricks`/`system`/`dbx`, plus `ai` only as the
  `system.ai.*` namespace half) and title-case. Also dots numeric version runs
  (`...-4-6` -> "4.6"), glues size units (`120b` -> "120B"), and uppercases
  acronyms (GPT/GTE/BGE/OSS/AI). The UI picker shows `displayName ?? name`. Add
  new strip prefixes / acronyms / size units in `shared-model/src/display.ts`.
  The `v<digit>` version marker (`v2` -> "V2") is kept as one token by a
  `shared-core` tokenizer override, alongside the `ai` -> "AI" one.
- **Default-model endpoint.** The picker labels its default option (the model
  used when the client pins none) from `GET /default-model` (and
  `/default-model/:agentId` - agent-scoped by the same `/:agentId` path-suffix
  convention as `/history`/`/threads`/`/suggestions`, NOT a query param), which
  returns `{ agentId, model, displayName }` with the server-humanized name so
  the label never flashes a raw id or waits on `/models`. `model`/`displayName`
  are null for a dynamic (call-time) model. Route: `MASTRA_ROUTES.defaultModel`
  - `DefaultModelResponseSchema` (shared-mastra), handler + `BuiltAgents.defaultModels`
    (appkit-mastra), client `defaultModel()` + `useMastraDefaultModel` hook
    (ui-mastra). This is deliberately an endpoint, NOT a field on the static
    `clientConfig` (per-agent + can be dynamic; the config sanitizer also redacts
    values matching env vars like `DATABRICKS_SERVING_ENDPOINT_NAME`). The picker
    shows the humanized name or a neutral "Default" - no "server default" text.
- **Chat export (`ui-mastra/src/support/export.ts`)** produces `pdf` |
  `markdown`. `pdf` renders one branded, self-contained HTML document and drives
  it through a hidden `<iframe>` + `print()` (Save-as-PDF dialog, no popup tab;
  falls back to an `.html` download when there's no DOM body). The module is
  framework-free: brand styling arrives as a plain `ExportBrand` (`logoDataUrl` +
  colors + font), which the driver (`mastra-chat.tsx`) resolves from the active
  `BrandProvider` via `useBrand()` (`context.assets.logo.light` -> `resolveAsset`
  data URL, `context.colors`, `context.typography`). `buildDocumentCss(brand)`
  interpolates it with neutral fallbacks. The email UI (`ui-email`) needs no
  export/brand code — it styles off AppKit tokens, so the `[data-brand]` bridge
  re-skins it automatically wherever a brand is applied.
- **Concurrent threads + steering (`ui-mastra`).** The `useMastraChat` driver
  keeps a per-thread `ThreadSession` map (each with its own `abortController` +
  `runToken`); chunks route by `threadId`, so many threads stream at once. Every
  request carries its own thread + model as PER-CALL headers (`streamAgent` in
  `mastra-client.ts`) with its own `AbortSignal` — there is NO shared mutable
  client routing (the old `setThreadId`/`setModelOverride` header mutation was
  removed) so concurrent runs never collide. Cancel is thread-addressed
  (`stop(threadId?)`), exposed to the drawer as `onCancelThread`. Mid-turn
  steering is a QUEUE, not a single action: `sendMessage` on a running thread
  pushes a `QueuedSteer` onto `session.queuedSteers` (no interrupt); the queue
  drains oldest-first when the turn ends (auto-start in `driveStream`'s success
  path via `drainQueueRef`, which breaks the `driveStream`↔`runStream` cycle),
  and `onSendSteerNow(id)` fires any item early by interrupting the current run
  (`runStream`/`driveStream` supersede via abort + `runToken` bump), while
  `onRemoveSteer(id)` drops one and `onReorderSteers(ids)` reorders the queue
  (the chips are native-HTML5-draggable). Queue helpers (`enqueueSteer` /
  `removeSteer` / `reorderSteers`) are pure + unit-tested in thread-sessions.ts. True mid-run message delivery
  (Mastra's experimental `queue-message` / `deliver`) was NOT used — the agent
  didn't fold queued messages into the live turn, so enqueue + interrupt-restart
  is the reliable model. Cancelling / superseding a run settles stuck `running`
  tool pills via `terminateRunningToolEvents` (thread-sessions.ts).

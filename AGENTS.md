# AGENTS.md

Orientation for AI agents / new contributors. Read this first.

## Canonical agent instructions

This file is the canonical repo instruction set for Codex, Claude, Cursor, and
other coding agents. Keep tool-specific files such as `CLAUDE.md` and Cursor
rules as thin pointers back here so instructions do not drift.

Before authoring or changing an AppKit-facing plugin, package, or its docs, check
the installed AppKit surface directly (`npx @databricks/appkit docs`, plus the
`.d.ts` files under `node_modules/@databricks/appkit`) so `dbx-tools` packages
stay shaped like first-party AppKit ones.

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
- Qualify aliased named imports by their SOURCE package or module, not by the
  role they happen to play in one consumer. For example, write
  `import { config as coreConfig } from "@dbx-tools/core"`, not
  `config as runtimeConfig` or `config as configModule`. Preserve conventional
  compatibility aliases and aliases that disambiguate two same-named symbols;
  when an alias is needed, a reader should be able to infer where it came from.

## What this repo is

`dbx-tools` is primarily a set of companion packages for Databricks developers
building Databricks Apps, AppKit backends, Mastra agents, Genie workflows, Model
Serving integrations, approval-gated email flows, and AppKit-oriented React UI.

The repo also includes a projen/pnpm workspace generator because the packages are
dogfooded here, but that is contributor tooling, not the primary product story.
Keep generator details in `projen/README.md` and
`packages/js/cli/dbx-tools/README.md`.

Primary package areas:

- `packages/js/node/appkit` and `packages/js/cli/appkit-env` — AppKit defaults,
  Lakebase env/config resolution, execution-context helpers, plugin lookup, SDK
  cancellation, and cache-schema provisioning.
- `packages/js/node/postgres` — reusable Postgres advisory-lock primitives plus a
  topic bus built on dedicated `LISTEN` connections and `NOTIFY` broadcasts.
- `packages/js/node/appkit-mastra`, `packages/js/shared/mastra`, and
  `packages/js/ui/mastra` — Mastra inside AppKit, shared route/wire contracts,
  and the matching React chat UI.
- `packages/js/node/genie` and `packages/js/shared/genie` — low-level Genie
  drivers, typed async events, snapshot diffing, and browser-safe Genie
  contracts. `shared/genie` also owns the codegen'd `src/dashboards.ts` (zod
  schemas from the upstream SDK `.d.ts`) that its Genie schemas widen; that used
  to be a separate `shared-sdk-model` package with exactly one consumer.
- `packages/js/node/model`, `packages/js/shared/model`, and
  `packages/js/cli/model-proxy` — intent-based Model Serving endpoint selection,
  shared schemas/classification, and local OpenAI-compatible proxying.
- `packages/js/node/search`, `packages/js/shared/search`, and
  `packages/js/ui/search` - extensions around AppKit's beta `aiSearch` plugin:
  agent tools, federated search, Vector Search index lifecycle, reusable search
  UI, and an AppKit-compatible Lakebase full-text provider. Native AppKit owns
  Vector Search query execution, OBO, caching, reranking, pagination, routes,
  and the React query hook.
- `packages/js/node/email`, `packages/js/shared/email-template`,
  `packages/js/shared/email`, and `packages/js/ui/email` — approval-gated email
  tool/runtime, a universal React Email presentation layer, shared payload
  schemas, and matching React approval/compose surfaces. Outbound HTML and
  browser previews share the same React Email components, with the repository
  brand applied unless a consumer supplies its own `EmailBrand`.
- `packages/js/node/auth`, `packages/js/shared/auth`, and
  `packages/js/ui/auth` - Better Auth passwordless runtime, browser-safe status
  contracts, and passkey-first React UI. Better Auth owns users, email OTP
  lifecycle, sessions, built-in rate limits, and passkeys. Callers supply
  authorization policy, delivery, secret, origin, and a Lakebase pool or SQLite
  config. Storage defaults to SQLite in the platform data directory, while a
  native AppKit Lakebase pool provides shared persistence. Programmatic Better
  Auth migrations run under a Postgres advisory lock or local file lock. Never
  derive WebAuthn RP ID or expected origin from a request header.
- `packages/js/node/tunnel` and `packages/js/cli/tunnel` - tunnel Host
  detection, protected-header stripping, branded email delivery, identity
  injection, and AppKit/CLI transport adapters over `@dbx-tools/auth`. Both
  modes construct the same `authGate` plugin through `@dbx-tools/appkit`'s
  `createApp` lifecycle; CLI mode needs no `server()` plugin and can still add
  native `lakebase()`. Authentication UI imports directly from
  `@dbx-tools/ui-auth`; email packages do not re-export auth.
- `packages/js/node/appkit-web-search` — web-search add-on: `web_search` (the
  Databricks Model Serving NATIVE web-search tool — the model searches the web
  server-side and returns answer + citations; resolves its OWN web-capable model
  via `@dbx-tools/model`, Gemini→GPT, independent of the agent's chat model) +
  `web_fetch` (got-scraping page fetch). A provider→tool-spec map (OpenAI
  Responses `{"type":"web_search"}`, Gemini Chat `{"google_search":{}}`), an
  optional URL allow-list (built on `@dbx-tools/path`'s `match`) filtering
  citations / refusing disallowed fetches, per-tool approval gating, and the
  AppKit `web-search` plugin. Same shape as node-email.
- `packages/js/node/teams`, `packages/js/shared/teams`, and `packages/js/ui/teams`
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
- `packages/js/ui/appkit` — AppKit UI/Tailwind foundation used by feature UI
  packages.
- `packages/js/node/databricks` and `packages/js/node/databricks-zerobus` —
  workspace/cloud/Zerobus infrastructure helpers.
- `packages/js/shared/core`, `packages/js/node/core`, and `packages/js/node/path`
  — cross-runtime and Node utility foundations.
- `packages/py/core` — dependency-free Python configuration and identity helpers
  shared by Python packages. Its `config` module mirrors
  `packages/js/node/core/src/config.ts`: scoped environment lookup, project-root
  `.env` discovery, lazy `databricks bundle validate --output json` fallback,
  Databricks App detection, and the same string/boolean/positive-number/list
  coercions. Keep this base deliberately small so importing config, a hash,
  stable key, or identifier formatter does not pull database/runtime
  dependencies with it.
- `packages/py/postgres` — Python Lakebase/Postgres address parsing and
  WorkspaceClient-backed connection resolution, sync/async advisory locks, and
  the async topic bus. It is the port of ONE Node package
  (`packages/js/node/postgres`, plus that package's address helper in
  `packages/js/node/appkit`), so everything Node keeps in `node/postgres` stays
  here rather than fanning out into a Python package per module. Keep its
  accepted address shapes aligned with
  `packages/js/node/appkit/src/pgaddress.ts`, and keep advisory-lock ids aligned
  with `packages/js/node/postgres/src/advisory-lock.ts` through colocated polyglot tests.
  Its `topic_bus` module's public lifecycle and wire envelope mirror
  `packages/js/node/postgres`'s `PostgresTopicBus` so Node and Python services
  can share a channel. Two Databricks-runtime facts, verified
  on serverless notebook compute and documented in the package README, are easy
  to rediscover the hard way: a notebook kernel ALREADY runs an event loop (so
  `asyncio.run` in a cell raises, and the fix is a short-lived thread with its
  own loop, not `nest_asyncio` — the bus's `LISTEN` connection is bound to
  whichever loop started it), and a `pip install --target` leaves the runtime's
  preloaded `typing_extensions` shadowing the installed one so
  `dbx_tools.postgres` fails to import with `TypeAliasType`. Use `%pip`, which
  restarts the process. Publishing from a Spark UDF works BECAUSE credentials are
  injected at connect time: executors have no Databricks auth, so the driver
  mints a token, the UDF closes over it, and
  `install_credential_injection(engine.sync_engine, lambda: token)` supplies it
  without a `WorkspaceClient` on the executor. Do not `listen` from a UDF — the
  invocation is short-lived and the connection is not. The built-in
  provisioned and Autoscaling credential providers cache until the credential's
  renewal time and use process-local check-lock-check refresh, so a SQLAlchemy
  pool connect storm mints once. A caller-supplied `credential_provider` owns
  its own caching and refresh policy.
- `packages/py/model` — Python Model Serving invocation, endpoint listing,
  classification, resolution, chat sanitization, and embedding helpers. It
  mirrors the reusable `shared/model` + `node/model` contract without AppKit
  cache or Mastra dependencies; deterministic behavior belongs in the colocated
  model polyglot tests.
- `packages/py/litellm` — thin LiteLLM integration for Databricks Model
  Serving. It resolves the profile from the CLI argument,
  `DATABRICKS_CONFIG_PROFILE`, then the Databricks CLI's configured default;
  adds live endpoint discovery, fuzzy model resolution, and tool-capability
  filtering; then delegates to LiteLLM's built-in Databricks provider. Keep
  authentication,
  transport, parameter mapping, streaming, retries, embeddings, and
  Chat↔Responses conversion in LiteLLM. Compatibility guards may repair only
  documented Databricks serving constraints: assistant text prefill, the JSON
  prompt rule, Claude cache breakpoints, request size, and rejected Chat-only
  parameters. Do not add general provider conversion here. The Responses
  pre-call hook may change only the resolved
  model identifier so Responses-only endpoints reach LiteLLM's native
  Databricks Responses provider. Its process-wide credential cache is the sole
  refresh owner: SDK background refresh stays disabled and `current()` uses a
  check-lock-check load so parallel requests cannot pile up token mints.
  LiteLLM is exact-pinned because the remaining narrow monkey-patches touch
  private APIs. Keep the FastAPI upper bound until LiteLLM includes its
  `get_flat_params` compatibility fix.
- `packages/py/graphiti` — native local launcher for upstream Graphiti's MCP
  server with a Neo4j 5 backend. It must not use containers: provision Java and
  uv through mise, cache pinned upstream distributions under the user's data
  directory, and keep Graphiti behavior in upstream Graphiti rather than
  vendoring its implementation here.

- **`packages/js/`** — JavaScript and TypeScript package content goes here.
- **`packages/py/`** — Python packages in the root uv workspace go here.
  Every package must remain directly pip-installable from this repository with
  `git+https://...@main#subdirectory=packages/py/<name>`. Keep the Git URL,
  branch, and package root centralized in `.projenrc.ts`'s `pythonRepository`;
  generate package `Source` URLs and internal Python Git dependencies from it.
  Keep the root and every member's `requires-python` generated from the same
  `pythonRequires` value; the default Databricks serverless notebook runtime is
  part of the supported floor and must be covered by the Python test matrix.
  Do not copy lfp-build's `${PROJECT_ROOT}` file-reference mode here: that is a
  local workspace convenience, while pip ignores uv workspace sources when it
  resolves a package selected by Git `#subdirectory`.

  Naming is flat: `packages/py/<name>` builds distribution `dbx-tools-<name>`
  and imports as `dbx_tools.<name>`. There is no `node`/`shared`/`ui` segment.
  The JavaScript tree needs those tiers because a browser bundle must not be
  able to reach `node:fs`, and each tag's tsconfig `lib`/`types` enforces it.
  Python ships no browser bundle, so the tier would name a distinction that
  nothing checks. A Node `shared/<x>` contract and its `node/<x>` runtime
  therefore collapse into ONE `packages/py/<x>`: `shared/core` plus `node/core`
  are both `dbx_tools.core`, and `node/postgres`'s advisory locks and topic bus
  are both `dbx_tools.postgres`. Name a Python package after the capability a
  caller asks for (`model`, `genie`, `databricks`), and let the module split
  inside `src/` carry the distinctions a tag or a filename carries in Node —
  `classify.py` next to `serving.py`, `topic_bus.py` next to `engine.py`, rather
  than a package each.

  The unit that becomes a Python package is a Node PACKAGE, never a Node MODULE.
  `topic-bus.ts` is one file in `node/postgres` because a bus needs the same
  connection machinery an engine does; a `packages/py/bus` reproduced that file's
  prominence rather than its package's boundary, and it had to depend on
  `dbx-tools-postgres` to do anything — the signal that it was inside that
  boundary all along. When a Python name is more famous than the Node package it
  came from, export the name, not a package — importing `PostgresTopicBus` from
  `dbx_tools.postgres` reads exactly like the Node import it mirrors.

  Split a Python package out only for the reason the JavaScript tree splits:
  to keep a dependency out of a consumer's install. `dbx_tools.core` stays
  dependency-free, `dbx_tools.postgres` owns SQLAlchemy and the SDK, and a port
  that needs neither must not import them transitively. Merging a Node
  `shared`/`node` pair costs nothing when the runtime half's dependencies are
  the ones the caller wanted anyway; when they are not, keep the pure functions
  importable without the client (`dbx_tools.model.classify` needs no
  `WorkspaceClient`).

- **`packages/example/`** — seed/example packages when present. Do not make
  root docs primarily about examples. `packages/example/notebooks/` holds
  Databricks notebooks in `# Databricks notebook source` source format, which is
  a plain `.py` file that diffs and lints — never commit `.ipynb` here. Take
  connection details from `dbutils.widgets` with no default pointing at a
  specific workspace, and end with
  `dbutils.notebook.exit(json.dumps(results))` so a job run's output is a
  machine-readable pass/fail per stage rather than something a human has to read
  out of cell output.
- **`packages/test/`** — private cross-package and cross-runtime test harnesses.
  `packages/test/polyglot` owns the Bun-native `polygotTest` / embedded-Python
  helpers. Pure deterministic contracts run beside the TypeScript
  source-of-truth package through one shared test callback. Runtime-specific or
  process-isolated behavior stays in the owning Node or Python package's native
  test suite.

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
- Do not lead with projen, package discovery, generated files, barrels, mixins,
  or package-scanning internals.
- Link to `projen/README.md` and
  `packages/js/cli/dbx-tools/README.md` only under contributor/development
  context.

Package README rules:

- Describe functionality achieved by importing the package, not just file names.
- Include concrete examples and developer benefits.
- Avoid repeating adjacent package docs; link instead.
- Keep browser-safe shared packages framed as contracts/schemas/types, and Node
  packages framed as runtime behavior.
- For UI packages, document public subpaths such as `@dbx-tools/ui-mastra/react`
  or `@dbx-tools/ui-appkit/styles.css`; do not use generated package-root namespaces
  unless the package export map exposes them.
- Do not publicly mention any predecessor repo, branch, or migration source.

Docs site rules:

- Source of truth is `README.md` plus `packages/js/**/README.md`.
- `packages/py/**/README.md` documents the published Python packages on GitHub
  and generates the Python package pages under `/packages/py-*`. Python packages
  have no TypeDoc API pages; keep install and runtime guidance in their READMEs
  and summarize them in the root README's Python Packages table.
- A `private: true` package is EXCLUDED from the site by both generators. A
  private package never reaches npm, so a page for it documents something a
  reader cannot install. Both `discoverPackages()` functions filter on it, which
  is also what relaxes the missing-README throw to published packages only: an
  unpublished spike may have no docs, a published package may not. Keep a README
  on a private package for contributors anyway (say it is unpublished), and keep
  it out of the root README's package tables.
- `docs/scripts/sync-readmes.mjs` generates the Starlight site under
  `.docs-build/site`.
- `docs/scripts/generate-api-docs.mjs` generates TypeDoc Markdown into the same
  Starlight content tree from package `index.ts` exports.
- `.github/workflows/docs.yml` builds and deploys GitHub Pages from generated
  README and API content.
- Generated files under `.docs-build/` are build artifacts; never commit them.
- If navigation is wrong, update the generator. If prose is wrong, update the
  source README.
- Content that belongs on GitHub but not on the site goes between
  `<!-- docs-site:ignore:start -->` and `<!-- docs-site:ignore:end -->`. The
  generator's `read()` strips those blocks from every source it loads, so a
  README stays one file instead of forking into a repo version and a site
  version. The root README's link TO the site is the reason this exists: on the
  site it would be a self-reference. Works in any README, not just the root.

## Native AppKit overlap guidance

This section is only about WHEN to reach for a `dbx-tools` package instead of the
native one, not about how to author one.

Use native AppKit first when it already provides the needed surface. AppKit has
first-party plugins and UI for Analytics, Genie, Files, Lakebase, Model Serving,
Jobs, beta AI Search, beta Agents, AppKit UI primitives, and standard plugin
lifecycle behavior.

AppKit's public `WorkspaceClient` is the SDK migration seam. In the installed
0.60 surface it still delegates every service to
`@databricks/sdk-experimental`; it is not a completed modular-SDK migration.
Use `WorkspaceClient` / `createWorkspaceClient` and
`toLegacyWorkspaceClient()` at compatibility handoffs. Direct experimental-SDK
imports are ratcheted to `node/appkit/src/databricks.ts` (cancellation),
`node/search/src/client.ts` (Vector Search lifecycle), and
`cli/model-proxy/src/backend.ts` (explicit profile support). The Genie
declaration is also the synth-time input for `shared/genie/src/dashboards.ts`.
Do not add another direct import, and do not replace generated Genie Zod schemas
with hand-maintained copies unless AppKit publishes browser-safe runtime schemas.

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
  conversations at once, switch freely, cancel any one), a mid-turn STEERING
  QUEUE (submit while running to enqueue; queue drains oldest-first, or send any
  item now to interrupt), and a PLACEABLE conversation surface
  (`threadPlacement`: `left`/`right` dock, `top` editor-style tabs, `disabled`,
  or `auto` choosing from the chat's own measured width). Native AppKit UI is
  enough for general components or native Genie/Serving hooks.
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
  tools that know `OPENAI_BASE_URL` but not AppKit. Ships no bin - it is the
  `dbx model-proxy` command group of the single `dbx` CLI (`@dbx-tools/cli`).
- `@dbx-tools/ui-appkit`: use as a stable foundation/re-export for dbx-tools UI
  packages and hosts, not as a replacement for `@databricks/appkit-ui` in simple
  app code.
- `@dbx-tools/ui-branding`: use to theme dbx-tools/AppKit UI to a brand — a
  `BrandProvider`/`BrandIcon`/`BrandLogo` React surface plus the
  `[data-brand]` token bridge that re-skins AppKit's semantic tokens from a
  portable `BrandContext`. Inert until a brand is applied, so it never gets in
  the way of default AppKit. Not a replacement for AppKit's own theming when the
  default palette is fine.
- `@dbx-tools/shared-email-template`: use when server and browser code need the
  same email presentation. It owns the React Email document/body components,
  email-safe brand projection, and dbx-tools-branded default. Keep transport,
  SMTP, and AppKit behavior in `@dbx-tools/email`; keep wire schemas in
  `@dbx-tools/shared-email`. This is the ONE package that authors `.tsx` outside a
  `ui` tag, which is why `jsx` is in the shared compiler floor rather than on the
  React tags (see the tag section) — `cli-tunnel` consumes it transitively and
  authors no JSX of its own. `node/email`'s `brand`/`emailHtml`/`markdown` modules
  are thin adapters over this package, not a second implementation; React Email
  does its own style inlining, so there is no separate CSS inliner (`juice` was
  removed when this was extracted).
- `@dbx-tools/appkit-web-search`: AppKit has no first-party web-search or
  page-fetch surface, so use this whenever an agent must look things up on the
  open web or read a user-supplied URL — with a policy layer (URL allow-list +
  optional per-tool approval) controlling which sites are reachable and which
  calls pause for a human. `web_search` uses the Databricks NATIVE web-search
  tool and resolves its own web-capable model (so an agent on a non-web model
  still searches); `web_fetch` uses got-scraping. Same add-on shape as
  node-email (Mastra tool pair + AppKit plugin priming a shared runtime).
- `@dbx-tools/search`: use native AppKit `aiSearch` for Vector Search queries.
  This package adds the surfaces AppKit does not ship: `search` /
  `universal_search` agent tools, cross-index fan-out, index creation/sync/seed
  helpers, `SearchBox` / `SearchResults`, and `lakebaseAiSearch`, a PostgreSQL
  full-text provider with the same aliases, routes, client config, response
  shape, and `useAiSearchQuery` compatibility. Register native `aiSearch` OR
  `lakebaseAiSearch` as the provider, then register `search` for extension
  tools. Do not restore a second Vector Search query client in the extension
  plugin.
- `@dbx-tools/postgres`: use for connection-correct Postgres utilities shared
  across packages. Advisory locks belong to a dedicated connection, so callers
  must not reproduce them with separate `pool.query()` calls. Explicit bigint
  keys are preserved for interoperability; structured keys are reduced to a
  stable signed 64-bit identifier through `object.toStableKey`, which also derives
  the bus's channel name - one identity rule, not two. `PostgresTopicBus` reserves one connection
  for `LISTEN`, filters notifications by topic, and broadcasts JSON payloads
  through `pg_notify` so every app instance receives the event. The envelope is
  fixed (`type` / `metadata` / `body` plus a generated `id`, `topic`, and
  `publishedAt`), automatic machine/deployment context is merged UNDER caller
  metadata, and a body that would not survive a JSON round trip unchanged is a
  `TypeError` at the call rather than a coerced value at the listener. Delivery is
  live and unstored — a dropped listener reconnects with bounded backoff but
  misses whatever was published during the gap, so reach for a table or a queue
  when a subscriber needs replay. `@databricks/appkit` is an OPTIONAL peer used
  lazily for sender identity; do not make it a hard dependency.
  Both `channel` and the advisory-lock key take one value OR an array of parts, and
  neither needs to be identifier-shaped - the package sanitizes and hashes. Do not
  add a caller-side slugifier for either.
- `@dbx-tools/auth`: use the Databricks Apps front door and AppKit identity
  context when requests arrive through the platform. Use this package when a
  public tunnel or another route bypasses that identity-aware proxy and needs
  Better Auth email OTP recovery plus passkeys. The resulting session proves
  the configured identity only and never invents a Databricks OBO token.
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

## When a package earns its own boundary

The reason to split is to keep DEPENDENCIES out of a consumer's install, and
secondarily to keep the accidental API surface small. It is not modularity for its
own sake, and a package that adds a hop without either benefit should be merged
back. Before adding one, name the dependency it isolates.

Splits that ARE earning their keep, so leave them alone:

- The `shared` (agnostic) / `ui` (browser) / `node` (server) tag split. This is
  intentional and enforced by each tag's tsconfig `lib`/`types`. A browser bundle
  importing a `shared-*` contract must not be able to reach Node APIs.
- `node/path` (isolates chokidar/glob/minimatch), `node/databricks-zerobus`
  (isolates the Zerobus SDK), every `shared-*` consumed by a `ui-*`.
- `shared-core`, which is a blanket dependency of every package and so must stay
  light - adding a dependency to it adds it everywhere.

What does NOT justify a package: being a different KIND of thing (generated vs
hand-written - the barrel generator and codegen both handle mixed packages fine),
or being conceptually separable while having exactly one consumer and no
dependency of its own to isolate. `shared-sdk-model` was both and is now
`shared/genie/src/dashboards.ts`.

### The single-consumer packages, already audited

Every package with exactly ONE internal consumer has been checked against the
rule above; the verdicts are recorded here so the audit is not re-litigated:

- `node/fs` (only `appkit-mastra`) - KEEP. It is the `LocalFileSystem` +
  OS-path-resolution half of the `shared-fs` contract, and its Node-only
  `node:fs` / `node:os` surface is exactly what a `shared-*` or `ui-*` consumer
  must not be able to reach. The tag split is the boundary here, not the
  consumer count.
- `node/genie` (only `appkit-mastra`) - KEEP. It provides raw snapshot and
  semantic-event streaming over AppKit's public workspace-client facade;
  folding it into `appkit-mastra` would make the Genie driver unusable from a
  non-Mastra backend, which is the documented reason it exists.
- `node/email` (only `cli-tunnel`) - KEEP. Six external deps (SMTP transport
  among them) that `cli-tunnel` genuinely needs, and it is a published add-on
  consumers install directly. Its single INTERNAL consumer understates its use.
- `shared/email-template` (`email` + `ui-email`) - KEEP. Isolates
  `@react-email/components` + `react`, and it is the one package both a server
  and a browser consumer share. Two consumers, and a real dependency.

## Porting a TypeScript package to Python

Read this BEFORE creating anything under `packages/py`. The layout rules live in
the `packages/py/` bullet of the Layout section; this is the procedure and the
judgement calls that keep a port from drifting away from the Node package it
mirrors.

**Start from a real Python consumer.** A port exists because some Python process
needs it — a notebook, a collector, a job. Port the surface that consumer calls
and stop. `packages/py/model` deliberately has no AppKit `CacheManager`, no
Mastra adapter, and no browser-only schema, because nothing on the Python side
asked for them and each one would have pulled a dependency in.

**Mirror the Node PACKAGE boundary, not the file tree.** One Node package becomes
at most one `packages/py/<x>`, and a Node `shared/<x>` + `node/<x>` pair collapses
into that same one. Never promote a Node MODULE to a Python package: if the new
package would have to depend on the port of its own Node package to function, it
belongs inside it. A famous export earns a name (`PostgresTopicBus`), not a
distribution.

**Port the pure functions first, and keep them importable without a client.** The
deterministic half of a Node package (parsing, classification, id derivation,
payload shaping) is what a fixture can pin and what a caller can unit test, so
give it its own module — `classify.py`, `address.py` — with no `WorkspaceClient`
import anywhere in it. The client-touching half goes beside it (`serving.py`,
`engine.py`).

**Type the boundary structurally.** Accept a `typing.Protocol` describing the
methods actually used (`WorkspaceClientLike`, `AsyncEngineLike`) rather than a
concrete SDK or SQLAlchemy class. That is what lets a caller pass a fake in a test
and a Spark executor pass something that never had Databricks auth.

**Keep both spellings of a public name.** Python callers expect
`channel_name`; a reader porting Node code expects `channelName`. Export both
(the snake_case function plus a camelCase alias) and list both in a sorted
`__all__`, exactly as `dbx_tools.postgres` and `dbx_tools.core` already do. The
embedded-Python adapter also maps snake_case exports onto the TypeScript spelling.

**Pin deterministic behavior once through `@dbx-tools/test-polyglot`.** A pure
rule both runtimes implement, such as a lock id, channel name, parsed address, or
model classification, belongs in the TypeScript source-of-truth package's
native test suite, wrapped in `polygotTest` so the SAME callback executes against
TypeScript and embedded Python. Keep language-specific tests only for
language-specific concerns (async lifecycle, context-manager cleanup,
SDK/client transport).
When a contract needs process-isolated environment/cwd/module caches, constructs
cyclic values that cannot cross FFI, or reads private source constants, test it
in the owning package's native suite. A drifted port then fails beside the source
implementation instead of passing two agreeing-with-itself suites. Avoid
changing TypeScript production behavior to accommodate a port; if Python cannot
match cleanly, stop before introducing a cross-runtime divergence.

**Prove it installs the way a consumer installs it.** Every Python package must
stay `pip install`-able by Git `#subdirectory` on its own, so internal
dependencies use the generated `pythonGitDependency` reference and never a
workspace-only path. Check with `uv build --offline --package <name>`.

**Then finish the paperwork.** Add the package to `pythonPackages` in
`.projenrc.ts` and run `bunx projen` (never hand-edit a `pyproject.toml`), write
the package `README.md` in the same shape as its Node counterpart's, add a Layout
bullet in this file, and add a row to the root README's Python Packages table.
If a port later MOVES, the docs above are the ones that go stale first — the
Layout bullet, the workspace table, the notebook and example imports, and the
polyglot `default.json` module mapping.

## Shared utilities - check here before writing a helper

`@dbx-tools/shared-core` is the browser-safe base EVERY package
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
  `JSON.stringify`), `toBoolean`, `optional` (spread a field only when present),
  plus the lazy `Sequence` transforms.
- `object.isSerializableValue` / `SerializableValue` - the ONE definition of "this
  survives a JSON round trip unchanged". Type a serializing boundary (a message
  payload, a cache entry) as `SerializableValue` and validate untrusted input with
  the guard, which narrows rather than throwing. Do not settle for "`stringify`
  did not throw": that SUCCEEDS while changing the value, turning a `Date` into a
  string, `NaN` into `null`, a `Map` into `{}`, and dropping `undefined`.
- `object.toStableKey` - canonical string for deriving a stable IDENTITY from a
  structured value (advisory-lock id, notification channel, cache key). Object key
  order does not matter; types and structure do, so `1` and `"1"` differ and
  `["a","bc"]` differs from `["ab","c"]`. Throws on a cycle, a non-finite number,
  or a function/symbol rather than inventing an identity two callers could
  disagree about. `@dbx-tools/postgres` derives BOTH its lock ids and its channel
  names through it - do not hand-roll a second canonicalizer, and do not reach for
  `JSON.stringify` (key order leaks, `1`/`"1"` collide). `hash.fnvHash` has its own
  looser canonicalizer that folds every `Date` onto one token; prefer it only when
  a short collision-tolerant digest is enough.
- `object.toNumber` - the ONE place a hand-typed NUMBER is interpreted, and the
  base the other coercions build on. Takes a finite number, a `bigint`, or a
  decimal string with a sign, surrounding whitespace, digit-group separators
  (`"1,000"`, `"1 000"`), a bare fraction, a trailing point, an exponent, or a
  trailing `%` (divided by 100). Returns `undefined` for everything else, so a
  caller stops re-checking `Number`'s output - bare `Number` maps `""`, `null`,
  `[]`, and whitespace to `0`. Do not write another `/^-?\d+(\.\d+)?$/` +
  `Number()` pair: the ones this replaced each accepted a different subset.
  `ToNumberOptions` turns off the two string leniencies (`separators`, `percent`)
  where the other characters carry meaning - a SQL cell, an epoch, a date whose
  spaces separate fields.
- `object.toDate` / `object.toDuration` - the ONE place hand-typed dates and
  durations are interpreted, both built on `toNumber`. `toDate` takes a `Date`, a
  date/ISO string, epoch seconds OR millis (inferred; `Date.parse("1785697899")`
  would read that as a YEAR), or `now`. `toDuration` takes `1h30m` /
  `2 milliseconds` / `-7d`, lenient about whitespace, case, plurals, and
  abbreviations. Both return `undefined` rather than throwing, like `toBoolean`.
  Do not hand-roll a `1e11` seconds-vs-millis check or a `(\d+)(ms|s|m|h)` regex
  in a package - `cli-tunnel`'s `--session-cutoff` is the reference consumer.

  They are also INVERSES, each falling back to the other: a duration reaching
  `toDate` resolves against now (`-30d`, `7 days ago`), and a date reaching
  `toDuration` becomes the signed offset from now (`date - now`, so past is
  negative). Each recurses with the other's parser off, so they cannot bounce a
  value forever, and each tries its OWN reading first - `toDate` runs
  `Date.parse` before the duration fallback, so a real date is never mistaken for
  an offset. `ToDateOptions.parseDuration` / `ToDurationOptions.parseDate`
  (default `true`) turn the fallback off where only one reading is valid: a
  stored timestamp must not resolve against the current clock, and a timeout must
  not accept a date.

- `pattern` - `toPatternMatcher` / `toPattern` / `escapeRegExp`: a config
  allow-list of literals, shell globs, and `/regex/` literals compiled to one
  predicate. EVERY configurable allow-list in this repo takes those three shapes
  (email senders, tunnel forwardable headers, ...), so do not hand-roll another
  `globToRegExp` or `/pattern/flags` parser. For a filesystem or URL PATH, where
  `/` is a segment boundary and `**` matters, use `@dbx-tools/path`'s
  `match.toPathMatcher` instead.
- `async` - `sleep`, `tieAbortSignal`, `poll`. Do not import
  `node:timers/promises` for a delay.
- `@dbx-tools/core` `config` - Node configuration through constant data,
  process env, environment-specific `.env` files, the single Databricks bundle
  App's `config.env`, then `app.yaml` / `app.yml` env values. Root bundle
  variables are authoring inputs, not a config source. Core resolves bundle
  `value_from` and App YAML `valueFrom` references from named resources.
  `scope` and `prefix` compose names in that order; `text` /
  `string` / `boolean` / `positiveInt` / `list` share one coercion and
  precedence policy. Keep configuration out of browser-safe shared-core.
- `error` (`toError` / `errorMessage` / `errorContext`), `log.logger`,
  `hash.id` (id generation - no `nanoid`), `net.urlBuilder`,
  `http.createFetchError`, `function.memoize`, `predicate`, `token`.
- `functionModule.memoize` caches ONE value and shares an in-flight promise
  between callers in the same runtime. To serialize whole callbacks across
  worker threads, use `@dbx-tools/core`'s `processLock.withProcessLock`.
- Do not add a global cwd/origin-aware `context` cache. Parsed config records use
  `file.cachedRecord` with a key containing every source input (dotenv path;
  bundle path + profile; app YAML path); every result caches, including empty records and
  `undefined`. Config-file discovery likewise caches both found paths and misses,
  so each source key is attempted once. Separately, `project.ts` subprocess probes
  share one LOCAL map keyed by command + arguments and store the complete
  `ProjectContext`, including unsuccessful/empty results.
  Blank, null, omitted, and an explicit path equal to `process.cwd()` may hit or
  populate that command map; another directory executes without populating it.
- `token` also owns the front-door header NAMES - `ACCESS_TOKEN_HEADER`,
  `USER_ID_HEADER`, `USER_EMAIL_HEADER`. Never spell `"x-forwarded-access-token"`
  in a package: several places branch on it (`@dbx-tools/appkit`'s `identity`
  decides whether OBO is possible by its presence, `@dbx-tools/tunnel` must
  strip inbound copies), and a stale second spelling is a silent auth bug.
- Every token or credential refresh THIS repo owns must use
  check-lock-check-load: read a still-fresh cached value before locking, acquire
  a process-local lock, re-check because another caller may have refreshed, then
  perform the slow load once. Use a file or distributed lock only when the
  refreshed value also lives in state every process can re-read; a file lock
  around a memory-only token merely serializes duplicate refreshes. Keep
  TypeScript `@dbx-tools/model` authentication caller-owned: `authHeaders()`
  delegates directly to the SDK, and its caller owns any broader refresh gate.

Node-only equivalents live in `@dbx-tools/core` (`bin.ensure` for idempotent
executable downloads, archive selection, version validation, and atomic install;
`exec.spawn`/`spawnSync`; `project.root`/`name`/`repositoryUrl`/`npmRegistry`;
`processLock.withProcessLock` for keyed mutual exclusion across the main thread
and its workers - a module-level promise chain only serializes ONE thread, and
reach for `@dbx-tools/postgres`'s `withAdvisoryLock` when the scope is a
deployment rather than a process) and `@dbx-tools/path`
(`find.findFiles`, `watch.watchFiles`, `match.toPathMatcher`,
`ignore.ignorePatterns`). The projen
engine uses these too - it must not re-probe `npm prefix` / `git rev-parse` on
its own.

Cross-package contracts that are easy to duplicate by accident:

- `@dbx-tools/shared-model` `openaiResponses.REASONING_TYPES` - the Claude
  extended-thinking block types. Both wire sanitizers (Responses and Chat
  Completions) MUST strip the same set; Anthropic signs these blocks, so a
  replay that mutates one is rejected.
- Anthropic's "assistant message prefill" rule needs a repair on BOTH wire
  surfaces, because Databricks rejects any transcript ending on an assistant
  turn: `openaiResponses.repairTrailingAssistantInput` (Responses `input`, used
  by the model proxy) and `appkit-mastra`'s `repairAssistantPrefill` (Chat
  Completions `messages`). Order matters - the reasoning strip CREATES the
  offending shape when a turn ended on a `reasoning` item, so the prefill repair
  runs after it. Neither may touch a trailing `function_call` / `tool_calls`
  turn: an unanswered tool call fails a DIFFERENT provider rule, and dropping it
  would discard a call the client is about to answer.
- `@dbx-tools/model` `invoke.*_PATH` / `*Url` - the Databricks serving paths
  (`invocations`, `responses`, `open-responses`, `chat/completions`). Never
  hard-code a `/serving-endpoints/...` string in a consumer.

Python has the same reuse rule, with a deliberately smaller dependency-free
base in `dbx_tools.core`. Before copying a TypeScript identity algorithm into a
Python package, check these first:

- `dbx_tools.core.hash.fnv_hash` - FNV-1a hashing compatible with the subset of
  `shared-core` used by Python packages;
- `dbx_tools.core.object.to_stable_key` - strict structured identity
  canonicalization;
- `dbx_tools.core.string.to_identifier` - readable identifier tokenization.

Only port the helper subset needed by multiple Python packages; do not mirror
all of shared-core speculatively. When moving duplicated Python helper code into
`packages/py/core`, move its unit tests into `packages/py/core/tests` in the same
change. When a contract must remain identical across languages, add one
`polygotTest` callback to the owning TypeScript package and delete equivalent
Python assertions. The private `@dbx-tools/test-polyglot` package owns the
embedded-Python adapter and is added only as a TEST dependency. Process-isolated
configuration, cyclic values, and private constants belong in native tests under
the owning package rather than a central fixture runner. Include parity cases
when both runtimes independently encode protocol limits, wire names, retry
bounds, or other compatibility-sensitive values.

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
- `ui/mastra` `src/support/thread-labels.ts` - `threadTitle` / `relativeTime`,
  shared by `ThreadSidebar` and `ThreadTabs` so a conversation row and a tab
  never disagree about how an untitled thread reads.

When a helper is worth sharing, add it to the module map in the owning package's
README as well; the docs site is generated from those READMEs, so an undocumented
utility is an invisible one.

## Formatting and diff hygiene

Python package metadata is synthesized from the Python section in `.projenrc.ts`.
Do not hand-edit the root or `packages/py/*/pyproject.toml` files. Run `bunx
projen`, then `uv sync --all-packages`. Use `uv run pytest`, `uv run ruff check
packages/py`, and `uv run ruff format packages/py` for Python validation and
formatting. `uv.lock` and `bun.lock` are local install artifacts and must remain
untracked; `.venv/`, Python caches, and built wheels are ignored too.

`bun run format` is `prettier . --write` over the WHOLE repo, and `.prettierignore`
does not exclude `packages/js/`. Some committed files predate the current
`printWidth: 100` and were never reformatted, so a repo-wide run rewraps them and
churns dozens of lines that have nothing to do with your change.

**Formatting is a FINAL step, not an iteration step.** Do not run prettier after
every edit. Save it for the moment work is being wrapped up: right before a
commit that is about to be pushed, before a version bump/release, or when the
user asks to finalize. While iterating (editing, compiling, running tests), leave
formatting alone — a reformat mid-task inflates the diff, invalidates the review
you already did, and hides the behavior change you are actually making.

When that final step arrives, prefer
`bunx prettier --write <the files you edited>`. Run the repo-wide `format`
task only when reformatting the repo IS the change. Either way, check
`git status` / `git diff --stat` before finishing and revert files you did not
mean to touch, so a behavior change is not buried in reflowed whitespace.

Lint is `bun run eslint` (root `.eslintrc.json`, ESLint 8 / `eslintrc` mode, run
over `packages/js`). It autofixes, so it can reformat too — same timing rule applies:
run it when finishing up, not between edits.

## Comments describe the code, not the changes to it

A comment is read by someone looking at the CURRENT code, who has no idea what it
looked like before. Git history already records what changed, so a comment that
narrates a refactor is noise that ages into a lie. Write every comment as a
description of how the code behaves NOW and why it is shaped that way.

Do not write, in code or docstrings:

- "replaces the old X", "this is the in-process replacement for Y", "X is gone now";
- "used to be its own package", "was previously spelled out in both", "before this
  module the fallback was ...";
- "the regression this pins", "this fixes ...", "the bug was ...";
- "now a member of the workspace", "is now the manifest name" — the "now" is only
  meaningful against a past the reader cannot see;
- section headers naming a migration (`Demo app (merged from the former ...)`).

The RATIONALE those comments were carrying is usually worth keeping — rewrite it in
the present tense as a constraint on the current design. A hard-won failure mode
stays valuable when phrased as what WOULD happen, because that is what stops the
next person undoing it:

- instead of "the ignore used to be a blanket `<pkg>/src/**`, which broke linting",
  write "the ignore must name the generated MODULE, not a blanket `<pkg>/src/**`: a
  codegen package is not entirely generated, and a blanket ignore silently stops
  linting the hand-written modules beside it";
- instead of "before this module the key was per-process, so restarts logged
  everyone out", write "the key must OUTLIVE the process: a per-process key would
  invalidate every outstanding cookie on restart".

Naming a superseded tool is fine when the tool is still a live consideration
(`@types/bun` supplies these globals, not `vite/client`), and "legacy"/"deprecated"
are fine when they describe something the code STILL supports today — a deprecated
env-var alias it still reads, a legacy transport it still serves. The test is
whether the sentence is about the code as it stands or about the act of changing it.

## Vocabulary (important)

- **tag** — a label a package carries (Bit-style; it names the target
  _environment_ — React/Bun, Node, agnostic, …). A package can carry MANY tags,
  or none. Tags are NOT npm scopes. They come from three sources, unioned and
  deduped: (1) tags already on a project you attached yourself, (2) matches in
  `packageTagPaths`, (3) the cumulative dash-join of the folder's path
  segments relative to its root (`ui/app` → `[ui, ui-app]`).
- **scope** — reserved for the npm `@scope/` in package identifiers (e.g. the
  `@dbx-tools` in `@dbx-tools/ui-app`). Don't call tags "scopes".
- **package** — a `src`-bearing folder under a `packageRoots`
  root (e.g. `packages/js/ui/app`), named `@<scope>/<path-dash-joined>`.

## Mental model

- **`new DBXToolsNodeProject(options?)` gives you a configured monorepo root**
  (`project.ts`). It extends projen's `NodeProject`, merging its opinionated
  defaults (`defaultNodeProjectOptions`/`defaultTypeScriptProjectOptions`, root-aware
  functions keyed off `options.parent`: bun, no jest/eslint/github/release/depsUpgrade;
  projen's built-in prettier runs on the ROOT only)
  under anything you pass. You then call
  `project.synth()` yourself. A normal consuming `.projenrc.ts` is two lines:
  `const project = new DBXToolsNodeProject(); project.synth();`. The barrel
  exposes the class BOTH flat and under its module namespace
  (`projenProject.DBXToolsNodeProject`), so either import works; the namespace form
  is what in-repo code and `projen/README.md` use, and is the only one older
  published engines understand. Both classes
  share `DBXToolsCommonOptions` (`scope`, `packageRoots`,
  `packageTagPaths`, `defaultTagMixins`), which
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
- **`pnpm-workspace.yaml` is GENERATED and committed but ONLY for the Databricks Apps
  deploy path.** The engine writes it directly (projen skips its native component
  under bun) and it exists so the platform's pnpm build phase reads `packages` +
  `catalog` + `allowBuilds` from it. The same catalog + members + build-allowances
  are mirrored into the root `package.json` (`workspaces`/`catalog`/`trustedDependencies`)
  for bun. A `catalog:` specifier resolves under BOTH managers.
  What the engine supplies is the OPTIONS object it renders, via
  `pnpmOptions.workspaceYamlOptions`; `PnpmWorkspaceState` (`pnpm-workspace.ts`)
  holds that object and is exposed as the root's `project.pnpmWorkspace` field.
  The root scans the filesystem ONCE at synth (under each `packageRoots`
  root, default `["packages"]`) and the file's `packages:` list is filled from
  `project.subprojects` in the root's `preSynthesize` (so member order/timing
  never matters) — every discovered package becomes a real subproject, no manual
  member list. Mutate it through the typed methods
  `project.pnpmWorkspace?.addCatalog(name, version)` / `.allowBuild(name)` /
  `.addOverride(name, version)` (a pnpm `overrides` pin, unrelated to projen's
  `FileBase.addOverride`; `overrides` is seeded empty in the constructor so the
  mutator has the reference projen captured, and `omitEmpty` drops the key while
  it stays empty) — or,
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
  task instead of surfacing as a confusing type error). Discovery is TWO functions in `packages.ts`:
  `scanPackages(root, roots)` walks the filesystem (synth time; returns each
  package's path + the tags implied by its path, reading no manifest), while
  `recordedPackages()` reads the recorded members back from `pnpm-workspace.yaml`
  and augments each with the `name` + `tags` from its own `package.json` — what
  every post-synth command (`barrels`, the watcher, `openapi`) uses.
- **Discovery + tag resolution.** Under each `packageRoots` root (this
  repo passes `["packages/js", "packages/example"]`), ANY `src`-bearing folder at
  ANY depth is a package. Its path relative to the root is decomposed into
  cumulative dash-join **tag candidates**: `ui/app` → `[ui, ui-app]`;
  `dir/another/path` → `[dir, dir-another, dir-another-path]`. Each candidate is
  looked up in **`packageTagPaths`** (`Record<token, string[]>`,
  default: identity over the tag names) and the union of matches — together with
  any tags already on a pre-attached project — is the package's applied tags,
  possibly NONE (then only the agnostic default applies). The deduped tag list is
  written to each package's `package.json` under **`dbxToolsConfig.tags`** (the
  per-package source of truth, surfaced post-synth as `recordedPackages()[].tags`)
  and read back via the `DBXToolsConfig` component (`pkg.dbxToolsConfig.tags`, the
  basis an `applyToProjects({ tags })` selection dispatches on). No declaration
  needed: drop a `src/` folder, re-synth.
- **A root may already hold in-tree subprojects.** If a discovered folder matches
  a subproject already attached to the root, it is NOT re-created — the resolved
  tags are pushed onto its `dbxToolsConfig.tags` (deduped at synth). The root
  itself can also carry tags (a `""`/`"."`
  key in `packageTagPaths`, or the `tags` option).
- **Every package is a `DBXToolsTypeScriptProject`** (extends
  `typescript.TypeScriptProject`). The root's scan constructs one per discovered
  folder with `parent: root`; you can also `new DBXToolsTypeScriptProject({parent,
...})` directly to attach a package WITHOUT auto-discovery. Every package gets
  the agnostic tsconfig floor (`AGNOSTIC_COMPILER_OPTIONS`: ES2022, no DOM/node) at
  construction; the class then points `main`/`types`/`exports` at the package-root
  `index.ts` barrel, applies any explicit `tasks`, optionally emits
  `dev.ts`/`build.ts` (for `app` tag) or `bunfig.toml`, and locks `package.json`.
  Per-tag deps/tsconfig/tasks are layered afterward by the tag MIXINS the root
  applies (see below).
  projen OWNS that package's `package.json`/`tsconfig.json`/tasks/`README.md`/
  `.projen/`; baseline projen features are off to match the root (`SUBPROJECT_
DEFAULTS`; `sampleCode: false` stops projen dropping template `src/` files).
- **Tags are ONE map of mixins.** `tags.ts` — `PACKAGE_TAG_MIXINS`
  (`Record<PackageTag, IMixin>`, keyed by tag name). Each entry is a
  `tagMixin(name, fn)` that, for every package carrying the tag, adds the tag's
  projen-native `deps`/`devDeps` (`@catalog:` specifiers) and OVERRIDES the
  generated tsconfig via `applyCompilerOptions` (projen enums, e.g.
  `TypeScriptModuleResolution.BUNDLER`) — layered over the
  `AGNOSTIC_COMPILER_OPTIONS` floor so tag `lib`/`types`/`target` win. Some also
  `applyTasks` / emit dev/build toolchain:
  - `app` → Bun app (DOM + `@types/bun`, `dev.ts` + `build.ts` + `bunfig.toml` for Bun.serve dev + Bun.build, Tailwind via bun-plugin-tailwind)
  - `ui` → React component library (DOM + React types, no bundler)
  - `server` → Node (`@types/node`, `tsoa` + `experimentalDecorators`, no DOM)
  - `node` → Node (`@types/node`, no DOM)
  - `cli` → Node + `commander` + `@clack/prompts` (no `tsx`: the published bin is
    the compiled `lib/bin/<name>.js`, see Gotchas); `index.ts`/`bin/**/*.ts`
    tsconfig includes, since a CLI compiles code outside `src/`; and a DERIVED
    `exports` map (`.`, a `./<module>` subpath per top-level `src` module,
    `./package.json`). A CLI should need no per-package tsconfig or exports
    config.
  - `shared` → agnostic (the `AGNOSTIC_COMPILER_OPTIONS` floor: no DOM, no Node)
  - `openapi` → generated, read-only clients (`openapi-fetch`, DOM libs)
    Enforcement is real via each package's generated `tsconfig` `lib`/`types`:
    `document` in `shared`/`server` fails `tsc`; `process`/`node:*` in `ui` fails.

  **`jsx` is NOT a tag concern** — it is in `SHARED_COMPILER_OPTIONS`
  (`project.ts`), the floor EVERY package gets, alongside the `src/**/*.tsx`
  include added in the constructor. Do not "tidy" it back onto the React tags.
  Packages resolve each other to SOURCE (`main: index.ts`), so a consumer
  type-checks its dependency's files under its OWN tsconfig: the moment any
  package re-exports a `.tsx` module, every package that imports it — however far
  down the graph, whatever its tag — fails with `TS6142: ... but '--jsx' is not
set`. That is exactly what happened when `shared/email-template` was extracted:
  `cli-tunnel` (a `cli` package that authors no JSX) stopped compiling. Setting
  `jsx` on the consumer is the wrong fix — it cannot know a transitive dependency
  started shipping JSX. The option is inert without JSX in the graph: it selects
  how JSX syntax COMPILES and adds no lib, no global, and no type dependency, so
  the agnostic/node floor stays honest. Pinned by `projen/test/tsconfig-jsx.test.ts`.

- **Per-package behavior is MIXINS** (`mixin.ts`; `constructs` `IMixin`). A mixin
  is `{ supports(c), applyTo(c) }`, applied with the constructs-native
  `construct.with(...mixins)` — it runs each across the construct's whole subtree
  (tree captured at call time), so a root-level `root.with(...)` reaches every
  matching child. Package predicates live in `project-predicate.ts` (exported as
  the `projectPredicate` namespace), as plain callable
  `@dbx-tools/shared-core` predicates (narrowing a construct):
  `projectPredicate.hasIdentifierName("shared-core", ...)` (unscoped npm name glob via
  `match.toPathMatcher`, `→ Project`), `projectPredicate.hasTag(tag, ...tags)` (all tags
  required, `→ DBXToolsProject`), and `projectPredicate.hasPath("packages/js/**", ...)`
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
    `dbxToolsConfig`. The root applies the built-in tag mixins (**`PACKAGE_TAG_MIXINS`**,
    `tags.ts`) during its own construction, selected by the `defaultTagMixins` option
    (omit = all, `false` = none, or a subset list) - e.g. the `server` mixin adds
    `express`/`tsoa` + `dev`/`start` tasks. Consumers apply their own AFTER
    construction with `applyToProjects(...)` (see `.projenrc.ts`), so user mixins run
    after the defaults.
- **Names**: `PackageIdentifier.of(scope, relPath)`
  (`project.ts`): normalized, lowercased, the root-relative path dash-joined as
  `@<scope>/<seg-seg-...>` (e.g. `packages/js/shared/core` → `@dbx-tools/shared-core`,
  `packages/js/cli/dbx-tools` → `@dbx-tools/cli-dbx-tools`). The `scope` option
  defaults to the resolved project `name`; the `name` option, if omitted, is
  auto-detected (git remote → folder name). This repo passes `scope: "dbx-tools"`,
  giving `@dbx-tools/*` packages. The engine keeps its derived name UNLESS
  overridden — which it is, to the clean `@dbx-tools/cli` (see Gotchas).

## Layout

```
.projenrc.ts                              # new DBXToolsNodeProject({...}) + user mixins + the dbx-tools root task
packages/js/
  cli/dbx-tools/                          # the ONLY bin (`@dbx-tools/cli`, `dbx` + `dbx-tools`)
    bin/dbx-tools.ts                      # commander entry: dev | model-proxy | appkit
    index.ts                              # generated barrel (public API surface)
    src/
      bootstrap.ts                        # bootstraps a COMPLETELY EMPTY folder (see Commands)
      cli.ts, bun.ts, root.ts             # CLI runtime helpers (bin/bun resolution, root init)
  openapi/<name>/                        # generated from tsoa controllers, same root as the source
projen/                                   # the projen engine (`@dbx-tools/projen`), a workspace member via extraWorkspaceMembers
  index.ts                                # generated barrel (public API surface)
  src/
    project.ts                            # DBXToolsProject + DBXToolsNode/TypeScriptProject + PackageIdentifier/naming, applyToProjects, applyCompilerOptions/applyTasks, SHARED_COMPILER_OPTIONS, root init
    project-predicate.ts                  # projectPredicate namespace (isProject/isDBXToolsProject/hasName/hasIdentifierPackageName/hasIdentifierScope/hasIdentifierName/hasTag/hasPath, .and/.or/.negate)
    mixin.ts                              # mixin.create() factory (tag table lives in tags.ts)
    pnpm-workspace.ts                     # PnpmWorkspaceState (options for projen's native PnpmWorkspaceYaml) + Catalog/DEFAULT_CATALOG + AllowBuilds/DEFAULT_ALLOW_BUILDS + DEFAULT_WORKSPACE_YAML
    tags.ts                               # PACKAGE_TAG_MIXINS (one IMixin per tag) + AGNOSTIC_COMPILER_OPTIONS
    packages.ts                          # discovery: scanPackages (fs) + recordedPackages (pnpm-yaml + manifest)
    barrels.ts                            # barrel generator (root index.ts, header + read-only)
    codegen.ts, module-exports.ts         # ts-to-zod codegen + exports-map generation
    watch.ts                              # generic file-watch util (watchLoop + watchRoots) the sync --watch task watchers forward to
    scaffold.ts                           # runSynth({ post })
    release.ts                            # DBXToolsRelease: bump task + tag-driven publish workflow
    publish.ts                            # compiled publish surface: publishConfig + rootDir/prepack wiring (publishesCompiled excludes `ui`)
    openapi.ts                            # openapi generator (tsoa controllers -> spec + client)
    clean.ts, generated.ts, tsconfig.ts, bun-app.ts, vscode.ts, engine-root.ts, dbx-tools-config.ts
  tasks/                                  # projen task scripts (bump, sync, barrels, openapi, projenrc, clean, emit)
packages/example/
  cli/main/ server/api/ shared/core/ shared/fun/ shared/neat/ app/appkit/   # seed examples, each a real subproject
```

## Package manager: bun (with pnpm-workspace.yaml kept for Databricks)

**bun owns install/run/build/test locally and in CI.** The engine sets
`packageManager: BUN`, so projen renders `bun install` / `bunx projen` / `bun test`
and a native `trustedDependencies` field. The single bun workspace has ONE
`node_modules`, no `.pnpmfile.cjs`, and `workspace:*` sibling deps resolve from
source with no linking hook.

Keep `scripts/install.sh` as a small function-based bootstrap. It uses an
existing Bun first; when Bun is absent it uses a working Node package manager,
installing Node LTS through NVM only when neither Bun nor a usable Node
environment exists, then prefers `pnpm add -g bun` and falls back to
`npm install -g bun`. Let NVM's official installer own shell-profile setup; do
not reproduce or prune its installation and do not depend on mise.

The custom root applies `ROOT_INSTALL_ONLY_MIXIN` during every pre-synth by
default (`rootInstallOnly: true`). It clears child `install` / `install:ci` task
steps, so child `NodePackage.postSynthesize()` hooks cannot run the same
workspace install once per package; only the root performs `bun install`.
`rootInstallOnly: false` restores projen's native per-project behavior. Apply the
mixin in pre-synth rather than only at construction so packages attached later
are covered too.

**`pnpm-workspace.yaml` is STILL generated and committed** - the engine writes it
directly (projen skips its native component under bun). It is not used for local
installs; it exists for the **Databricks Apps deploy path**, whose build phase
installs with pnpm and reads `packages` + `catalog` + `allowBuilds` from it (see
`research/running-bun-on-databricks-apps.md`). The same catalog + members +
build-allowances are mirrored into the root `package.json`
(`workspaces`/`catalog`/`trustedDependencies`) for bun. A `catalog:` specifier
resolves under BOTH managers, so package deps are written once.

**The root `bunfig.toml` pins `linker = "hoisted"` and is MANDATORY.** bun's
default (isolated) linker instantiates a peer dependency once per peer context, so
a package with many peers (`@mastra/*`) gets two peer-hash variants of the same
`@mastra/core` version and TypeScript rejects passing a value built against one to
an API typed by the other. Hoisted de-dupes to a single flat copy - the coherence
the old cross-workspace `.pnpmfile.cjs` bridge used to provide. Do not remove it.

The Mastra catalogue entries in `.projenrc.ts` are exact versions, not caret
ranges. Keep the server packages, `@mastra/core`, and `@mastra/client-js` on the
tested coherent set. A fresh unlocked install once floated the client to 1.37
and core to 1.56; the browser client then imported core's Node-only rolldown
runtime (`import "module"`), and the demo's browser build failed. Upgrade the
Mastra set together and prove the demo browser build before moving any pin.

## Migrating an existing workspace from pnpm to bun

A workspace generated by a **pre-bun engine** (packageManager pnpm, `tsx`
runner, Vite for `app` packages, a `.pnpmfile.cjs` link hook) upgrades to the
bun engine by bumping the engine dep and re-synthing - projen rewrites the
toolchain. The engine change is not self-applying, so drive it in this order and
delete the artifacts projen no longer owns (it emits files, it does not remove
files it stopped emitting).

1. **Install bun** (`curl -fsSL https://bun.sh/install | bash`) - the toolchain,
   CI, and the `dbx-tools` bootstrap all assume it on PATH.
2. **Raise the engine dep** in the workspace's `.projenrc.ts` / root
   `package.json` to a bun-era `@dbx-tools/projen` (>= the first release whose
   engine sets `packageManager: BUN`; when in doubt use the CLI's own version -
   they are cut together). `.projenrc.ts` importing the engine by source path in
   THIS repo is the exception; a downstream workspace consumes it from the
   registry.
3. **Re-synth with bun**: `bunx projen` (or `bun run sync`). This flips the
   generated manifests to `bun install`/`bunx`/`bun test`, drops `tsx` for `bun`
   in the task runner, adds a native `trustedDependencies`, mirrors
   `workspaces`/`catalog` into root `package.json`, and emits the root
   `bunfig.toml` (hoisted linker), plus per-`app` `dev.ts`/`build.ts`/`bunfig.toml`
   in place of the Vite config. It also (re)writes `pnpm-workspace.yaml` for the
   Databricks deploy path - keep that file.
4. **Delete the now-orphaned pnpm/Vite artifacts by hand** - projen won't:
   `.pnpmfile.cjs` (root and any per-workspace copies), `pnpm-lock.yaml`, a
   store-scoped `.npmrc`, and each `app` package's `vite.config.*` /
   `vite.config.override.*`. Drop `tsx`, `vite`, `@vitejs/plugin-react`, and
   `@tailwindcss/vite` from dependency lists in `.projenrc.ts`; add
   `bun-plugin-tailwind` if an `app` package builds Tailwind (the `app` tag wires
   it). Merged monorepos also collapse separate `pnpm-workspace.yaml` /
   `.pnpmfile.cjs` per sub-workspace into the single root pair.
5. **`bun install`** once to write `bun.lock` (git-ignored here; see the lockfile
   note in Gotchas) and lay down the single hoisted `node_modules`.
6. **Verify** with the three-way check: `bunx projen`,
   `bun run --filter '*' compile`, `bun run --filter '*' test`.

What you gain and lose:

- **Gained:** one workspace, one `node_modules`, no link hook - `workspace:*`
  siblings resolve from source. `bun` runs `.ts` directly (no `tsx`), and `app`
  packages use `Bun.serve` (HMR dev) + `Bun.build` (prod).
- **Lost:** consumer-mode testing (`DBX_TOOLS_LINK=0`, registry-installed
  packages) - intentionally dropped. Everything resolves from source now.
- **Unchanged:** package deps keep their `@catalog:` / `workspace:*` specifiers -
  both resolve under bun AND pnpm, so nothing in a package manifest is rewritten
  by the migration. `pnpm-workspace.yaml` stays (Databricks deploy reads it).

Two migration gotchas worth calling out (both bit this repo):

- **CLI bins publish as compiled `.js`, not `.ts`.** Older assumptions that a
  consumer's runtime type-strips a `.ts` bin are wrong under plain node: a bin is
  invoked by name -> the `node`-shebang shim -> node, which cannot run `.ts`
  (ERR_UNKNOWN_FILE_EXTENSION). The engine compiles bins to `lib/bin/*.js` and the
  publish task folds `publishConfig` onto the manifest so the tarball's `bin`
  points there. If you author a bin, let it ship compiled - don't invoke the
  `.ts` bin name in a Databricks `app.yaml` command.
- **On Databricks Apps, pnpm still installs; bun only runs.** The deploy path is
  unchanged by the migration: the platform's build phase runs `pnpm install`
  (reading `pnpm-workspace.yaml`), and the `app.yaml` command uses `bun` to run
  (`bun src/server.ts`, or a compiled CLI bin). Do not switch the deploy to
  `bun install` - see `research/running-bun-on-databricks-apps.md`.

Migrating a downstream workspace surfaced a further set, written up in
`research/bun-migration-field-notes.md` - read it before doing one. The ones that
cost the most time: bun accepts node's `--env-file-if-exists` and silently loads
NOTHING (use `--env-file`, already missing-file tolerant); `bun --watch build.ts`
does not rebuild when bundler INPUTS change, only when the script's own imports do,
so a `vite build --watch` replacement must watch for itself; bun's bundler does not
copy `public/`; and a Databricks App's `Bun.build` needs `splitting` (the Workspace
import API's 10 MB per-file limit fails the UPLOAD, not the build), `publicPath: "/"`
(the static server rewrites `/*` to one `index.html`, so relative chunk paths 404 on
nested routes), `external` for self-hosted fonts, `sourcemap: "none"`, and a
`process.env.NODE_ENV="production"` define so React ships its production runtime.
The generated `app`-tag `build.ts` supplies those five options by default,
clears `dist/` before each build, and stages an optional `public/` directory after
`Bun.build`; use `bun-build.override.ts` only to replace a default for an app with
different deployment requirements.

That note also recorded an engine bug that is now FIXED, kept here because the
failure is unintuitive: `runSynth()` spawned `process.execPath --import tsx`, but
under bun `process.execPath` IS bun, which cannot load tsx's loader (`Cannot find
module './cjs/index.cjs' from ''`) - so `sync`, `projenrc`, and `openapi` all
failed at the re-synth step. Loading tsx under bun is pointless anyway (bun runs
`.ts` natively), so `runSynth` now branches on `process.versions.bun` and passes
the loader flag only under node. Do not "restore" the flag unconditionally.

## Commands

Everything below the install line is a projen TASK the engine registers on the
root, so run it with `bun run <task>`. The `dbx-tools` CLI is NOT needed here -
see "The `dbx-tools` CLI" for the one case it exists for.

```sh
bun install                  # install the workspace (hoisted; links engine + siblings from source)
bunx projen                  # synth all generated config (+ install + barrels)
bun run sync                 # one-shot full synth through the sync task
bun run sync --watch         # watch while editing (concurrently: projenrc + barrels + openapi watchers)
bun run barrels              # rebuild every package's root index.ts barrel
bun run openapi              # generate the openapi packages from tsoa controllers
bun run clean                # remove generated files (read-only ones); interactive picker, -y to skip
bun run --filter '*' compile # type-check every package (projen's per-package compile: tsc --build)
bun run --filter '*' test    # run every package's node:test suite (via `bun test`)
bun run eslint               # lint (autofix) every package under `packages/js`
bun run format               # prettier over the WHOLE repo - pre-push/pre-bump only; see "Formatting and diff hygiene"
```

A cross-package change is verified by all three of `bunx projen`,
`bun run --filter '*' compile`, and `bun run --filter '*' test`: synth catches a
manifest or barrel that no longer matches the source tree, compile catches a moved
export, and the tests catch behavior.

Run `bun run build` inside one JavaScript package when you want its complete
compile/test/pack lifecycle. The root `build` deliberately has no package fan-out,
and root `bump` bypasses child builds in favor of one filtered compile plus
concurrent `bun publish --ignore-scripts`, so keeping package-local builds useful
does not slow releases. Child `package` uses `npm pack --ignore-scripts` because
the enclosing build already compiled; package `prepack` remains for a standalone
`bun publish`.

Notes on the bun test task: the suites still use `node:test` (bun's `bun test`
runs them with its own fast runner). The generated task is
`find test -name '*.test.ts' | grep -q . && bun test test || true` because
`bun test` exits non-zero when it matches no files - the guard makes a package
with no tests a no-op. bun does NOT support `describe()` nested inside `test()`
(bun issue #5090); keep suites flat.

## Package registries: public npm and PyPI are NOT reachable

This machine has NO route to `registry.npmjs.org` or `pypi.org` - corp blocks
them, permanently. A direct fetch does not even fail fast with a clean error; it
hangs and then returns nothing (`curl` exit 7 / HTTP `000`, and `npm view`
reports a misleading "check your proxy" error). So do NOT read a failed registry
probe as "the publish did not work":

- **Never verify a release by querying public npm from here.** Read the GitHub
  Actions `release` run log instead - the `+ <pkg>@<version>` lines and
  `published N packages @ <version>` are the authoritative confirmation.
  `gh run view <id> --log` works, because GitHub itself IS reachable.
- **Do not "fix" a hanging install** by pointing a tool at the public registry,
  and do not add a registry/index URL to a committed config. What is already
  configured below is correct.

What is configured, and why:

- **npm/bun -> local verdaccio** at `http://localhost:4873/` (`~/.npmrc`), which
  proxies the corp mirror `https://npm-proxy.dev.databricks.com/` as its `corp`
  uplink and caches tarballs on disk. Two reasons it exists: the corp proxy is
  slow enough to hang mid-transfer on large tarballs (its config carries a 180s
  timeout and a wide socket pool for exactly that), and it accepts LOCAL
  publishes (`publish.allow_offline: true`), so a `bun run bump` can be installed
  and tested without waiting on a public release.
- **pip/uv -> local devpi** at `http://localhost:3141/reggie/dev/+simple/`,
  which inherits from the corporate PyPI mirror and supports local uploads. The
  launchd/watchdog setup points pip and uv at devpi only while it is healthy and
  restores the corporate index when it is unavailable.

`bun run bump` publishes the complete release: its `v*` tag triggers the npm,
PyPI, and docs workflows; `--local-registry auto` also publishes npm packages to
loopback Verdaccio, and `--local-pypi auto` publishes Python packages when uv's
default index is a loopback devpi `+simple` URL. A proxpi-style `/index/` cache
is read-only and is not treated as a publish target.

A Databricks notebook or job is a different network with its own package index.
Documentation and notebooks install the published distributions by name
(`dbx-tools-core`, `dbx-tools-postgres`, `dbx-tools-model`, and
`dbx-tools-litellm`). Each Python package README also documents the Git
`#subdirectory=` form as an alternative for testing unreleased `main` branch
changes.

The root `VERSION` file is the single source of truth for the version, and every
generated `packages/py/*/pyproject.toml` carries exactly that `x.y.z` value,
copied at synth alongside its JS siblings. There is no per-commit PEP 440 local
stamp: a commit does not change any version, so the pyproject files stay at the
committed `VERSION` and only `bun run bump` moves the number. See "Versioning"
below for how the number is chosen and propagated.

## Versioning

There is ONE version for the whole repo, and it lives in the root `VERSION` file
(a plain `x.y.z` string; a fresh tree with no file defaults to `0.0.1`). Synth
COPIES that value into every manifest - the root and `projen/` `package.json`,
every JS member, every `packages/py/*/pyproject.toml`, the generated openapi
packages, and the example apps - so the TypeScript packages, the Python packages,
the engine, and the examples always share one number. `projen/src/workspace-version.ts`
owns reading/writing it.

Hard rules, because independent version drift and `0.0.0` resets were a recurring
error source:

- **Synth only copies.** An ordinary `bunx projen` / `bun run sync` reads
  `VERSION` and writes that exact value; it never invents, resets to `0.0.0`,
  upgrades, or downgrades a version. A `VERSION` file that exists but is not valid
  `x.y.z` fails loudly rather than being silently rewritten.
- **`bump` is the only mutator.** Only `bun run bump` changes the number:
  `projen/tasks/bump.ts` computes the next version, writes `VERSION`, then synths
  so every manifest copies it. Nothing else (no publish restore, no lifecycle
  hook, no commit hook) moves a package version.
- **Remote is consulted only on bump and one-time bootstrap.** `bump` runs a
  single `git fetch --tags` and takes the highest tag across `v*` and every
  sibling prefix (e.g. `projen-v*`) as its base, so a release cut elsewhere wins.
  When the remote is unreachable or has no matching tag it falls back to the local
  `VERSION` file. A local file that is ahead does NOT override an existing remote
  tag. Creating a missing `VERSION` file uses the same remote-or-`0.0.1` rule.
- **Publish never regresses the worktree.** `tasks/publish.ts` re-affirms the
  release version and folds in `publishConfig` entry points, then restores each
  manifest to its committed content - which already equals `VERSION` - so a local
  `bun run bump` leaves no stray version changes behind.

## The `dbx` CLI

`@dbx-tools/cli` ships the repo's ONLY bin, `dbx` (aliased `dbx-tools`), with
three command groups: `dev` (workspace lifecycle -> projen), `model-proxy`, and
`appkit`. The latter two live in their own packages
(`@dbx-tools/cli-model-proxy`, `@dbx-tools/cli-appkit-env`) and are mounted as
ARG-FORWARDING commands that `await import()` the sibling's `buildProgram(name)`
only once the name is matched - so `dbx dev` never loads the Databricks SDK or
AppKit. Those packages therefore declare NO bin; adding one back re-splits a
surface a user should only have to install once. Each forwarding command sets
`helpOption(false)` so `--help` reaches the child and the child prints its own
help; `buildProgram` takes the display name (`dbx model-proxy`) so help output
names the real invocation rather than a bin that no longer exists.

`dev` exists for the one thing projen cannot do for itself: a folder with no
`.projenrc.ts` or toolchain installed yet, where there are no tasks to run.
`dbx dev sync` bootstraps that folder and then forwards to projen from then on.
It is an EXPLICIT subcommand, not the bare root action, so a projen task name
can never collide with (or be shadowed by) a sibling command group.

Inside an established workspace the CLI only forwards, so prefer the
`bun run <task>` forms above - do not document `dbx dev barrels` /
`dbx dev openapi` / `dbx dev clean` as the way to run engine tasks.

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
  full re-synth + install. Run it as `bun run sync --watch`.
- **`dbx dev sync` on a completely empty folder bootstraps it** (`bootstrap.ts`):
  `bun init`, seed a minimal `pnpm-workspace.yaml` (for Databricks Apps deploy),
  `bun add -D projen typescript@^5.9.3 <engine specifier>`, write a minimal
  `.projenrc.ts` if none exists, synth (`post: false` - skips projen's own
  post-synth install), then reconcile the install itself
  (`bun install --force`) and regenerate barrels. Scaffolds **no** package folders
  or sample code - just enough for `bunx projen`/`dbx dev sync` to work from
  here on.
- **`dbx dev sync` on an existing workspace** just runs projen once (full synth,
  installs, regenerates barrels via the post-synth component) - which is exactly
  what `bun run sync` does directly, so prefer that once a workspace exists.
- **`bun run sync --watch`** forwards to `projen sync --watch`, which does one
  initial full synth, then (via `concurrently`) runs the projenrc watcher alongside
  the barrel + openapi watchers. The projenrc watcher re-synths (+install) when
  `.projenrc.ts` or a configured `syncResynthPaths` entry changes; the barrel watcher
  rebuilds just the edited package's barrel, and the openapi watcher regenerates the
  `openapi` packages when a tsoa controller changes.
- **Barrels regenerate on every full (post) synth**: a post-synth projen `Component`
  (`GeneratedBarrels` in `project.ts`) runs on any `runSynth({ post: true })` - the
  plain `bunx projen`, `sync`'s initial synth, and the projenrc watcher's
  re-synth all install and rebuild barrels through it. Fast paths skip it: the
  standalone barrel watcher calls `generateBarrels()` directly on edits (no synth),
  and `bootstrap` runs `runSynth` with `PROJEN_DISABLE_POST` set, doing its own
  install + barrels afterward.
- **`bun run clean`** (`clean.ts`) deletes generated files. It doesn't hardcode a
  list: every file the toolchain writes is read-only (see below), so a read-only file
  under the repo (skipping vendor/build/VCS, but INCLUDING `.projen/*`) is a clean
  target. It shows a `@clack/prompts` picker with all files preselected (uncheck to
  keep); `-y` removes them all non-interactively. Safe to run - `.projenrc.ts` imports
  the engine by SOURCE path, so `bunx projen` regenerates everything afterward.

Barrels re-export every exporting file under `src/` except names starting with
`_`; a package's barrel lives at its ROOT (`index.ts`), re-exporting `./src/*`.
Each module gets an `export * as <ns>` line, and on top of that every name that
is UNIQUE across the package is HOISTED flat as well - `export { ... }` for
non-function values (classes, consts, enums, …), `export type { ... }` for
types - so `DBXToolsNodeProject` and `projenProject.DBXToolsNodeProject` both
resolve. `export function` names are never hoisted; they stay reachable only
through their namespace (`posixPath.toPosix`). Uniqueness is counted over
hoistable values and types together, and a name colliding with a namespace or
declared by a hand-authored `exports.ts` is skipped, so anything ambiguous stays
reachable only through its namespace. Widening what gets hoisted grows the flat
surface of every package at once; regenerate with `bun run barrels`.

## Working on the packages via the demo app

The runnable sample lives under `packages/example/` as two ordinary workspace
members - `packages/example/server/appkit-demo` (`@dbx-tools/demo-appkit-server`,
`server` tag) and `packages/example/app/appkit-demo` (`@dbx-tools/demo-appkit-app`,
`app` tag). It is no longer a standalone workspace: both members declare their
`@dbx-tools/*` deps as `workspace:*`, so bun resolves them from source in the one
`node_modules`. Editing a package is reflected in the demo immediately - there is
no link hook, no `DBX_TOOLS_LINK` switch, and no consumer-mode registry install
(that portability was dropped when the demo merged into the main tree).

```sh
bun install                                   # one workspace; demo resolves packages from source
bun run demo                                  # server dev + client dev server (Bun.serve + HMR), concurrently
# or individually:
bun run --filter @dbx-tools/demo-appkit-server dev   # bun --watch src/server.ts
bun run --filter @dbx-tools/demo-appkit-app dev      # Bun.serve dev server (HMR) via dev.ts
bun run --filter @dbx-tools/demo-appkit-app build    # Bun.build production bundle via build.ts
```

The deployed demo keeps its public OTP shell small: `main.tsx` imports AuthGate
from the focused `@dbx-tools/ui-email/react/auth-gate` subpath and lazy-loads the
application only after the gate admits the visitor, `App.tsx` lazy-loads each
feature route, `ui-mastra` dynamically imports Echarts, chat export,
`sql-formatter`, and a fine-grained Shiki runtime with only its eight supported
grammars, and `ui-teams` loads Adaptive Cards + marked only when a card mounts.
Markdown export never loads Echarts; PDF export loads marked for prose and
Echarts only when it encounters a chart. The server's `onPluginsReady` extension
applies HTTP compression and serves static files first with one-year immutable
headers for Bun's content-hashed names (unhashed files revalidate); AppKit's own
static mount remains the SPA fallback. Keep new feature dependencies behind the
same boundaries instead of importing them into the login entry.

Because everything is one workspace, a single AppKit / Mastra / React instance is
shared automatically (the reason the hoisted linker is mandatory - see the package
manager section). The demo server still ships `app.yaml` + `databricks.yml`, so it
deploys to Databricks Apps unchanged; the committed `pnpm-workspace.yaml` is what
the platform's pnpm build phase reads.

## Generated files — DO NOT edit by hand

- **Per-package** (`package.json`, `tsconfig.json`, `.projen/*`, `README.md`,
  `.gitignore`, …): owned by that package's projen subproject.
- **Root** (root `tsconfig*.json`, `.vscode/*`, per-package `bunfig.toml` + `dev.ts` + `build.ts`):
  read-only + projen marker, emitted from `files.ts`. `pnpm-workspace.yaml` is
  generated by `PnpmWorkspaceState` (`pnpm-workspace.ts`); unlike the engine's own files
  it is NOT read-only, since projen writes it with `readonly: false`.
  The generated `dev.ts` and `build.ts` for `app` packages use Bun.serve (dev) and
  Bun.build (prod) with Tailwind v4 via bun-plugin-tailwind. `bunfig.toml` is
  pinned with `linker = "hoisted"` and is MANDATORY.
- **barrels** (`<root>/<tags...>/<name>/index.ts`): read-only, do-not-edit header,
  written by the engine's own generator (`barrels.ts`). Marked generated in
  `.gitattributes` (`annotateGenerated`).
- **openapi** (`<root>/openapi/<name>/`): fully generated from tsoa
  controllers - spec, types, and client.
- **`.github/workflows/*.yml` except `docs.yml`**: projen-owned. `docs.yml` is
  the one hand-written workflow, so it is the only one to edit directly.

Change a tag, a hook, or `.projenrc.ts` and re-synth — never edit generated files.

- **The engine ships on its own tag but at the SAME version, and one `bump` cuts
  both.** `bun run bump` at the root publishes the `packages/js/**` members via the
  `v*` tag -> `release` workflow -> `bun publish`es each non-private one, which by
  definition cannot exclude `projen/` now that it is a workspace member. So the
  engine's separate publication uses a second namespace: tag `projen-v*` ->
  `projen-release` workflow -> `bun publish` (from `projen/`), versioned from the
  pushed tag. The two namespaces stay separate because `@dbx-tools/projen` is
  consumable on its own, by a repo that wants the monorepo generator and none of
  the Databricks packages.
  What links them is the root's bump task, generated as `--prefix v --exclude
projen --sibling projen:projen-v` from the `standaloneReleases` option: it takes
  the base version from the highest tag across EVERY listed prefix (falling back
  to the shared root `VERSION` file), writes the next version to `VERSION`, synths
  so every manifest copies it, and pushes all the tags together, so both release
  at one version. The `--exclude projen` keeps it out of the packages publish
  pass, and the separate projen release workflow publishes it on its own tag.
  Consulting every prefix at once is what keeps them lockstep: when each namespace
  only consulted its own tags the engine went stale in silence - it sat at 0.1.24
  while the packages reached 0.3.41, so a consumer's `@dbx-tools/projen@latest`
  was months behind the CLI that installed it.
  Releasing the engine alone is still `cd projen && bun run bump`; nothing about
  the version numbers being equal means a package change implies an engine change.
- **Publishing leans on NATIVE bun - do not re-hand-roll what bun already does.**
  `tasks/publish.ts` sets each member's version with `bun pm pkg set version=<v>`
  (not a hand-written JSON edit; `bun pm version` is for bumping and errors on an
  unchanged value, so `pkg set` is the tool for an exact release string). It does
  NOT rewrite `workspace:`/`catalog:` deps - `bun publish` STRIPS both protocols
  in the packed tarball (`workspace:*` -> the sibling's version, `catalog:` -> the
  root catalog range; verified against a packed manifest). It also does NOT pack
  by hand. The workspace publish driver compiles every publishable member once
  from the root with Bun's filtered workspace runner, then uses a bounded pool of
  `bun publish --ignore-scripts` calls so uploads overlap without repeating each
  package's `prepack`. Keep `prepack` on each package anyway: a standalone
  `bun publish` still needs to build itself. The driver first checks whether the
  manifests and Bun workspace lock already carry the release version. A normal
  bump's synth/install makes both current, so it skips no-op version stamping and
  another install. When either is stale (notably a workflow-dispatch dry version),
  it stamps the manifests, deletes `bun.lock`, and runs `bun install` before
  publishing. `bun publish` resolves each `workspace:*` from
  the LOCKFILE, not the live manifest, and a plain `bun install` (even `--force`)
  does not re-resolve after only a version-field change - so without the lockfile
  refresh a sibling dep can publish against a stale resolved version. The disk
  manifests carry the shared `VERSION` (synth copies it), so the stamp confirms
  rather than introduces the release version.
  During a local root bump, the npm/Verdaccio and Python/devpi publishers run in
  parallel because they mutate disjoint JS and Python package trees; each still
  completes its own build before uploading.
- **Release workflows are testable without touching npm.** Both `release` and
  `projen-release` also trigger on `workflow_dispatch` with a `dry_run` boolean
  input (default true). A manual run has no tag, so it uses a throwaway
  `0.0.0-dry.<run>` version and FORCES `bun publish --dry-run` (compile + pack +
  validate, upload skipped). Run it from the Actions tab to exercise the whole
  pipeline - setup-bun, install, stamp, compile, pack - with nothing reaching npm.
- **`bootstrap.ts` pins the engine version explicitly.** `bootstrap.ts` asks for
  `@dbx-tools/projen@^<this CLI's own version>` (see `defaultProjenSpecifier`)
  rather than `@latest`, so the installed engine matches the CLI. That is only sound
  because the root bump releases both at ONE version - if the two ever diverge,
  this specifier starts requesting an engine that was never published.
- **An established workspace pins its engine forever unless the CLI moves it.**
  Bootstrap installs the engine once; every later `dbx` run took the
  "established workspace" path, which only installed when `node_modules` was
  missing and never looked at the engine's VERSION. So a workspace scaffolded
  months earlier kept resolving its original engine no matter how current the CLI
  invoking it was, and then failed inside that old engine's code - which is what
  made a `sync --watch` die on a `concurrently` the installed engine predated,
  and an `addOverride` call fail against a `PnpmWorkspaceState` that had not
  gained it yet. `ensureEngineCurrent` (`bootstrap.ts`, called from `cli.ts`) now
  re-adds the engine when the installed one is BEHIND this CLI. It compares
  versions and only moves forward, so an older CLI cannot downgrade a workspace,
  and an in-repo build (CLI and engine at the same shared `VERSION`) is a no-op.
- **The engine's `@dbx-tools/*` deps are resolved from workspace in-repo and pinned
  in the published tarball.** In-repo, `workspace:*` resolves siblings from source.
  The committed manifest keeps `workspace:*` (baking a `^<version>` for a
  not-yet-published version would break the release workflow's initial `bun
install`); `projen-release` resolves them transiently at publish via
  `tasks/publish.ts --stamp-only` (set versions + refresh lockfile), then `bun
publish` in `projen/` strips `workspace:*` to those versions. Do not
  hand-maintain those ranges.
- **A generator tool the WORKSPACE already provides is a devDep, not a dep.** Every
  engine dependency is installed by every consumer, including ones that never reach
  the code path needing it, so the heavy generator toolchains are loaded lazily
  (`_lazy-require.ts`) from the CONSUMER's install instead. That works because Node
  resolves a bare specifier by walking up from the engine's own location, and under
  pnpm that walk passes through `node_modules/.pnpm/node_modules` — the hidden
  directory holding every package installed ANYWHERE in the workspace — so a tool
  declared by some member package resolves fine. `typescript` and `tsoa` are the two
  that qualify: `generateOpenapi` returns before touching either unless a package has
  tsoa controllers, and a package can only have those if it carries the `server` tag,
  which adds `tsoa@catalog:` to that package itself. Shipping tsoa anyway cost every
  workspace 179 packages (and a deprecated `glob@10` warning) for a module it never
  loads; dropping it took a bare bootstrap from 334 packages to 179. They stay
  devDeps so the engine's own run and its `typeof import("tsoa")` types still
  resolve. `ts-to-zod` and `openapi-typescript` are the opposite case — nothing else
  puts them in a consumer's tree, so they remain real deps. Before adding a dep here,
  ask whether a tag mixin or the root already installs it; if it does, `lazyRequire`
  it. The residual `glob@10` warning in a workspace that genuinely uses tsoa is
  upstream's, not ours — don't paper over it with a pnpm `overrides` entry.
- **pnpm gates build scripts behind the `allowBuilds` MAP** in
  `pnpm-workspace.yaml`, and bun gates them via `trustedDependencies` in
  `package.json`. The engine mirrors both: `PnpmWorkspaceState.allowBuild` writes
  the pnpm map (for Databricks Apps deploy), and the root `package.json`'s
  `trustedDependencies` mirrors the same list for bun (because it lives in
  `workspaces` metadata). Add allowances via `project.pnpmWorkspace?.allowBuild(name)`,
  not by editing either file. Only ALLOWANCES are declared: a dependency that is
  never allowed needs no entry. A stale `node_modules` can report an allowance you
  just added as still unreviewed; re-run with `bun install --force`.
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
  entries, and `applyCompiledPublish` adds `"lib"`. `test/`, `.projen/`, and
  `tsconfig*` are deliberately withheld - none is reachable through either
  `exports` map, and shipping them quadrupled the tarball. Source ships
  ALONGSIDE the compiled output rather than instead of it: it is cheap, and it
  keeps stack traces and go-to-definition landing on real code. If a package
  needs to ship a path outside `src`, add it with `addPackageFiles(p, "...")`
  from a tag or an `applyToProjects` block; do NOT hand-edit the manifest,
  which is projen-owned and read-only.
- **A package resolves from SOURCE in-repo and from COMPILED output once
  published, and `publishConfig` is what keeps both true** (`publish.ts`). The
  workspace `exports` points at `index.ts`, which is what lets packages
  type-check against each other with no build step. That cannot be what ships:
  Node refuses to strip types under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so for a long time every
  consumer had to special-case `@dbx-tools/*` into its own bundle just to hand
  Node something loadable - a tax this repo has no business charging. pnpm
  substitutes `publishConfig`'s `main`/`types`/`exports` into the manifest at
  pack time, so the tarball advertises `lib/` while the workspace keeps its
  source entry points. Nothing about how the repo builds changed.
  Two compiler options make the emitted tree loadable, and both are plain `tsc`.
  `rootDir: "."` is what compiles the package-ROOT `index.ts` barrel at all -
  projen's default `rootDir: "src"` leaves it out, which is why `lib/` had no
  `index.js` for so long. And `rewriteRelativeImportExtensions` (paired with
  `allowImportingTsExtensions`, both in `SHARED_COMPILER_OPTIONS`, so EVERY
  package gets them) turns the `./http.ts` specifiers this repo writes into the
  `./http.js` Node's ESM resolver requires. That pairing is the whole mechanism:
  relative imports carry their REAL extension in source, and `tsc` rewrites it on
  emit. There is deliberately no post-processing pass over `lib/` - an earlier
  version shipped one (`tasks/emit.ts`) that walked the emitted tree appending
  extensions, which this replaces outright. Do not reintroduce it; if an emitted
  specifier looks wrong, the source is missing its extension.
  Setting `publishConfig` REPLACES the field projen renders `access` into, so
  it is carried over from `pkg.package.npmAccess` explicitly; drop it and every
  scoped package publishes restricted.
  `prepack` (spawning `compile`) is what guarantees the output exists - the
  release workflow publishes straight after `bun install` with no build step
  in between.
- **UI packages deliberately still publish source.** The exclusion in
  `publishesCompiled` is about consumers, not convenience: the problem is that
  Node cannot load raw TypeScript, and a browser package is never loaded by
  Node. UI packages reach their consumer through a browser bundler (bun's
  `Bun.build`, or a downstream app's own Vite/webpack), which reads their source
  happily, and they export `./styles.css` plus raw SVG assets that `tsc`
  neither copies nor rewrites - compiling them would mean a real asset pipeline
  to solve a problem they do not have. Downstream builds already split exactly
  this way on their own: the client bundle resolves `@dbx-tools/ui-*` from source,
  while the SERVER bundle was the one that had to inline `@dbx-tools/*`.
- **`arethetypeswrong` is GREEN except for the CJS row, which is correct.**
  Packages are ESM-only, so `node16 (from CJS)` reports "ESM (dynamic import
  only)" - that is what an ESM-only package is supposed to look like, not a
  regression. `node10`, `node16 (from ESM)`, and `bundler` are all green. If a
  row other than the CJS one goes red, the compiled emit or the specifier pass
  broke; check that `lib/index.js` exists and that no relative specifier in
  `lib/**` is still extensionless.
- **`bun.lock` and `uv.lock` are git-IGNORED** (`**/*.lock` in `.gitignore`;
  `git check-ignore bun.lock uv.lock` matches, and neither appears in
  `git ls-files`). They are local install artifacts regenerated by `bun install`
  and `uv sync`; do not commit them. The release publish task also deletes
  `bun.lock` and reinstalls to re-resolve `workspace:*` after a version stamp
  (see the release gotcha below). CI installs are plain `bun install` / `uv sync`.
- **Do NOT set `workflowPackageCache: true`, and do not add `cache: bun` to a
  hand-written workflow** without understanding the implications. `bun.lock` is not
  tracked, so a lockfile-keyed cache has no stable key to hash - keep caching off to
  match the existing posture.
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
  authored special case: it lives at `packages/js/cli/dbx-tools` (tag `cli`,
  name `dbx-tools`), which auto-discovery would otherwise render as
  `@dbx-tools/cli-dbx-tools`. `.projenrc.ts` selects it with
  `project.applyToProjects(root, { identifierName: "cli-dbx-tools", tags: "cli" }, ...)` and:
  overrides the name to `@dbx-tools/cli` (`p.package.addField("name", ...)`),
  adds its bins - `dbx-tools` plus the short `dbx` alias, both pointing at
  `./bin/dbx-tools.js` (npm exposes every `bin` key as its own command) - and
  depends on `@dbx-tools/projen`. That is ALL it declares: tsconfig
  (`rootDir: "."` + the `index.ts`/`bin/**/*.ts` includes) and the `exports` map
  come from the `cli` tag, so a CLI needs no per-package config for either.
  It is the ONLY package in the repo that overrides its name: every other one,
  CLIs included, keeps what discovery derives from its path
  (`packages/js/cli/model-proxy` -> `@dbx-tools/cli-model-proxy`,
  `packages/js/cli/appkit-env` -> `@dbx-tools/cli-appkit-env`). To rename a
  package, MOVE ITS FOLDER - do not add a name override.
  The projen engine itself lives in `projen`
  (`@dbx-tools/projen`). It is a workspace member (via `extraWorkspaceMembers`
  in the root options) and synthesizes itself via its own `projen/.projenrc.ts`,
  which declares its deps inline (`projen`, `constructs`, `oxc-parser`,
  `@dbx-tools/path`, ...) - edit that `deps: [...]` list, then re-synth from
  inside `projen/`.
- **A CLI's `bin` is its `.ts` entry in the workspace and the emitted
  `lib/bin/<name>.js` in the tarball**, swapped by `publishConfig.bin`
  (`publish.ts`) exactly like `exports`. There is no launcher file and no runtime
  dependency: the published bin is plain JavaScript with a `#!/usr/bin/env node`
  shebang that `tsc` copies through, so an installed CLI runs with nothing extra
  in the tree (verified by installing a tarball into a project with no `bun`).
  Note `publishConfig.bin` has to RESOLVE the manifest field, because projen
  renders `bin` lazily (`bin: () => this.renderBin()`) and keeps the map private
  - reading `manifest.bin` directly hands you the function and silently finds no
    entries.
    In-repo, run a CLI through its root task (`bun dbx ...`, which is
    `bun <bin>/<name>.ts`) rather than the bin path: the `.ts` entry runs under
    `bun`, resolving sibling `@dbx-tools/*` imports from source in the workspace.
    A consumer's install resolves the same imports to `lib/`.
- **There is exactly ONE bin in the repo**: `bin/dbx-tools.ts` in
  `@dbx-tools/cli`, declared as `dbx` + the `dbx-tools` alias (npm exposes every
  `bin` key as its own command). A new CLI surface is a SUBCOMMAND of `dbx`, not
  a new bin - the sibling packages under `packages/js/cli/` export
  `buildProgram(name?)` from their `src/cli.ts` and the root program mounts them
  as lazily-imported forwarding commands (see "The `dbx` CLI"). That is what keeps
  one install, one `--help`, and one place a user has to remember, and it keeps a
  heavy dep (the Databricks SDK, AppKit) off the startup path of unrelated
  commands. It also removes the old `npx --package ... <divergent-command>` trap:
  the only installable CLI package is `@dbx-tools/cli` and its bin matches.
  A sibling CLI package still publishes (its `src` is importable, and `./cli` is
  an export subpath), it just contributes no command name of its own.
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
  `undefined` and adds nothing. The root also adds `typescript` and `@types/bun`.
- **`DBXToolsNodeProject` defaults `packageManager: BUN`** (projen's
  `packageManager` is readonly after construction); pass a different one only if
  you know what you're doing, since the whole toolchain assumes bun workspaces.
- **Type-checking is projen's own per-package `compile`** (`tsc --build` against
  each package's tag tsconfig), not a `dbx-tools` command - the tag `lib`/`types`
  overrides are what make misuse fail. Check one package with `bunx projen
compile` (or `bun compile`) in its dir, or all of them with `bun run --filter '*' compile`.
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
  `bootstrap.ts` resolves `bun`'s own CLI via `require.resolve` when available, or
  falls back to PATH lookup.
- **`package.json` is forced read-only by default** on the root and every
  subproject, so the whole generated tree is consistent. The `DBXToolsConfig`
  component sets the manifest's `FileBase.readonly = true` in its CONSTRUCTOR (projen
  still rewrites the file each synth - clears the bit, writes, restores). Opt a
  package out by setting `p.package.file.readonly = false` directly - done in the
  constructor rather than `preSynthesize` precisely so a later opt-out wins at synth.
  The CLI package does exactly this so its own `package.json` stays writable.
  Source/sample files the developer owns (`.projenrc.ts`, each package's `README.md`,
  `src/*`) stay writable regardless.
- **OpenAPI** (`openapi.ts`, `bun run openapi`): scans **every discovered**
  `server`/`node` package for **tsoa** controllers (classes with
  `@Route`/`@Get`/... - no JSDoc/YAML). For each, tsoa's `generateSpec` infers an
  OpenAPI 3 spec from the decorators + TS types, then Speakeasy's
  `openapi spec optimize` extracts duplicate inline schemas into reusable
  `components.schemas`. Generation and optimization happen in a sibling
  temporary directory; only the finished spec is moved to `openapi.json`, then openapi-typescript +
  openapi-fetch produce a read-only `<sourcePackage root>/openapi/<name>`
  package (`openapi.json` + `src/schema.ts` + `src/client.ts`) - colocated under
  the SAME root as the controller it came from (`packages/example/server/
api`'s controllers generate `packages/example/openapi/api`), not a hardcoded
  root. tsoa/typescript/openapi-typescript are lazy-loaded and Speakeasy's pinned
  `openapi` binary is installed lazily through `@dbx-tools/core`'s `bin.ensure`
  (only `bun run openapi` / a watched controller edit needs them). The openapi watcher (started by
  `bun run sync --watch`, under `concurrently`) regenerates it automatically when a
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
- **A chart is branded on the SERVER and themed on the CLIENT, and the split is
  the point.** The `[data-brand]` CSS bridge can't reach an Echarts chart (it
  renders to canvas, not styled DOM), so anything it needs has to be inlined on
  the option itself - but only HALF of that is knowable server-side.
  BRAND (theme-independent) is inlined at plan time: `mastra({ brand })` takes a
  portable `BrandContext` and the planner (`appkit-mastra/src/chart.ts`
  `planToEchartsOption`) merges `brandChartTheme(brand)` into every spec
  (`themed(...)`) - a series `color` cycle seeded from
  `colors.primary`/`colors.accent` plus a colorblind-friendly spread, and the
  `typography.sans` font stack. Omit `brand` for the default Echarts look.
  CHROME (tick labels, axis names, grid lines, tooltip) is resolved at RENDER
  time by `ui-mastra`'s `support/chart-theme.ts`, which reads AppKit's
  `--chart-axis-label` / `--chart-axis-title` / `--chart-grid` /
  `--chart-tooltip-bg` (plus `--popover-foreground` / `--border`) off the chart's
  own element and hands a `ChartChrome` to `normalizeChartOption`. It reads the
  ELEMENT, not `:root`, so a theme scoped to an embedded chat panel wins, and it
  re-resolves on both a root `.dark`/`.light` mutation and a
  `prefers-color-scheme` change. `brandChartTheme` deliberately sets NO text
  color: it used to bake `colors.foreground`, a single light value, which
  rendered near-black labels on a dark chat surface. The PDF export pins
  `LIGHT_CHART_CHROME` because its document forces `color-scheme: light`.
  Add a brand property in `brandChartTheme`/`themed`; add a theme-dependent one
  in `ChartChrome` + `normalizeChrome`. Never per-chart-type.
- **Don't paint a chat surface with a TRANSLUCENT theme token.** The chart frame
  was `bg-background/40` and composited against whatever the host painted
  underneath, so an embedded chat whose host disagrees with AppKit's resolved
  theme (a light app that never set `.light`, so AppKit's
  `@media (prefers-color-scheme: dark) { :root:not(.light) }` fallback darkened
  its tokens) drew charts on a muddy mid-grey plate belonging to neither theme.
  Opaque `bg-card`/`bg-background` degrades honestly. A host embedding the chat
  in a surface it controls should pin `.light` or `.dark` on `:root` rather than
  leaving AppKit on the OS preference.
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
- **Apps OTel / MLflow traces go through Unity Catalog, not OTLP-to-workspace.**
  Managed MLflow has no OTLP ingest (`/api/2.0/mlflow/v1/traces` 404s). On a
  Databricks App, declare `telemetry_export_destinations` (unity_catalog,
  all three of `traces_table` / `logs_table` / `metrics_table`) pointing at the
  MLflow experiment's existing UC trace location (`${schema}.${target}_otel_*`)
  so the platform injects a local OTLP sidecar. Set `OTEL_PROPAGATORS=none`:
  Apps ingress stamps `traceparent` on every request, and without that the UC
  `*_trace_unified` view (root = empty `parent_span_id`) silently drops every
  chat turn. `@dbx-tools/appkit-mastra` owns no exporter - `OtelBridge` rides
  AppKit's global tracer, and `traceIo.attachChatTurnTraceIo` (auto-wired on
  the Mastra sub-app) copies turn I/O onto the root span as `mlflow.spanInputs`
  / `mlflow.spanOutputs` because Mastra's `mastra.agent_run.*` attrs sit on a
  child the view never reads. Do not adopt `mlflow-tracing` TS SDK for this
  path (it steals the global provider and writes a different store). Details
  live in `packages/js/node/appkit-mastra/README.md` under Feedback And
  Observability.
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
- **Model tool capability means a complete Responses round-trip, not merely a
  chat endpoint accepting `tools`.** Databricks endpoint list/OpenAPI metadata
  currently exposes no tools bit, so `ServingEndpointSummary.supportsTools` and
  `classify.endpointCapabilities().tools` use a conservative policy verified
  through the local model proxy: GPT except GPT-OSS, Claude, Qwen, GLM, and
  Llama. Gemini is excluded because its replayed function call requires a
  thought signature Open Responses does not currently accept; GPT-OSS rejects
  Responses passthrough. `requiresTools` must filter candidates BEFORE fuzzy
  ranking/fallback, and model-proxy rejects tool-bearing requests whose resolved
  endpoint is not capable. Update the policy only after testing both the initial
  function call and stateless `function_call_output` replay.
- **Responses-only endpoint policy is shared across Node and Python.**
  `@dbx-tools/model` `invoke.isResponsesOnly` and
  `dbx_tools.model.is_responses_only` classify Codex and GPT 5.4+ as native
  Responses endpoints, while GPT-OSS remains on Chat Completions. LiteLLM calls
  the Python helper; do not reintroduce a second version threshold in the proxy.
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
  const `v<digit>` version marker (`v2` -> "V2") is kept as one token by a
  `shared-core` tokenizer override, alongside the `ai` -> "AI" and `fs` -> "FS"
  ones.
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
- **Thread placement is ONE option with THREE surfaces, all the same list.**
  `threadPlacement` (`disabled` | `auto` | `left` | `right` | `top`) picks
  where conversation management renders; `enableThreads: false` collapses into
  `disabled` so the older flag keeps working. `left`/`right` dock
  `ThreadSidebar` inline (its `side` prop only flips the divider + collapse
  icon) and fall back to an overlay drawer on the same edge below
  `SIDE_PANEL_MIN_WIDTH_PX`; `top` renders `ThreadTabs`, whose history menu is
  that SAME `ThreadSidebar` in a popover - so rename/delete/cancel are written
  once. `ChatView` builds one `threadListProps` bag and adds only framing per
  site; do not fork a second list component.
  `auto` measures the CHAT ROOT with a `ResizeObserver` (`useIsNarrow`), not
  `matchMedia` - an embedded/split-pane chat has to switch on its own width, and
  a zero measurement (hidden panel) is ignored rather than flipping the layout.
  The open-tab set is session state driven by the pure helpers in
  `support/thread-tabs.ts`; `syncThreadTabs` returns its INPUT array when
  nothing changed, which is what keeps the effect that calls it from looping.
  Closing the ACTIVE tab must move the selection in the same handler
  (`nextActiveThreadTab`, else `onNewThread`) - the sync always keeps a tab for
  the active thread, so closing without reselecting just reopens it.

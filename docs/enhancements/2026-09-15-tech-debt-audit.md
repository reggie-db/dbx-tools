# Technical Debt Audit

Date: 2026-09-15

Status: active. Update finding status in this document as work lands. Move this
file to `docs/archived/enhancements` when the tracked work is complete or
intentionally closed.

Scope: repository-wide DRY, architecture, code quality, documentation, and
source-code documentation. Full CI and test-suite execution is intentionally
excluded because it is run frequently by the maintainer.

## Executive Summary

- The first high-risk control point, the Mastra chat hook, was decomposed on
  2026-09-15 without changing its published facade. The largest remaining
  maintenance risks are the Mastra chat view, the Mastra AppKit route
  registrar, and the Rust workspace/release generator.
- The repository is not broadly copy-pasted. `jscpd` found 437 duplicated lines
  across 108,989 scanned lines, approximately 0.4 percent. The actionable DRY
  issues are small policy duplicates, not a reason for a repo-wide abstraction
  campaign.
- The generated API site does not describe the actual installable JavaScript
  export maps for subpath-only UI packages, and it omits Python and Rust APIs.
- TypeDoc is configured to skip error checking, so documentation can be
  generated even when its entry points or references are invalid.
- Public contract validation is inconsistent at two browser network boundaries:
  Mastra SSE chunks and universal-search JSON are trusted after parsing.
- Public source documentation is uneven. An AST scan found 189 undocumented
  importable TypeScript symbols among 1,027 inspected symbols, with the largest
  concentrations in shared contract packages. Generated bindings should remain
  excluded from remediation.
- Python Postgres exports a broad, useful API, but many public definitions have
  no docstrings. Rust libraries are substantially stronger because they deny
  missing rustdoc and broken intra-doc links.
- Package metadata is not publication-ready as a coherent multi-language
  product: all 40 public npm packages are `UNLICENSED`, 36 lack descriptions,
  all 40 lack homepages, and the five Python packages omit license metadata.
- A published Tunnel declaration surface references Express types without
  declaring Express or its type package, which can break downstream type
  resolution.
- No critical security flaw, dependency cycle, or broad architectural tier
  violation was identified in this source audit.

## Architectural Mental Model

`dbx-tools` is a source-first, Projen-generated polyglot monorepo. Handwritten
TypeScript packages are split into browser-safe shared contracts, Node/AppKit
plugins, UI component packages, and command-line packages. Rust owns native
authentication, model discovery and ranking, and the two proxy binaries. UniFFI
projects expose selected Rust capabilities to Node and Python. Python owns a
dependency-light core, Postgres/Lakebase integration, and the Graphiti launcher.

The root `.projenrc.ts` describes the product catalogue while `projen/src`
implements repository conventions, package synthesis, release workflows, and
generated barrels. Root and package READMEs are the documentation sources; the
site is reconstructed under `.docs-build` by two scripts. The architecture is
mostly well layered: shared packages remain browser-safe, Node packages own
AppKit and process integration, and native policy generally stays in Rust. Debt
is concentrated where orchestration code accumulated many independently
changing responsibilities and where generated documentation/package metadata no
longer matches the public product surface.

## Findings

| ID | Category | File:Line | Severity | Effort | Description | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| ARCH-01 | Architectural decay | `packages/js/ui/mastra/src/react/mastra-chat.tsx:219` | High | L | Completed 2026-09-15. `useMastraChat` previously spanned roughly 1,269 lines and owned client resolution, persisted model selection, thread/session state, history paging, streaming, approvals, steering, feedback, suggestions, and embed fetch state. | The public hook remains the facade. Session storage, history paging, stream processing, approval resumption, and feedback submission now live in focused internal hooks with explicit inputs and outputs. |
| ARCH-02 | Architectural decay | `packages/js/ui/mastra/src/react/chat-view.tsx:117` | High | L | `ChatView` occupies the remaining 897 lines of its file and combines transcript rendering, scrolling, side panels, model selection, composer behavior, queue management, exports, approvals, feedback, and responsive layout. | Split the controlled view into transcript, composer, navigation, side-panel, and overlay components while keeping `ChatViewProps` as the compatibility facade. |
| ARCH-03 | Architectural decay | `packages/js/node/appkit-mastra/src/plugin.ts:457` | High | M | `MastraPlugin.injectRoutes` is a 317-line route registrar containing MCP rewriting, models, history, threads, suggestions, feedback, chart and statement fetches, agent dispatch, authorization gates, and error mapping. Route ordering is implicit in one method. | Extract ordered feature registrars such as `registerMcpRoutes`, `registerThreadRoutes`, and `registerAgentRoutes`; keep the catch-all registration visibly last. |
| ARCH-04 | Architectural decay | `projen/src/project-rs.ts:543` | High | L | The Rust workspace constructor is approximately 311 lines and performs crate discovery, package construction, binding inference, binary mapping, facade creation, task registration, dependency graph work, and workspace-file synthesis. This file is also a high-churn hotspot. | Normalize options first, then delegate discovery, binding mapping, facade generation, and task wiring to pure builders that return typed plans. |
| ARCH-05 | Architectural decay | `projen/src/project-rs.ts:855` | High | L | `addReleaseWorkflow` is approximately 396 lines and encodes release matrices, artifact naming, Rust builds, Node and Python bindings, registry publication, facades, and smoke commands in one workflow-construction method. | Build typed job fragments per artifact family and compose them in `addReleaseWorkflow`; centralize repeated environment and asset conventions. |
| DEP-01 | Dependency debt | `.projenrc.ts:202` | Medium | S | A blanket rule adds `@dbx-tools/shared-core` to every JavaScript package. A source-import scan found nine published packages with the generated dependency but no direct import: core-rs, databricks-zerobus, google-rs, shared-auth, shared-email, shared-mastra, shared-search, shared-teams, and ui-search. | Remove the blanket rule and add the dependency through package tags or explicit package rules only where source imports require it. |
| DEP-02 | Dependency debt | `projen/src/tags.ts:67` | High | M | Every UI library receives React and React DOM as regular dependencies rather than peers. All seven UI packages therefore advertise ownership of a React runtime, increasing duplicate-runtime and hook-identity risk for consumers. | Generate React and React DOM as peer dependencies with matching development dependencies, following the existing optional-peer conventions where needed. |
| DEP-03 | Published contract | `packages/js/node/tunnel/lib/src/gate.d.ts:25`<br>`packages/js/node/tunnel/package.json:26` | High | S | Published Tunnel declarations import `RequestHandler` and `Response` from Express, but the manifest declares neither `express` nor `@types/express` as a dependency or peer. A TypeScript consumer can fail while resolving the package declarations. | Prefer AppKit-owned structural request/response types; otherwise declare the minimum Express type dependency or peer and regenerate `lib`. |
| DOC-01 | Documentation coverage | `docs/scripts/generate-api-docs.mjs:82` | High | M | API discovery scans only `packages/js`. Rust crates and Python packages have READMEs but no generated API reference pages, so the site presents only one language's callable surface. | Add language-specific discovery and generation stages, using rustdoc and Python API extraction while retaining READMEs as narrative sources. |
| DOC-02 | Documentation drift | `docs/scripts/generate-api-docs.mjs:89` | High | M | Every npm package is documented from `<package>/index.ts` instead of from its manifest export map. This assumes the generated root barrel is public even for packages that publish only subpaths. | Resolve TypeDoc entry points from `package.json#exports`, including conditional and subpath entries, and reject entries outside the published map. |
| DOC-03 | Documentation drift | `packages/js/ui/mastra/package.json:52`<br>`packages/js/ui/mastra/src/react/index.ts:13` | High | M | `@dbx-tools/ui-mastra` publishes only `./react`, styles, and package metadata, and its React barrel intentionally hides internal building blocks. The generated root barrel nevertheless exports those internals and is what the current API generator reads. | Generate the API page from `./react`; treat root barrels in subpath-only packages as build infrastructure rather than public documentation inputs. |
| DOC-04 | Documentation correctness | `docs/scripts/generate-api-docs.mjs:430` | High | S | TypeDoc runs with `--skipErrorChecking`. Broken references, incompatible entry points, and declaration errors can therefore produce apparently successful documentation. | Remove the flag after export-map-aware entries are implemented, and make API generation fail on documentation/type errors. |
| DRY-01 | Documentation tooling | `docs/scripts/generate-api-docs.mjs:24`<br>`docs/scripts/sync-readmes.mjs:82` | Medium | S | The two documentation scripts duplicate filesystem walking, package discovery, slugging, and summary extraction. The copies already differ in what metadata they retain, which enabled the API/readme package-set mismatch. | Move repository/package discovery and markdown-summary helpers into one dependency-free docs module used by both scripts. |
| DOC-05 | Reproducibility | `docs/scripts/sync-readmes.mjs:474`<br>`.gitignore:87` | Medium | S | The docs script writes caret-ranged Astro and TypeDoc dependencies into an ignored generated tree. A clean build can resolve a different documentation toolchain without a reviewed lockfile change. | Pin exact versions from the root catalogue or generate and validate a committed docs lock input outside `.docs-build`. |
| META-01 | Package metadata | `projen/src/project-js.ts:435` | Medium | S | The JavaScript generator disables licensing, producing `UNLICENSED` for all 40 public npm packages despite the Rust workspace declaring Apache-2.0. Consumers cannot infer whether npm packages are intentionally proprietary or incompletely configured. | Decide the repository's public license policy and generate consistent SPDX metadata and package license files from the owning Projen configuration. |
| META-02 | Package metadata | `packages/js/ui/mastra/package.json:1` | Medium | S | Thirty-six of 40 public npm manifests have no description, so registry search results and generated package summaries omit their purpose even though package READMEs are present. | Add descriptions to the package catalogue and require a non-empty description for every public package during synthesis. |
| META-03 | Package metadata | `packages/js/ui/mastra/package.json:1` | Low | S | All 40 public npm manifests omit `homepage`; consumers receive repository coordinates but no canonical package documentation URL. | Generate package-specific docs URLs once the site route convention is stable. |
| META-04 | Package metadata | `projen/src/project-py.ts:185` | Medium | S | The Python project generator writes name, version, description, README, dependencies, and source URL but no license metadata. All five Python packages inherit the omission. | Add the chosen SPDX license expression and license file to the shared Python project generator. |
| DOC-06 | Documentation drift | `packages/rs/model/README.md:46` | Medium | S | The model README says repository synthesis runs the network-backed metadata generator. Current configuration exposes an explicit `model:metadata` task instead, and normal synthesis intentionally avoids it. | Replace the synthesis claim with `bun run model:metadata` and document that normal synthesis is offline. |
| DOC-07 | Source documentation | `packages/js/shared/mastra/src/feedback.ts:43` | High | M | The public-export AST scan found 189 undocumented symbols among 1,027 inspected TypeScript symbols. Generated bindings are not remediation targets, but the remaining gaps include public schemas, records, callbacks, hooks, and components whose behavior is not discoverable from source or TypeDoc. | Add a public-doc lint focused on manifest-exported handwritten declarations, with generated and compatibility surfaces explicitly excluded. |
| DOC-08 | Source documentation | `packages/js/shared/mastra/src/wire.ts:78` | Medium | M | `@dbx-tools/shared-mastra` has the largest documentation concentration in the scan: 30 of 77 inspected public symbols lack JSDoc, including client config and wire response contracts. | Document wire semantics, optional-field meaning, ownership, and compatibility expectations before lower-level helpers. |
| DOC-09 | Source documentation | `packages/js/shared/genie/src/genie-model.ts:49` | Medium | M | `@dbx-tools/shared-genie` has 24 of 61 inspected public symbols without JSDoc, including event and attachment contracts used across server and browser packages. | Document event ordering, terminal states, optional attachment fields, and schema/type relationships at the owning declarations. |
| DOC-10 | Source documentation | `packages/js/shared/core/src/async.ts:57` | Medium | M | `@dbx-tools/shared-core` has 16 of 53 inspected public symbols without JSDoc. Because this is the dependency-light foundation, undocumented defaults propagate into many packages. | Prioritize option records, default behavior, cancellation semantics, and failure behavior; keep implementation-detail helpers private when they are not intended as API. |
| DOC-11 | Source documentation | `packages/py/postgres/src/dbx_tools/postgres/__init__.py:59`<br>`packages/py/postgres/src/dbx_tools/postgres/advisory_lock.py:30` | High | M | Python Postgres exports 49 names, while a definition scan found 29 public definitions without docstrings. Core lock-id behavior, engine option records, and the topic-bus lifecycle are visible only by reading implementation and README prose. | Add docstrings to owning definitions and generate Python API pages from them; document lifecycle, connection ownership, refresh policy, and cross-language aliases once. |
| TYPE-01 | Trust boundary | `packages/js/ui/mastra/src/support/mastra-stream.ts:45` | High | M | Mastra SSE payloads are JSON-parsed directly into `MastraStreamChunk` without runtime schema validation. A malformed or upstream-versioned chunk enters the state reducer as if it satisfied the contract. | Define the chunk discriminated union in the owning shared Mastra package and parse each SSE payload before dispatch. |
| TYPE-02 | Type debt | `packages/js/ui/mastra/src/react/mastra-chat.tsx:553` | High | M | The stream callback widens `payload` to `any`, defeating exhaustive checking precisely where untrusted chunks update messages, tool events, approvals, and usage state. | Consume the validated discriminated union and move per-chunk reduction into exhaustive pure reducer functions. |
| TYPE-03 | Trust boundary | `packages/js/ui/search/src/react/use-search.ts:120` | High | S | Universal-search JSON is asserted as `SearchResult` instead of parsed with the owning shared schema. Missing or malformed fields silently reach UI state. | Export and call the owning `searchResultSchema.parse` or `safeParse`, and map validation failure to the existing error state. |
| DRY-02 | Request context | `packages/js/node/appkit-mastra/src/history.ts:206`<br>`packages/js/node/appkit-mastra/src/threads.ts:223` | Medium | S | History and thread route factories separately implement fixed/dynamic agent validation, agent lookup, request-context lookup, resource-id errors, and JSON error shapes. The copies differ only in thread-id requirements and returned fields. | Introduce one internal `resolveAgentRequestContext` helper with explicit requirements such as `threadId: required` and reuse it in both route modules. |
| DRY-03 | Search policy | `packages/js/node/search/src/plugin.ts:426`<br>`packages/js/node/search/src/tool.ts:58` | Medium | S | Plugin exports and Mastra tools independently parse search requests and rebuild the same client option object. Adding an option can update one surface but not the other. | Centralize request-to-client option mapping in a small shared Node helper used by both plugin and tool adapters. |
| DRY-04 | Runtime lifecycle | `packages/rs/model-proxy/src/main.rs:172`<br>`packages/rs/lakebase-proxy/src/main.rs:120` | Medium | S | Both proxy binaries carry the same Ctrl-C and Unix SIGTERM future. Signal policy is generic runtime behavior and can drift between binaries. | Move the shutdown future into the shared Rust core runtime module and call it from both binaries. |
| DRY-05 | CLI forwarding | `packages/py/graphiti/src/dbx_tools/graphiti/cli.py:144`<br>`packages/py/graphiti/src/dbx_tools/graphiti/supervisor.py:37` | Medium | S | Both Graphiti entry points split arguments at `--`, bind Cyclopts options, append forwarded Graphiti arguments, execute, and translate nonzero integer results to `SystemExit`. | Extract one private Cyclopts forwarding runner parameterized by app and default-command behavior. |
| DRY-06 | Observability | `packages/rs/model-proxy/src/routes.rs:266`<br>`packages/rs/model-proxy/src/routes.rs:429`<br>`packages/rs/model-proxy/src/routes.rs:463` | High | M | Embeddings, unsuccessful buffered requests, and successful adapted requests repeat a large throttle/request logging field set; reconciliation and completion semantics are interleaved with route-specific response handling. Field drift would make operational comparisons unreliable. | Build typed request-completion and stream-connection log contexts, and centralize reconcile-plus-log behavior while retaining route-specific message names. |
| DRY-07 | Release tooling | `projen/tasks/bump.ts:17`<br>`projen/tasks/release-pr.ts:23` | Medium | S | Release level, OS, architecture constants, types, and repeatable-option collection are duplicated between bump and release-PR commands. | Export the shared option vocabulary and Commander option builders from the existing release-platform module. |

## Implementation Progress

- [x] `ARCH-01` completed on 2026-09-15. The published
  `@dbx-tools/ui-mastra/react` barrel is unchanged. `useMastraChat` now delegates
  session registry ownership, history paging, stream chunk handling, approval
  resumption, and feedback submission to five internal hooks. The source file
  fell from 1,545 to 1,006 lines, and the hook facade fell from roughly 1,269 to
  766 lines. Focused validation passed: TypeScript compilation, Prettier, and 38
  package tests.
- [ ] `DEP-01` is the next scheduled finding. No other high, medium, or low
  finding is included in the current implementation batch.

## Top Five

### 1. Decompose the Mastra UI without changing its public API

Refactor outline:

1. [x] Keep `useMastraChat(options)` and `ChatView(props)` as stable facades.
2. [x] Move thread/session state behind a focused internal registry hook.
3. [x] Move history paging into an internal history hook.
4. [x] Move SSE chunk handling behind an internal stream hook. Runtime schema
   validation and exhaustive reduction remain tracked separately by `TYPE-01`
   and `TYPE-02`.
5. [ ] Split `ChatView` into transcript, composer, navigation, detail-panel, and
   approval-overlay components.
6. [ ] Pass narrow state/actions into each component instead of the entire hook
   result.

This reduces the blast radius of changes while preserving package consumers.

### 2. Turn Mastra server routing into ordered feature registrars

Refactor outline:

1. Introduce an internal route-registration context containing router, base
   path, client policy, and error helpers.
2. Extract MCP alias, model, history/thread, suggestion/feedback, statement/chart,
   and agent-dispatch registrars.
3. Reuse one agent/request-context resolver across history and thread routes.
4. Compose registrars in `injectRoutes`, with the catch-all dispatch visibly and
   mechanically last.

The goal is not a new framework; it is making ordering and authorization review
possible one feature at a time.

### 3. Split Rust workspace planning from Projen mutation

Refactor outline:

1. Convert raw options into a `ResolvedRustWorkspacePlan` with crates, bindings,
   binaries, facades, and release targets.
2. Make discovery and dependency ordering pure functions over that plan.
3. Give Node bindings, Python bindings, binaries, and facades separate workflow
   job builders.
4. Keep one thin Projen adapter that writes files, adds tasks, and installs the
   composed jobs.
5. Move release OS/CPU option vocabulary into the same release-platform source
   used by command-line tasks.

This attacks both the largest generator methods and one of the highest-churn
files without rewriting the repository generator.

### 4. Make documentation derive from real package contracts

Refactor outline:

1. Create one docs package-discovery module shared by README and API generation.
2. Resolve JavaScript API entry points from manifest export maps, not generated
   root barrels.
3. Add Python and Rust API stages and link them from the same package catalogue.
4. Remove `--skipErrorChecking` and fail generation on invalid references.
5. Pin the docs toolchain through reviewed root inputs rather than ignored,
   caret-ranged generated dependencies.

This fixes incorrect pages before adding more documentation volume.

### 5. Establish validated and documented public contracts

Refactor outline:

1. Put Mastra stream chunk schemas in `@dbx-tools/shared-mastra` and parse every
   SSE event.
2. Parse universal-search responses with the existing owning schema.
3. Replace `any` reducers with exhaustive discriminated-union handlers.
4. Add a documentation check over manifest-exported handwritten declarations.
5. Prioritize shared wire packages and Python Postgres, while excluding generated
   bindings and intentional compatibility aliases.

Runtime validation and source documentation should come from the same owning
contract, not parallel handwritten descriptions.

## Quick Wins

- [ ] Fix the model metadata task wording in `packages/rs/model/README.md`.
- [ ] Remove unused blanket `@dbx-tools/shared-core` dependencies from the nine
      packages identified by the import scan.
- [ ] Resolve the Express type leak in the Tunnel declaration surface.
- [ ] Parse universal-search responses with the shared schema.
- [ ] Move release OS, architecture, level, and repeatable option helpers into
      the existing release-platform module.
- [ ] Extract the shared Rust shutdown signal future.
- [ ] Extract the Graphiti `--` forwarding runner.
- [ ] Share docs discovery and markdown-summary helpers.
- [ ] Remove `--skipErrorChecking` after API entries follow export maps.
- [ ] Add generated validation requiring description metadata for public npm
      packages.

## Things That Look Bad But Are Actually Fine

- The repository does not need a broad DRY rewrite. The measured duplication is
  approximately 0.4 percent, and several reported clones are tests, generated
  declarations, or repeated protocol shapes where local clarity is preferable.
- Generated UniFFI bindings, generated barrels, generated manifests, and model
  metadata snapshots are not handwritten debt. Fix their generators or export
  inputs rather than editing generated files.
- Python camelCase aliases next to snake_case APIs are intentional cross-language
  compatibility surfaces. Removing them would create compatibility work without
  reducing ownership of the underlying behavior.
- `packages/js/shared/core/src/object.ts` is large, but its module documentation
  explains a cohesive dependency-free object and iterable utility surface. Size
  alone is not enough reason to split a foundational module.
- The AppKit `PluginMap` deep import in
  `packages/js/node/appkit/src/appkit.ts:37` is explicitly documented as a
  published upstream type subpath unavailable from the root barrel. It should be
  monitored against AppKit upgrades, not replaced with another copied interface.
- Separate browser-safe TypeScript, framework-specific Python, and native Rust
  implementations are sometimes required by runtime boundaries. The existing
  audit note correctly keeps React/Zod, SQLAlchemy/asyncpg, and native proxy
  behavior in their owning runtimes rather than forcing them through UniFFI.
- No dependency cycles or material package-tier violations were found. The
  shared, Node, UI, CLI, Python, and Rust boundaries generally reflect runtime
  ownership rather than arbitrary folder organization.
- Missing CI execution is not treated as debt in this report. The maintainer runs
  tests frequently locally, and this pass focuses on source structure and public
  contracts.

## Open Questions

1. Are the npm packages intentionally proprietary while Rust is Apache-2.0, or
   should all published packages use one repository license?
2. Should React be supplied by every host application as a peer, or is bundling
   an isolated React runtime an explicit product requirement for any UI package?
3. Is the public documentation site intended to cover only npm packages, or
   should Rust and Python become first-class API-reference sections?
4. Are generated root barrels for subpath-only UI packages intended for any
   supported consumer, or only for repository tooling and source discovery?
5. Should source documentation coverage become a release gate, and if so, what
   threshold and exclusions should apply to generated bindings and compatibility
   aliases?
6. Is the Express type exposure in Tunnel intentional, or is `lib` stale relative
   to a desired AppKit-only structural declaration surface?
7. Should the docs site resolve its toolchain from the root Bun catalogue, or is
   a separately pinned docs environment preferred?

## Method

- Read repository instructions, root/package documentation, manifests, and
  architecture notes.
- Mapped package areas, public entry points, generated surfaces, and runtime
  ownership across TypeScript, Rust, and Python.
- Reviewed the latest 200 commits, six months of file churn, largest files, and
  the overlap between size and churn.
- Ran lexical duplication analysis with `jscpd`: 25 clones, 437 duplicated lines,
  108,989 total scanned lines, approximately 0.4 percent.
- Ran a Knip-oriented unused-file/dependency scan, then manually filtered known
  Projen, task-entry, test, source-first, and generated false positives.
- Ran a TypeScript compiler-API scan from actual manifest export targets to
  measure public JSDoc coverage.
- Inspected Python exports and public definition docstrings, Rust rustdoc gates,
  package metadata, docs generation, and declaration dependencies.
- Did not modify generated artifacts, run a full CI/test suite, or treat missing
  CI execution as a finding.

## Limitations

- `jscpd` finds lexical similarity, not semantic duplication. Small policy copies
  can matter more than large test/data clones, and unrelated code can look alike.
- Knip has limited awareness of Projen task entry points, source-first package
  exports, generated workflows, and dynamic plugin registration. Findings from it
  were used only after manual source review.
- The TypeScript documentation scan measures declaration comments, not README
  quality or whether a comment is accurate. It can also see generated binding
  exports; those are explicitly excluded from recommended remediation.
- This was a static source audit. It did not exercise deployment-only paths,
  browser interaction, live Databricks APIs, performance under load, or
  network-backed dependency vulnerability databases.
- Line citations describe the repository on 2026-09-15 and will move as files are
  edited.

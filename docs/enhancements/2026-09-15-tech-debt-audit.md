# Technical Debt Audit

Date: 2026-09-15

Status: active. Update finding status in this document as work lands. Move this
file to `docs/archived/enhancements` when the tracked work is complete or
intentionally closed.

Scope: repository-wide DRY, architecture, code quality, documentation, and
source-code documentation. Full CI and test-suite execution is intentionally
excluded because it is run frequently by the maintainer.

## Executive Summary

- All High findings were completed on 2026-09-15. The high-risk Mastra UI,
  AppKit routing, and Rust generator control points were decomposed without
  changing their published contracts or generated workflows, and the
  documentation pipeline now follows published package contracts.
- The repository is not broadly copy-pasted. `jscpd` found 437 duplicated lines
  across 108,989 scanned lines, approximately 0.4 percent. The actionable DRY
  issues are small policy duplicates, not a reason for a repo-wide abstraction
  campaign.
- The generated API site now resolves JavaScript entry points from package
  export maps, generates Python API pages and Rust library rustdoc, and gives
  binary-only crates an explicit package landing page.
- TypeDoc now performs normal error checking, and the complete documentation
  build validates generated titles and internal links.
- The two audited browser network boundaries now validate Mastra SSE chunks and
  universal-search JSON with schemas from their owning shared packages.
- Public source documentation remains uneven, but a manifest-aware ratchet now
  records the 183 existing undocumented handwritten TypeScript symbols and
  rejects new debt while excluding generated bindings.
- Python Postgres now documents its public definitions, lifecycle, connection
  ownership, and credential-refresh behavior. Rust libraries remain protected
  by missing-rustdoc and broken-link compiler gates.
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

| ID      | Category                  | File:Line                                                                                                                         | Severity | Effort | Description                                                                                                                                                                                                                                                                                                    | Recommendation                                                                                                                                                                                                       |
| ------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ARCH-01 | Architectural decay       | `packages/js/ui/mastra/src/react/mastra-chat.tsx:219`                                                                             | High     | L      | Completed 2026-09-15. `useMastraChat` previously spanned roughly 1,269 lines and owned client resolution, persisted model selection, thread/session state, history paging, streaming, approvals, steering, feedback, suggestions, and embed fetch state.                                                       | The public hook remains the facade. Session storage, history paging, stream processing, approval resumption, and feedback submission now live in focused internal hooks with explicit inputs and outputs.            |
| ARCH-02 | Architectural decay       | `packages/js/ui/mastra/src/react/chat-view.tsx:13`                                                                                | High     | L      | Completed 2026-09-15. `ChatView` previously occupied roughly 897 lines and combined transcript rendering, scrolling, side panels, model selection, composer behavior, queue management, exports, approvals, feedback, and responsive layout.                                                                   | `ChatViewProps` remains the compatibility contract. The 119-line facade now delegates responsive thread navigation, transcript scrolling/rendering, and composer/queue ownership to three focused internal modules.  |
| ARCH-03 | Architectural decay       | `packages/js/node/appkit-mastra/src/plugin.ts:457`                                                                                | High     | M      | Completed 2026-09-15. `MastraPlugin.injectRoutes` previously contained roughly 317 lines of MCP rewriting, models, suggestions, feedback, embed fetches, agent dispatch, authorization gates, and error mapping.                                                                                               | `injectRoutes` is now a seven-line ordered composition of focused MCP, model, embed, suggestion, feedback, and agent registrars. The gated Mastra catch-all is mechanically last.                                    |
| ARCH-04 | Architectural decay       | `projen/src/project-rs.ts:1430`                                                                                                   | High     | L      | Completed 2026-09-15. The Rust workspace constructor previously performed crate discovery, package construction, binding inference, binary mapping, facade creation, task registration, dependency graph work, and workspace-file synthesis inline.                                                            | The 39-line constructor now orchestrates normalized workspace options, typed release/binding plans, focused package builders, generated-file writers, and task registration helpers.                                 |
| ARCH-05 | Architectural decay       | `projen/src/project-rs.ts:1471`                                                                                                   | High     | L      | Completed 2026-09-15. `addReleaseWorkflow` previously encoded release matrices, artifact naming, Rust builds, Node and Python bindings, registry publication, facades, and smoke commands in one approximately 396-line method.                                                                                | The 31-line composer now installs jobs from one typed release plan and dedicated Rust-build, Cargo, GitHub-asset, native-npm, and Node-facade builders.                                                              |
| DEP-01  | Dependency debt           | `.projenrc.ts:202`                                                                                                                | Medium   | S      | A blanket rule adds `@dbx-tools/shared-core` to every JavaScript package. A source-import scan found nine published packages with the generated dependency but no direct import: core-rs, databricks-zerobus, google-rs, shared-auth, shared-email, shared-mastra, shared-search, shared-teams, and ui-search. | Remove the blanket rule and add the dependency through package tags or explicit package rules only where source imports require it.                                                                                  |
| DEP-02  | Dependency debt           | `projen/src/tags.ts:67`                                                                                                           | High     | M      | Completed 2026-09-15. Every UI library previously received React and React DOM as regular dependencies, so all seven packages advertised ownership of a React runtime.                                                                                                                                         | The `ui` tag now generates React and React DOM as peer dependencies with matching development dependencies. App-tagged browser applications continue to own their runtime dependencies.                              |
| DEP-03  | Published contract        | `.projenrc.ts:630`<br>`packages/js/node/tunnel/package.json:34`                                                                   | High     | S      | Completed 2026-09-15. Published Tunnel declarations referenced Express request and response types while the manifest declared no corresponding type dependency.                                                                                                                                                | Tunnel now declares `@types/express` as a runtime package dependency because Express types are part of its emitted declaration contract. Focused middleware tests and package compilation pass.                      |
| DOC-01  | Documentation coverage    | `docs/scripts/generate-api-docs.mjs:82`                                                                                           | High     | M      | Completed 2026-09-15. API discovery previously scanned only `packages/js`, leaving Python and Rust callable surfaces without generated API references.                                                                                                                                                         | API generation now discovers five Python packages and four public Rust crates. Python pages come from AST extraction, library crates publish rustdoc, and the binary-only model proxy has an explicit landing page.  |
| DOC-02  | Documentation drift       | `docs/scripts/generate-api-docs.mjs:89`                                                                                           | High     | M      | Completed 2026-09-15. npm packages were documented from generated root barrels rather than their installable manifest export maps.                                                                                                                                                                             | A tested export-map resolver now follows root, subpath, and conditional TypeScript targets and rejects targets outside the package before invoking TypeDoc.                                                          |
| DOC-03  | Documentation drift       | `packages/js/ui/mastra/package.json:52`<br>`packages/js/ui/mastra/src/react/index.ts:13`                                          | High     | M      | Completed 2026-09-15. `@dbx-tools/ui-mastra` publishes `./react`, styles, and package metadata, but documentation previously read its broader generated root barrel.                                                                                                                                           | Its API page now comes only from the published `./react` entry. Internal chat orchestration hooks remain absent from the generated consumer surface.                                                                 |
| DOC-04  | Documentation correctness | `docs/scripts/generate-api-docs.mjs:430`                                                                                          | High     | S      | Completed 2026-09-15. TypeDoc previously used `--skipErrorChecking`, allowing invalid entry points or declaration references to appear successful.                                                                                                                                                             | Error suppression is removed. The complete 49-package API generation, 2,431-page Astro build, generated-title check, and internal-link check pass.                                                                   |
| DRY-01  | Documentation tooling     | `docs/scripts/generate-api-docs.mjs:24`<br>`docs/scripts/sync-readmes.mjs:82`                                                     | Medium   | S      | The two documentation scripts duplicate filesystem walking, package discovery, slugging, and summary extraction. The copies already differ in what metadata they retain, which enabled the API/readme package-set mismatch.                                                                                    | Move repository/package discovery and markdown-summary helpers into one dependency-free docs module used by both scripts.                                                                                            |
| DOC-05  | Reproducibility           | `docs/scripts/sync-readmes.mjs:474`<br>`.gitignore:87`                                                                            | Medium   | S      | The docs script writes caret-ranged Astro and TypeDoc dependencies into an ignored generated tree. A clean build can resolve a different documentation toolchain without a reviewed lockfile change.                                                                                                           | Pin exact versions from the root catalogue or generate and validate a committed docs lock input outside `.docs-build`.                                                                                               |
| META-01 | Package metadata          | `projen/src/project-js.ts:435`                                                                                                    | Medium   | S      | The JavaScript generator disables licensing, producing `UNLICENSED` for all 40 public npm packages despite the Rust workspace declaring Apache-2.0. Consumers cannot infer whether npm packages are intentionally proprietary or incompletely configured.                                                      | Decide the repository's public license policy and generate consistent SPDX metadata and package license files from the owning Projen configuration.                                                                  |
| META-02 | Package metadata          | `packages/js/ui/mastra/package.json:1`                                                                                            | Medium   | S      | Thirty-six of 40 public npm manifests have no description, so registry search results and generated package summaries omit their purpose even though package READMEs are present.                                                                                                                              | Add descriptions to the package catalogue and require a non-empty description for every public package during synthesis.                                                                                             |
| META-03 | Package metadata          | `packages/js/ui/mastra/package.json:1`                                                                                            | Low      | S      | All 40 public npm manifests omit `homepage`; consumers receive repository coordinates but no canonical package documentation URL.                                                                                                                                                                              | Generate package-specific docs URLs once the site route convention is stable.                                                                                                                                        |
| META-04 | Package metadata          | `projen/src/project-py.ts:185`                                                                                                    | Medium   | S      | The Python project generator writes name, version, description, README, dependencies, and source URL but no license metadata. All five Python packages inherit the omission.                                                                                                                                   | Add the chosen SPDX license expression and license file to the shared Python project generator.                                                                                                                      |
| DOC-06  | Documentation drift       | `packages/rs/model/README.md:46`                                                                                                  | Medium   | S      | The model README says repository synthesis runs the network-backed metadata generator. Current configuration exposes an explicit `model:metadata` task instead, and normal synthesis intentionally avoids it.                                                                                                  | Replace the synthesis claim with `bun run model:metadata` and document that normal synthesis is offline.                                                                                                             |
| DOC-07  | Source documentation      | `packages/js/shared/mastra/src/feedback.ts:43`                                                                                    | High     | M      | Completed 2026-09-15. Public TypeScript documentation had no automated guard, so new undocumented exports could silently expand the existing backlog.                                                                                                                                                          | A manifest-aware AST ratchet records 183 existing undocumented handwritten exports, excludes generated bindings, rejects new debt, and runs in build and documentation release workflows.                            |
| DOC-08  | Source documentation      | `packages/js/shared/mastra/src/wire.ts:78`                                                                                        | Medium   | M      | `@dbx-tools/shared-mastra` has the largest documentation concentration in the scan: 30 of 77 inspected public symbols lack JSDoc, including client config and wire response contracts.                                                                                                                         | Document wire semantics, optional-field meaning, ownership, and compatibility expectations before lower-level helpers.                                                                                               |
| DOC-09  | Source documentation      | `packages/js/shared/genie/src/genie-model.ts:49`                                                                                  | Medium   | M      | `@dbx-tools/shared-genie` has 24 of 61 inspected public symbols without JSDoc, including event and attachment contracts used across server and browser packages.                                                                                                                                               | Document event ordering, terminal states, optional attachment fields, and schema/type relationships at the owning declarations.                                                                                      |
| DOC-10  | Source documentation      | `packages/js/shared/core/src/async.ts:57`                                                                                         | Medium   | M      | `@dbx-tools/shared-core` has 16 of 53 inspected public symbols without JSDoc. Because this is the dependency-light foundation, undocumented defaults propagate into many packages.                                                                                                                             | Prioritize option records, default behavior, cancellation semantics, and failure behavior; keep implementation-detail helpers private when they are not intended as API.                                             |
| DOC-11  | Source documentation      | `packages/py/postgres/src/dbx_tools/postgres/__init__.py:59`<br>`packages/py/postgres/src/dbx_tools/postgres/advisory_lock.py:30` | High     | M      | Completed 2026-09-15. Python Postgres previously exposed 49 names while 29 public owning definitions lacked docstrings.                                                                                                                                                                                        | Owning definitions now document lock identifiers, engine and connection ownership, credential caching, topic-bus lifecycle, and compatibility aliases; the generated page covers 36 definitions across four modules. |
| TYPE-01 | Trust boundary            | `packages/js/shared/mastra/src/stream.ts:1`<br>`packages/js/ui/mastra/src/support/mastra-stream.ts:1`                             | High     | M      | Completed 2026-09-15. Mastra SSE payloads were JSON-parsed directly into a handwritten client interface without runtime schema validation.                                                                                                                                                                     | The owning shared package now exports a strict discriminated union for known chunks plus an explicit forward-compatible unknown variant, and the browser stream processor parses every SSE payload before dispatch.  |
| TYPE-02 | Type debt                 | `packages/js/ui/mastra/src/react/chat-stream-reducer.ts:1`                                                                        | High     | M      | Completed 2026-09-15. The stream callback previously widened `payload` to `any` while updating messages, tool events, approvals, and usage state.                                                                                                                                                              | A pure exhaustive reducer now consumes the validated stream union. Reducer tests cover text, reasoning, tool lifecycle, progress, approval deduplication, missing live run ids, unknown events, and errors.          |
| TYPE-03 | Trust boundary            | `packages/js/ui/search/src/react/use-search.ts:53`                                                                                | High     | S      | Completed 2026-09-15. Universal-search JSON was asserted as `SearchResult`, allowing malformed fields to reach UI state.                                                                                                                                                                                       | The hook now parses JSON with the owning `@dbx-tools/shared-search` schema and routes validation failures through the existing error state. Focused tests cover valid and malformed responses.                       |
| DRY-02  | Request context           | `packages/js/node/appkit-mastra/src/history.ts:206`<br>`packages/js/node/appkit-mastra/src/threads.ts:223`                        | Medium   | S      | History and thread route factories separately implement fixed/dynamic agent validation, agent lookup, request-context lookup, resource-id errors, and JSON error shapes. The copies differ only in thread-id requirements and returned fields.                                                                 | Introduce one internal `resolveAgentRequestContext` helper with explicit requirements such as `threadId: required` and reuse it in both route modules.                                                               |
| DRY-03  | Search policy             | `packages/js/node/search/src/plugin.ts:426`<br>`packages/js/node/search/src/tool.ts:58`                                           | Medium   | S      | Plugin exports and Mastra tools independently parse search requests and rebuild the same client option object. Adding an option can update one surface but not the other.                                                                                                                                      | Centralize request-to-client option mapping in a small shared Node helper used by both plugin and tool adapters.                                                                                                     |
| DRY-04  | Runtime lifecycle         | `packages/rs/model-proxy/src/main.rs:172`<br>`packages/rs/lakebase-proxy/src/main.rs:120`                                         | Medium   | S      | Both proxy binaries carry the same Ctrl-C and Unix SIGTERM future. Signal policy is generic runtime behavior and can drift between binaries.                                                                                                                                                                   | Move the shutdown future into the shared Rust core runtime module and call it from both binaries.                                                                                                                    |
| DRY-05  | CLI forwarding            | `packages/py/graphiti/src/dbx_tools/graphiti/cli.py:144`<br>`packages/py/graphiti/src/dbx_tools/graphiti/supervisor.py:37`        | Medium   | S      | Both Graphiti entry points split arguments at `--`, bind Cyclopts options, append forwarded Graphiti arguments, execute, and translate nonzero integer results to `SystemExit`.                                                                                                                                | Extract one private Cyclopts forwarding runner parameterized by app and default-command behavior.                                                                                                                    |
| DRY-06  | Observability             | `packages/rs/model-proxy/src/request_log.rs:1`                                                                                    | High     | M      | Completed 2026-09-15. Embeddings, unsuccessful buffered requests, successful adapted requests, and streaming completion repeated the same throttle and request fields around route-specific response handling.                                                                                                 | A typed request log context now owns shared fields, reconciliation, buffered completion, stream connection, and stream completion logging while retaining the existing route-specific event names.                   |
| DRY-07  | Release tooling           | `projen/tasks/bump.ts:17`<br>`projen/tasks/release-pr.ts:23`                                                                      | Medium   | S      | Release level, OS, architecture constants, types, and repeatable-option collection are duplicated between bump and release-PR commands.                                                                                                                                                                        | Export the shared option vocabulary and Commander option builders from the existing release-platform module.                                                                                                         |

## Implementation Progress

- [x] `ARCH-01` completed on 2026-09-15. The published
      `@dbx-tools/ui-mastra/react` barrel is unchanged. `useMastraChat` now delegates
      session registry ownership, history paging, stream chunk handling, approval
      resumption, and feedback submission to five internal hooks. The source file
      fell from 1,545 to 1,006 lines, and the hook facade fell from roughly 1,269 to
      766 lines. Focused validation passed: TypeScript compilation, Prettier, and 38
      package tests.
- [x] `ARCH-02`, `TYPE-01`, and `TYPE-02` completed on 2026-09-15. The public
      `ChatViewProps` and `@dbx-tools/ui-mastra/react` surface are unchanged.
      Responsive thread navigation, transcript behavior, and composer behavior now
      live in focused internal components. Mastra SSE events are validated by the
      owning shared package and reduced through an exhaustive pure state machine.
      Focused validation passed: both package compiles and 46 Mastra package tests.
- [x] `DEP-02`, `DEP-03`, and `TYPE-03` completed on 2026-09-15. UI libraries
      now peer-depend on the host React runtime, Tunnel publishes the Express type
      dependency its declarations require, and universal-search JSON is parsed with
      its owning schema. Focused validation passed: Projen, Search, and Tunnel
      compiles plus 27 targeted tests.
- [x] `ARCH-03` completed on 2026-09-15. Mastra route registration now composes
      six focused registrars in reviewable order, with the gated catch-all last.
      Focused validation passed: package compilation and all 89 AppKit-Mastra tests.
- [x] `DRY-06` completed on 2026-09-15. Buffered and streamed model requests now
      share one typed logging context for throttle fields, usage reconciliation,
      connection timing, and completion timing. All 43 model-proxy tests pass.
- [x] `ARCH-04` and `ARCH-05` completed on 2026-09-15. Rust workspace options,
      dependencies, binding packages, workspace files, and release artifacts now
      flow through typed plans and focused builders. The constructor is 39 lines
      and `addReleaseWorkflow` is 31 lines. Focused validation passed: Projen
      compilation, Prettier, and all 12 Rust-workspace generator tests.
- [x] `DOC-01`, `DOC-02`, `DOC-03`, `DOC-04`, `DOC-07`, and `DOC-11` completed
      on 2026-09-15. API generation now follows npm export maps, adds Python and
      Rust surfaces, and runs without TypeDoc error suppression. A source-doc
      ratchet rejects new TypeScript debt, and Python Postgres public definitions
      now carry lifecycle-focused docstrings. Focused validation passed: 29 Bun
      tests, the Python generator test, Ruff, Prettier, the source-doc ratchet,
      49-package API generation, a 2,431-page Astro build, and internal-link
      validation.
- [ ] Complete every Medium finding in focused batches. Low findings remain
      intentionally deferred for maintainer review.

## Top Five

### 1. Decompose the Mastra UI without changing its public API

Refactor outline:

1. [x] Keep `useMastraChat(options)` and `ChatView(props)` as stable facades.
2. [x] Move thread/session state behind a focused internal registry hook.
3. [x] Move history paging into an internal history hook.
4. [x] Move SSE chunk handling behind an internal stream hook. Runtime schema
       validation and exhaustive reduction remain tracked separately by `TYPE-01`
       and `TYPE-02`.
5. [x] Split `ChatView` into transcript, composer, navigation, detail-panel, and
       approval-overlay components.
6. [x] Pass narrow state/actions into each component instead of the entire hook
       result.

This reduces the blast radius of changes while preserving package consumers.

### 2. Turn Mastra server routing into ordered feature registrars

Refactor outline:

1. [x] Introduce focused internal route registrars around the shared plugin state,
       path, client policy, and error helpers.
2. [x] Extract MCP alias, model, suggestion/feedback, statement/chart,
       and agent-dispatch registrars.
3. Reuse one agent/request-context resolver across history and thread routes.
4. [x] Compose registrars in `injectRoutes`, with the catch-all dispatch visibly and
       mechanically last.

The goal is not a new framework; it is making ordering and authorization review
possible one feature at a time.

### 3. Split Rust workspace planning from Projen mutation

Refactor outline:

1. [x] Normalize raw options before crate and package construction.
2. [x] Make discovery, dependency ordering, and binding mapping focused planning
       functions.
3. [x] Give Rust builds, Cargo publishing, GitHub assets, native npm packages,
       and Node facades separate workflow job builders.
4. [x] Keep thin Projen adapters that write files, add tasks, and install the
       composed jobs.
5. Move release OS/CPU option vocabulary into the same release-platform source
   used by command-line tasks.

This attacks both the largest generator methods and one of the highest-churn
files without rewriting the repository generator.

### 4. Make documentation derive from real package contracts

Refactor outline:

1. Create one docs package-discovery module shared by README and API generation.
2. [x] Resolve JavaScript API entry points from manifest export maps, not
       generated root barrels.
3. [x] Add Python and Rust API stages and link them from the same package
       catalogue.
4. [x] Remove `--skipErrorChecking` and fail generation on invalid references.
5. Pin the docs toolchain through reviewed root inputs rather than ignored,
   caret-ranged generated dependencies.

This fixes incorrect pages before adding more documentation volume.

### 5. Establish validated and documented public contracts

Refactor outline:

1. [x] Put Mastra stream chunk schemas in `@dbx-tools/shared-mastra` and parse every
       SSE event.
2. [x] Parse universal-search responses with the existing owning schema.
3. [x] Replace `any` reducers with exhaustive discriminated-union handlers.
4. [x] Add a documentation check over manifest-exported handwritten declarations.
5. [x] Document Python Postgres while excluding generated bindings and intentional
       compatibility aliases; shared wire and core package backlogs remain Medium
       work.

Runtime validation and source documentation should come from the same owning
contract, not parallel handwritten descriptions.

## Quick Wins

- [ ] Fix the model metadata task wording in `packages/rs/model/README.md`.
- [ ] Remove unused blanket `@dbx-tools/shared-core` dependencies from the nine
      packages identified by the import scan.
- [x] Resolve the Express type leak in the Tunnel declaration surface.
- [x] Parse universal-search responses with the shared schema.
- [ ] Move release OS, architecture, level, and repeatable option helpers into
      the existing release-platform module.
- [ ] Extract the shared Rust shutdown signal future.
- [ ] Extract the Graphiti `--` forwarding runner.
- [ ] Share docs discovery and markdown-summary helpers.
- [x] Remove `--skipErrorChecking` after API entries follow export maps.
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
3. Should the docs site resolve its toolchain from the root Bun catalogue, or is
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

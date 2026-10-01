# Deep Code Quality, Ownership, and Release Reliability Plan

**Target:** `docs/archived/enhancements/2026-10-01-deep-code-quality-and-reuse-plan.md`
**Status:** Completed and archived on 2026-10-01; Kanna baseline `5221d41a`

## Summary

Prioritize two verified isolation defects, then consolidate Rust release tooling into `@dbx-tools/projen`, make Rust projects first-class Projen projects, remove duplicated model policy, reuse framework-owned contracts, and correct documentation drift.

Before each implementation phase, re-inspect the active diff and preserve concurrent work. Treat the current Projen, Mastra, Better Auth, and compile-reuse edits as work to integrate and validate.

## Progress

- **Phase 1 completed on 2026-10-01.** The auth base path and segment-aware
  predicate now live in `@dbx-tools/shared-auth`; Express and CLI transports use
  the shared boundary, auth WebSocket upgrades are rejected, and lookalike
  application paths remain gated with protected-header stripping. Model
  catalogue caching now requires an opaque credential identity, hashes that
  identity before cache use, isolates OBO and service-principal entries, supports
  scoped eviction, and bypasses shared caching when identity is unknown. AppKit
  Mastra and web search supply their trusted execution-context identity.
- **Phase 4 completed on 2026-10-01.** Local validation and publication reuse a
  single TypeScript compile, package access follows each manifest, every package
  is packed once, and publication uploads the exact archive whose identity and
  content were validated. Stable release versions now use one strict `semver`
  parser; local release preparation and the generated release workflow invoke
  the same validator and reject prefixes, embedded versions, prereleases, build
  metadata, and non-increasing tags.
- **Phase 2 completed on 2026-10-01.** The Rust release helper now has one
  private TypeScript owner in `@dbx-tools/projen` and one generated standalone
  Node artifact. It uses `cargo metadata`, structured TOML, Node crypto, and all
  tracked or unignored files under Cargo-discovered members and configured
  roots, so embedded assets invalidate reuse while workspace-only version bumps
  do not. Native stamping selects the format-specific ELF, PE, or Mach-O
  section, validates the fixed record, updates it through `llvm-objcopy`,
  preserves modes, and re-signs Mach-O output. Release jobs install
  `llvm-tools-preview`. The helper takes an explicit root and imports the narrow
  canonical `@dbx-tools/core/exec` subpath; its bundle fell from 1.1 MB to about
  60 KB. Its declaration is generated from the same owner. Format, malformed
  record, missing section, mode, signing, arbitrary-name/root, asset-change,
  version-only, generated-consumer, and full Projen tests pass.
- **Phase 3 completed on 2026-10-01.** `DBXToolsRustProject` now accepts flat,
  standalone-capable options for Cargo identity, metadata, dependencies,
  features, binaries, bindings, and release behavior. Standalone projects emit
  concrete metadata, their own Cargo workspace boundary, a license, target
  ignores, and native `compile`, `test`, `package`, `lint`, `format`, and
  `format:check` tasks. Workspace discovery constructs the same class with only
  workspace-owned metadata inherited. The positional constructor and initial
  nested object shape remain deprecated compatibility paths, while
  `RustPackageOptions` is an alias of the canonical crate configuration.
  Project, workspace, release-workflow, and generated release-helper ownership
  are now split into focused Projen modules. Standalone synthesis, positional
  compatibility, discovered workspaces, generated workflows, and a packed
  external consumer that compiles and tests the generated Rust project pass.
  Explicit example targets can declare Cargo `required-features`, preventing
  optional generators from breaking ordinary workspace tests.
- **Phase 5 completed on 2026-10-01.** AppKit no longer implements a second Lakebase
  address parser or record. It consumes `@dbx-tools/core-rs`, derives its SSL
  spelling from the generated enum, and retains the existing sparse-object and
  string-mode API through a generated-type projection. SSL validation also
  delegates to the native parser. TypeScript/Python parity, the complete AppKit
  suite, and an isolated packed consumer pass without requiring an unpublished
  native binding revision. Node model lookup and the compatibility
  `resolveModelId`/`searchServingEndpoints` APIs now share the Rust fuzzy ranker;
  `fuse.js` is removed from `@dbx-tools/model`, custom endpoints remain
  searchable, and Rust ranking honors an owner-supplied model class. The Node
  model and Rust model suites pass with identical newest-version selection.
  Cached catalogue classification, tool policy, endpoint capability checks,
  and the static fallback ordering also run through the Rust owner. The
  browser-safe handwritten classification helpers are deprecated for removal
  at the next major release; clients consume the classified `/models` response.
  Rust-owned records and enums now generate committed browser-safe TypeScript and
  zod contracts without initializing native FFI. Shared, Node, UI, Rust, and
  generated-consumer tests pass.
  Node, Python, and Rust App-environment detection now share golden fixtures
  and agree on interpolation rejection, host-bearing HTTP(S) URLs, and decimal
  `u16` ports.
- **Phase 6 completed on 2026-10-01.** Conditional and manual passkey flows now
  share operation ownership, cancellation, and browser-only client behavior in
  React and the hosted tunnel login. Passkey list failures propagate while the
  last successful list is retained. Shared auth owns route contracts and
  predicates, framework types replace handwritten mirrors, and Better Call's
  Node adapters own request/response conversion with interrupted-body failures.
  AppKit, Email, Teams, Web Search, Search, AppKit Mastra, and packed-consumer
  suites pass.
- **Phase 7 completed on 2026-10-01.** Canonical guidance now describes the
  Bun-first workspace, standalone Rust projects, TypeScript-owned release
  helper, Rust-owned model contracts, exact-archive npm publication, and the
  Rust proxy's `aigw_*` adapters. Stale `tsx`, release-unit, compile-stage, and
  TypeScript proxy-translation claims were corrected. Dependency versions were
  left at the already validated stable set from the Kanna baseline.
- **DRY follow-up completed on 2026-10-01.** Shared bounded async mapping,
  Projen command execution, AppKit tool registries/execution adapters, migration
  failure policy, and repository-doc utilities replaced the verified repeated
  implementations. Ordinary Projen path normalization now uses one `toPosix`
  helper. The generated Rust release bundle and generated Bun cache-key script
  retain tiny local path conversion because each must execute as a standalone
  Node program without importing the engine graph.

## Completion record

- `2cc61086` fixed auth-route and model-cache isolation.
- `176d7fd0` published the exact npm archives validated during preflight.
- `5c9a23b8` moved and hardened Rust release tooling in `@dbx-tools/projen`.
- `11599815` made standalone and workspace Rust crates use one project class.
- `4182b8dc`, `d5c21540`, `30d05a85`, `40092a77`, and `1a47077c` restored Rust
  ownership for Lakebase/model behavior, aligned App detection, and generated
  browser-safe model contracts.
- `1e9ca8f8` reused framework auth contracts, Node adapters, and passkey flows.
- `c95e970a`, `d2de66bb`, `930b66dd`, `f1479de9`, and `af56f5ee` consolidated
  the verified bounded-concurrency, process, plugin, migration, and docs helpers.

## Comparison with the Kanna implementation

The Kanna chat completed and its independently validated changes were committed
and pushed before this plan was applied. That baseline completed the model-proxy
metrics work, stable dependency upgrades, conditional passkey initiation, root
publication compile reuse, removal of the private Rust release crate, an
options-object Rust member constructor, and conversion of the Rust workspace to
a Projen `Component`.

At the comparison point, the baseline only partially satisfied this plan. The generated Node release
helper still parses TOML with line/regex logic, fingerprints only Rust/TOML
files, discovers version records by scanning unrestricted binary bytes, and has
no LLVM section tooling. The Rust project class still assumes a Node parent and
workspace-owned metadata and does not own the full standalone crate task model.
Publication still forces public access, repacks after validation, and uses a
different local version parser from CI. Neither isolation defect, model-policy
consolidation, hosted passkeys, passkey cancellation/error propagation,
framework-owned auth contracts, or native Node request adapter reuse was
implemented. The follow-up commits listed below completed those gaps.

## Confirmed DRY and ownership violations

These findings were verified against production source. Generated UniFFI files,
generated barrels, test fixtures, and small test-local command wrappers are not
counted as violations.

| Area                       | Repeated implementation                                                                                                                                                                               | Final disposition                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository/process helpers | `projen/tasks/rust-release.mjs` shells out to `git rev-parse` despite canonical `coreProject.root`; release tasks separately define `run`, `capture`, and `gitCapture` around `@dbx-tools/core.exec`. | Completed in `d2de66bb`: one Projen command utility and explicit roots. Standalone generated helpers keep only their required bundled implementation.             |
| Lakebase address contracts | AppKit handwrites `SslMode`, `ParsedAddress`, URL/resource parsing, and validation already owned by `packages/rs/core` and generated in `@dbx-tools/core-rs`.                                         | Completed in `4182b8dc`: AppKit consumes the generated Rust owner and retains compatibility projections.                                                          |
| Model policy/contracts     | Shared TypeScript repeats Rust model classes, profiles, status, queries, family classification, quantiles, capabilities, normalization, and fuzzy resolution; Node also retains Fuse.                 | Completed across `d5c21540`, `30d05a85`, and `1a47077c`: Rust owns policy and generated browser contracts; handwritten helpers are deprecated compatibility APIs. |
| Auth contracts             | The auth base path is repeated in tunnel and UI; `SendCodeOptions`, `AuthGateApi`, `PasskeySummary`, and AppKit `PluginData` weaken or copy owning types.                                             | Completed in `1e9ca8f8`: shared route contracts and framework-owned type aliases replace the mirrors.                                                             |
| Node/Fetch bridging        | Tunnel and CLI copy request buffering, response headers, cookies, and bodies; input errors currently resolve partial bodies successfully.                                                             | Completed in `1e9ca8f8`: Better Call Node adapters own conversion and interrupted bodies fail.                                                                    |
| Common primitives          | Tunnel duplicates `shared-core` HTML escaping and email validation; Projen and docs repeat POSIX conversion; docs repeat walkers, heading stripping, YAML quoting, and base-path wrappers.            | Completed in `af56f5ee` and this archival change: shared primitives and docs utilities are reused; ordinary Projen path conversion uses `toPosix`.                |
| Plugin execution           | Email, Teams, web search, and search repeat registry-backed `ToolProvider` methods; email/Teams/web search repeat the same `execution.run` failure adapter.                                           | Completed in `930b66dd`: AppKit owns `ToolRegistryPlugin` and `runPluginExecution`.                                                                               |
| Storage migration handling | AppKit cache and AppKit Mastra memory repeat debug checks, ownership-error classification, and warning de-duplication.                                                                                | Completed in `f1479de9`: AppKit owns classification, deduplication, and log policy.                                                                               |
| Documentation utilities    | Multiple docs scripts separately implement file walking, POSIX paths, Markdown H1 removal, YAML string quoting, regex escaping, and package discovery.                                                | Completed in `af56f5ee`: dependency-free repository-doc utilities own the repeated operations.                                                                    |
| Bounded concurrency        | Projen publication, remote-skill staging, and API docs each implement a cursor/worker pool with small semantic differences.                                                                           | Completed in `c95e970a`: shared-core owns ordered fail-fast and settle modes.                                                                                     |

Similar names that are not violations remain separate: uppercase polling Genie
statuses versus lowercase Agent Mode terminal statuses; Rust-source UniFFI
detection versus generated-binding-file detection; language-native database
adapters; generated bindings; and standalone bootstrap code whose generated
artifact has one owning source.

## Implementation plan

### 1. Fix verified isolation defects first

- Replace tunnel authentication’s raw prefix matching with one shared, segment-aware predicate: exact auth path or auth path followed by `/`.
- Apply it consistently to Express requests, CLI proxy requests, login-page decisions, and WebSocket upgrades. Reject upgrades to auth endpoints and strip spoofable identity headers before forwarding any non-auth request.
- Add trusted `cacheIdentity` support to model catalogue/default-model resolution. Key caches by host and opaque credential identity; never log the identity. AppKit supplies its trusted user scope for OBO and a stable plugin-instance scope for service-principal clients. Calls without an identity bypass shared caching.
- Make catalogue eviction identity-aware.

### 2. Move Rust release tooling into `@dbx-tools/projen`

- Replace `packages/rs/release-tools` with TypeScript source inside `@dbx-tools/projen`. Bundle that source into one generated, standalone Node-compatible `.mjs` helper for release jobs; repository development continues to use Bun.
- Install `llvm-tools-preview` in native release jobs. Resolve `llvm-objcopy`, require exactly one recognized version section (`.dbxversion`, `.dbxver`, or `__dbxver`), validate the fixed 128-byte record, and update it with `--update-section`. Preserve file modes and apply ad-hoc signing after Mach-O changes. Do not scan binaries for unrestricted magic-byte matches.
- Rebuild fingerprinting with Node crypto, `smol-toml`, and `cargo metadata`:
  - discover actual workspace members without package-name conventions;
  - hash all relevant files beneath configured crate roots, including embedded JSON, CSS, JavaScript, and other assets;
  - exclude build caches and platform-native output;
  - normalize only workspace-owned versions in Cargo manifests and lock entries;
  - include toolchain, target, features, profiles, binding configuration, and explicit extra build-input globs.
- Remove the private Rust helper only after parity and external-consumer tests pass.

### 3. Make Rust a first-class Projen project type

- Evolve the existing `DBXToolsRustProject`; do not introduce a competing abstraction.
- Add `DBXToolsRustProjectOptions` with `name`, `outdir`, optional `parent`, Cargo metadata, dependencies, features, targets, binary/CLI settings, bindings, UniFFI configuration, release settings, and standalone version/edition/rust-version/license/repository values.
- Support:
  - `new DBXToolsRustProject(options)`;
  - a deprecated positional constructor forwarding to the new options model until the next major release.
- Give every crate project native compile, test, package, lint, format, and format-check tasks. Standalone crates emit concrete package metadata; workspace members inherit only metadata owned by their workspace.
- Convert `DBXToolsRustWorkspace` into a Projen `Component`. It discovers and composes ordinary `DBXToolsRustProject` instances while retaining aggregate workspace tasks, binding orchestration, and release matrices.
- Keep `RustPackageOptions` as a deprecated compatibility alias rather than maintaining a second Cargo schema.
- Split the oversized Rust Projen implementation by project, workspace, release workflow, and release-helper responsibilities while preserving its public barrel.

### 4. Correct release and publication behavior

- Validate the concurrent compile-reuse work so a locally validated release compiles TypeScript once. Direct publication still compiles, and separate clean CI jobs retain independent compilation.
- Respect each package’s resolved npm access setting instead of forcing public access. Continue skipping private packages.
- Pack each selected package once, validate that archive, and publish the same bytes with `bun publish ./archive.tgz`.
- Replace loose version extraction with one strict stable-semver parser using the existing `semver` dependency. Invoke the same Projen validation task from local preparation and generated CI.
- Preserve manifest restoration, modes, provenance, bounded publication concurrency, catalog resolution, and standalone `prepack` behavior.

### 5. Restore single ownership for model policy and contracts

- Keep AppKit’s request-scoped SDK client for transport and OBO identity, but move catalogue normalization, classification, capability policy, ranking, and fuzzy resolution to `packages/rs/model`.
- Export the missing pure operations through `@dbx-tools/model-rs`; route existing Node lookup and resolution APIs through them and remove the remaining Fuse-based implementation.
- Extend binding/code generation so Rust-owned records and enums produce committed, target-independent browser contract/schema modules. Browser packages must not initialize native bindings.
- Return fully classified and capability-stamped `/models` payloads. Retain only presentation predicates and Zod validation in browser-safe packages.
- Deprecate handwritten public classification helpers now and remove them at the next major release.
- Keep the dependency-free Node/Python App-environment detectors, but align them with Rust’s strict semantics through shared golden fixtures: reject interpolated names, require an HTTP(S) URL with a host, and accept only base-10 `u16` ports.

### 6. Reuse authentication and framework-owned surfaces

- Keep React conditional passkey mediation and its manual fallback. Add operation ownership and cancellation for challenge requests, WebAuthn ceremonies, phase changes, explicit authentication, completion, and unmounting.
- Add the same conditional/manual passkey path to the hosted tunnel login through a packaged browser bundle built from the existing Better Auth client logic. Preserve OTP and normalized `returnTo`; add no CDN dependency.
- Propagate passkey-list failures instead of converting them to empty lists. Preserve the last successful list when refresh fails.
- Use a browser-only auth client entry shared by React and the hosted login. Import Better Auth’s `Passkey` type instead of weakening it locally.
- Move the auth route constant and predicate into the browser-safe shared auth package and re-export current public names for compatibility.
- Replace handwritten `SendCodeOptions`, `AuthGateApi`, AppKit `PluginData`, and plugin factory shapes with their owning exports or compatible aliases. Preserve `PluginContextLike`, because AppKit does not publicly export its owner type.
- Replace custom request/response buffering with declared `better-call/node` adapters, supplying the repository’s normalized trusted base URL and origin/IP policy. Interrupted or truncated bodies must fail rather than reaching Better Auth as complete requests.

### 7. Refresh documentation and dependency state

- Update `AGENTS.md` first for Rust project ownership, release-helper placement, model-policy ownership, compatibility periods, and justified dependency-free detector exceptions.
- Update `projen/README.md` and source comments from pnpm/tsx language to current Bun behavior. Correct the documented Projen version and release-stage ownership.
- Correct stale package documentation, including the AppKit Mastra installation command, tunnel login behavior, and claims that TypeScript protocol translation is still used by the Rust model proxy.
- Recheck concurrent stable dependency upgrades before changing manifests. Keep AppKit `0.81.0`, stable Mastra releases, Better Auth/passkey `1.7.6`, and Projen `0.103.27` unless a newer stable compatible release exists. Do not follow Mastra alpha `latest` tags.
- Keep the root README focused on Databricks developer value and continue generating the site from canonical READMEs.

## Public API and compatibility changes

- Add `DBXToolsRustProjectOptions`; make the options-object constructor canonical.
- Change `DBXToolsRustWorkspace` to extend `Component`.
- Deprecate the positional Rust constructor and `RustPackageOptions` compatibility surface until the next major release.
- Add opaque `cacheIdentity` to catalogue/default-model operations; absent identity disables shared caching.
- Re-export framework-owned types under existing public names where required.
- Deprecate shared TypeScript model classification helpers until the next major release.
- Preserve wire field names and serialized enum values during generated-contract migration.

## Validation and acceptance

- **Tunnel:** test exact auth routes, nested auth routes, similar prefixes, spoofed forwarded headers, HTTP requests, and WebSocket upgrades through both Express and CLI transports.
- **Model cache:** cover A→B, B→A, concurrent A/B misses, same-identity coalescing, OBO separation, service-principal sharing, separate hosts, scoped eviction, and no-identity bypass through `/models` and `/default-model`.
- **Rust release tooling:** exercise ELF, Mach-O, and PE section updates; malformed/missing/duplicate sections; mode preservation; Mach-O signing; unrelated crate names; custom roots; embedded-asset invalidation; version-only reuse; and toolchain/target/feature invalidation.
- **Projen consumers:** synthesize standalone libraries, binaries, discovered and explicit workspace members, custom names/roots, aliases, UniFFI crates, and release-enabled packed external consumers without access to this repository’s private crates.
- **Publication:** assert one compile for validated local releases, one pack per package, exact-archive publication, public/restricted/private access behavior, retry identity checks, restoration after failure, and identical local/CI semver decisions.
- **Model ownership:** run shared golden fixtures across Rust and Node for aliases, retirement data, GPT variants, Qwen versions, embeddings, custom endpoints, missing scores, ties, and exact IDs. Add a browser bundle check proving shared contracts load no native FFI.
- **Authentication:** test conditional and manual passkeys, unsupported browsers, capability rejection, cancellation, Strict Mode, hosted non-React login, OTP fallback, preserved navigation, list 401/500/network failures, interrupted request bodies, cookies, redirects, and disconnects. Include one browser test with a virtual authenticator.
- Run targeted Projen tasks through Bun, Rust tests through Cargo, packed-consumer tests, generated-file checks, README synchronization, link checks, and API documentation generation.

## Explicit non-targets

- Keep the manual passkey control as a fallback; browsers cannot reveal whether a credential exists.
- Keep shared, Node, UI, Rust, and Python package boundaries where they isolate real runtime or dependency concerns.
- Treat generated UniFFI bindings as generated artifacts, not handwritten duplication.
- Keep language-native database adapters and dependency-free bootstrap helpers where native installation would be disproportionate.
- Preserve AppKit/Mastra lifecycle, identity, sandbox, and async toolkit extensions that have no equivalent installed native surface.
- Avoid speculative package merging or large-file rewrites beyond the concrete ownership extractions above.

## Final validation

- `bunx projen`, the root TypeScript compile, lint, and complete JavaScript test
  fan-out passed, including 195 Projen tests and the packed external consumer.
  Bun 1.3.14 still prints its known post-test segmentation-fault report after the
  `shared-core` assertions finish while returning success; the changed async
  test also passes directly.
- `cargo test --workspace --offline` passed across every Rust crate. The run
  exposed and verified the new feature-gated Cargo example support.
- Model contracts, model-proxy metrics assets, release fingerprints, and all
  workspace versions regenerated and validated successfully.
- API docs generated for 51 packages, the Starlight build produced 2,555 pages,
  and the link checker validated 5,688 built files without network requests.

Update this enhancement document in place as findings are completed, and move it to `docs/archived/enhancements` only when the tracked work is completed or intentionally abandoned.

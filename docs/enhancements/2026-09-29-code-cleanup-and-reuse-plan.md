# Code cleanup, library reuse, and package architecture plan

Date: 2026-09-29

Status: In progress. Batch A correctness, native toolkit reuse, Projen consumer
contracts, and external archive validation are complete.

Scope: handwritten JavaScript/TypeScript, Python, Rust, package boundaries,
Projen configuration, and consumption of the generator outside this repository.
This document proposes changes; it does not replace the current instructions in
`AGENTS.md` or authorize package removals, publication, or release changes.

Snapshot: the review began at `79b9fb05` and was reconciled against
`da8898d80c61376a2e8137014430d5262adb0068` (0.6.221). Concurrent work completed
the native Mastra transport and Rust model-policy consolidation. Those completed
changes are excluded from the remaining work below. Line citations describe
this snapshot and should be refreshed as implementation proceeds.

## Executive assessment

- **There is useful cleanup to do, but little evidence for a broad DRY rewrite.**
  The selected-source duplication scan found 73 repeated lines out of 90,634
  scanned lines, approximately 0.08%. Two of its three clones are Rust test
  blocks. Repeated policy and competing contracts are more consequential than
  repeated syntax.
- **Fix correctness before reducing line count.** Bun and Node can choose
  incompatible locking protocols for the same key; Python Lakebase handling
  misses pagination and the actual credential expiry field; Graphiti gives
  Mastra empty schemas while its MCP endpoint uses real schemas.
- **Restore the authentication library's origin boundary.** The current
  Better Auth wrapper trusts whichever Origin the request supplies. Supporting
  several legitimate tunnel hosts requires a configured trust set, not this
  unrestricted callback.
- **The Projen engine is reusable in intent but has reproducible consumer
  failures.** A standalone TypeScript root throws at construction; explicit
  output directories do not consistently determine workspace identity; release
  credentials assume the repository owner is the authenticated GitHub account.
- **Some custom machinery now has a verified native replacement.** Use
  Projen `TomlFile`, `TypescriptConfig`, and `BuildWorkflowOptions.buildTask`; public
  Better Auth migration APIs; AppKit toolkit types; the Python Postgres SDK;
  and the already-installed HTML/SSE parsing libraries.
- **Mastra reuse is substantially better than the older audits suggest.**
  Current chat transport, approval continuation, memory routes, and thread
  clients already use upstream surfaces. Finish the remaining compatibility
  edges instead of proposing that migration again.
- **Reduce dependency reach before reducing package count.** Graphiti imports
  binary installation from the entire CLI package. Extracting that small runtime
  seam is more valuable than merging browser, Node, Python, and Rust packages.
- **Keep one published Projen package.** Split its internal responsibilities
  and move repository-specific policy into this repository's configuration.
  Additional generator packages would add release complexity without an
  established dependency benefit.

## Architectural model

The runtime product is a set of Databricks companion libraries. Browser-safe
schemas and utilities form the shared layer, Node packages provide AppKit and
service integrations, and React packages supply matching UI. Rust owns native
authentication, model policy, and proxy binaries; generated bindings expose the
appropriate native contracts. Python retains framework-specific integrations
and a small dependency-free core. Most package boundaries protect consumers
from a different runtime or a substantial optional dependency.

Projen is the authoring and publication layer. Root `.projenrc.ts` declares
product policy and package dependencies; the reusable engine discovers packages,
constructs projects, generates metadata and entrypoints, and composes a polyglot
release graph. The main architectural problem is that some reusable engine
operations still infer this repository's paths and policy. The runtime analogue
is a few module-global plugin runtimes that assume only one app exists per
process. Both problems are ownership issues, not reasons to create another
framework.

## Findings register

All findings are open unless marked **decision**. High means an observed
correctness failure, trust-boundary weakness, or blocked supported use case;
Medium means material maintenance/reuse risk; Low means bounded cleanup.
Effort: S is roughly up to one engineering day, M is several days, and L is a
design or migration effort likely to exceed a week. These are planning bands,
not delivery estimates. Every implementation includes its acceptance checks.

| ID  | Category                         | Evidence: repository path and line                                                                                                                                    | Severity | Effort | Finding and disposition                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | Correctness / library evaluation | `packages/js/node/core/src/file-lock.ts:113`, `:161`, `:223`                                                                                                          | High     | M      | **Completed 2026-09-29.** Bun and Node now default to one `proper-lockfile` directory protocol with heartbeat, stale recovery, ownership-safe release, wait deadlines, and bidirectional process contention coverage. Explicit legacy `flock` remains available; operators must drain old default-flock processes during transition.                                                                  |
| F02 | Library trust boundary           | `packages/js/node/auth-gate/src/auth.ts:79`, `packages/js/node/tunnel/src/gate.ts:219`, `packages/js/node/auth-gate/test/auth.test.ts:163`                            | High     | M      | **Completed 2026-09-29.** Auth accepts the configured base/overlay origins, rejects arbitrary Origin and Referer values at the wrapper boundary, and automatically recognizes HTTPS Databricks Apps front doors without changing the configured WebAuthn RP ID/origin.                                                                                                                                |
| F03 | Reinvented SDK / correctness     | `packages/py/postgres/src/dbx_tools/postgres/engine.py:174`, `:360`, `:394`                                                                                           | High     | M      | **Completed 2026-09-29.** Autoscaling discovery and credential minting use typed paginated `WorkspaceClient.postgres` methods and `DatabaseCredential.expire_time`; the generated SDK floor is `>=0.123.0`. Focused ruff and ten engine tests pass, including pagination and workspace-id transport.                                                                                                  |
| F04 | DRY / tool contracts             | `packages/js/node/appkit-graphiti/src/plugin.ts:227`, `:285`, `:307`                                                                                                  | High     | M      | **Completed 2026-09-29.** One discovered permitted registry now supplies the MCP and Mastra surfaces. Async toolkit registration waits for bounded discovery and forwards upstream descriptions and JSON schemas; startup failure and cancellation are covered.                                                                                                                                       |
| F05 | Projen external reuse            | `projen/src/project-js.ts:713`, `:1202`, `projen/src/tsconfig.ts:46`                                                                                                  | High     | M      | **Completed 2026-09-29.** Standalone TypeScript roots reuse Projen's native compiling configs and receive the same workspace, root tasks, metadata, install policy, and release setup as Node roots. Native `TypescriptConfig` owns non-compiling root configs.                                                                                                                                       |
| F06 | Projen external reuse            | `projen/src/packages.ts:37`, `projen/src/project-js.ts:149`, `:809`, `projen/src/codegen.ts:129`                                                                      | High     | M      | **Completed 2026-09-29.** Explicit `outdir` now drives identity, Git metadata, discovery, codegen, and barrels. External fixtures construct and synthesize roots outside the source workspace.                                                                                                                                                                                                        |
| F07 | Release portability              | `projen/tasks/release-pr.ts:103`                                                                                                                                      | High     | S–M    | **Completed 2026-09-29.** Release preparation parses repository host/owner/name separately, asks `gh` for the active token on that hostname without treating owner as actor, and carries `GH_HOST` for enterprise operations. Organization and enterprise fixtures pass.                                                                                                                              |
| F08 | Projen API contract              | `projen/src/project-js.ts:518`, `:614`, `projen/src/release.ts:368`                                                                                                   | Medium   | M      | **Completed 2026-09-29.** Public modes are the unified `"dbx-tools"` default and `"disabled"`. Inherited `release`/`releaseTrigger` are excluded, native release is forced off, and disabled mode omits workflow and release tasks across Node, Python, and Rust composition.                                                                                                                         |
| F09 | Native AppKit reuse              | `packages/js/node/appkit-mastra/src/agents.ts:197`, `:929`, `:950`, `packages/js/node/appkit-graphiti/src/plugin.ts:69`                                               | Medium   | M      | **Completed 2026-09-29.** Toolkit contracts come from `@databricks/appkit/beta`. The narrow adapter supports explicit sync/async toolkits and plain `getAgentTools()` providers, preserves filtering/renaming, maps mutating annotations to Mastra approval, and passes the trusted resource id through the local fourth execution argument.                                                          |
| F10 | DRY / runtime ownership          | `packages/js/node/appkit-web-search/src/runtime.ts:56`, `packages/js/node/teams/src/runtime.ts:58`, `packages/js/node/search/src/runtime.ts:31`                       | Medium   | M      | Repeated global runtime holders combine first-instance configuration with later-instance executors. Give each plugin ownership of its runtime before sharing lifecycle helpers.                                                                                                                                                                                                                       |
| F11 | Parser library reuse             | `packages/js/node/appkit-web-search/src/html-text.ts:21`, `:34`, `:40`, `packages/js/node/appkit-web-search/src/scrape.ts:52`                                         | Medium   | S–M    | **Completed 2026-09-29.** Direct `html-to-text` and `entities` dependencies own page/fragment conversion and complete entity decoding; Cheerio selectors own DuckDuckGo extraction. Fixtures cover quoted delimiters, malformed markup, inactive content, entity forms, attribute order, and redirects.                                                                                               |
| F12 | Parser reuse / accounting        | `packages/rs/model-proxy/src/stream.rs:43`, `:148`, `packages/rs/model-proxy/src/throttle.rs:123`                                                                     | Medium   | M      | **Completed 2026-09-29.** Native pass-through usage is read from complete framed SSE events and parsed JSON while original chunks remain byte-for-byte unchanged. Per-event observation is capped at 1 MB, with malformed/oversized streams retaining estimates. Fixtures cover chunk boundaries, CRLF, multiline data, whitespace, null/nested usage, large events, truncation, and malformed bytes. |
| F13 | Cross-runtime contract           | `packages/py/core/src/dbx_tools/core/config.py:450`, `:526`, `packages/js/node/core/src/config.ts:34`                                                                 | Medium   | M      | The Python YAML subset disagrees with Node's parser on valid quoted values with comments and YAML 1.2 scalar semantics. Add parity fixtures; choose an optional parser adapter or a clearly bounded supported subset. **Decision required before adding a core dependency.**                                                                                                                          |
| F14 | Projen policy separation         | `projen/src/release.ts:20`, `:289`, `projen/src/project-js.ts:1244`, `projen/tasks/release-pr.ts:132`                                                                 | Medium   | M      | **Completed 2026-09-29.** Reusable options now accept docs preparation/build/artifact hooks, an optional Python publication root, optional PR-title policy, cache-ignore outputs, and declared tooling members. This repository supplies its docs paths, `packages/py`, title rules, `.docs-build`, and `projen` member explicitly; external fixtures cover disabled/custom policy. |
| F15 | Native Projen reuse / DRY        | `projen/src/project-rs.ts:393`, `projen/src/project-py.ts:118`, `projen/tasks/publish-python.ts:25`, `projen/tasks/uniffi-release.mjs:413`                            | Medium   | M      | **Completed 2026-09-29.** Cargo, target, and UniFFI TOML use structured Projen `TomlFile` objects; native `PyprojectTomlFile` owns generated Python formatting. Publication stamping parses TOML, mutates versions/dependencies structurally, verifies semantic output, and restores original bytes on success or failure.                                                                            |
| F16 | Native Projen reuse              | `projen/src/project-js.ts:854`, `:693`, `:1404`                                                                                                                       | Medium   | M      | **Completed 2026-09-29.** The PR workflow runs an explicit `pr:validate` task through the public `BuildWorkflow` `buildTask` option. Private NodeProject access is isolated to setup, coverage, and assignment hooks with no public setter or equivalent.                                                                                                                                             |
| F17 | Semantic duplication             | `projen/tasks/uniffi.ts:264`, `projen/tasks/uniffi-release.mjs:429`                                                                                                   | Medium   | M      | **Completed 2026-09-29.** Local and release Python bindings share dependency-free `uniffi-python.js` for generator naming and arguments, headers, package placement, empty initialization, library copying, and cleanup. Local/release output parity and Windows naming are covered.                                                                                                                  |
| F18 | External-consumer validation     | `projen/test/root-install.test.ts:46`, `projen/test/tasks.test.ts:34`, `projen/tasks/publish.ts:253`, `projen/src/project-js.ts:780`, `projen/.projenrc.ts:133`       | Medium   | M      | **Completed 2026-09-29.** Explicit Node/TypeScript roots and a freshly packed engine run outside the source workspace through real post-synth, install, codegen, deterministic re-synth, compile, test, and pack. PATH uses `path.delimiter`, test discovery uses Bun's portable no-tests option, and the missing demo task is removed.                                                               |
| F19 | Package dependency reach         | `packages/js/node/appkit-graphiti/src/plugin.ts:26`, `packages/js/cli/dbx-tools/src/rust-binary.ts:10`, `packages/js/cli/dbx-tools/package.json:29`                   | Medium   | M      | **Completed 2026-09-29.** `@dbx-tools/rust-binary` owns generated command metadata, platform selection, exact-version installation, and process forwarding. Its manifest has one direct internal dependency and reaches only `core` plus `shared-core`; Graphiti no longer reaches the CLI graph. `@dbx-tools/cli/rust-binary` remains an exact compatibility re-export, with missing-platform and signal-exit behavior covered. |
| F20 | Public library API               | `packages/js/node/auth-gate/src/storage.ts:42`, `:132`, `:158`                                                                                                        | Medium   | S      | **Completed 2026-09-29.** Auth storage imports `getMigrations` from Better Auth's public `better-auth/db/migration` export while retaining the existing Postgres advisory lock, portable local file lock, and concurrent-startup coverage.                                                                                                                                                            |
| F21 | Native platform API              | `packages/js/shared/core/src/async.ts:192`, `:222`                                                                                                                    | Low      | S      | **Completed 2026-09-29 after re-evaluation.** Supported Bun, Node, and browser floors provide `AbortSignal.any`; the optional facade preserves zero/one-signal shortcuts and delegates multi-signal listener ownership to the platform. Existing reason and propagation tests pass.                                                                                                                   |
| F22 | Dead code / docs                 | `packages/js/node/appkit-mastra/src/_agent-route-context.ts:1`, `packages/js/node/appkit-mastra/src/pagination.ts:21`, `packages/js/node/appkit-mastra/README.md:963` | Low      | S      | **Completed 2026-09-29 after re-evaluation.** The test-only private route-context helper and its test are deleted. Public pagination helpers remain exported with explicit deprecation toward native Mastra memory inputs; the module map no longer lists removed route modules.                                                                                                                      |
| F23 | Single-source types              | `packages/py/postgres/src/dbx_tools/postgres/address.py:14`, `packages/py/postgres/src/dbx_tools/postgres/engine.py:545`                                              | Low      | S      | **Completed 2026-09-29 after re-evaluation.** Python aliases the generated core-rs `SslMode`, derives accepted values from the enum, retains it through resolved connection state, and renders the driver string only in the SQLAlchemy URL boundary.                                                                                                                                                 |
| F24 | Durability design review         | `packages/py/graphiti/src/dbx_tools/graphiti/persistence.py:229`, `:264`, `:336`, `packages/py/graphiti/tests/test_persistence.py:207`                                | Medium   | L      | The journal intentionally records attempted writes. Commit failures, driver retries, invalid-entry recovery, and non-idempotent replay need a stated contract and fault tests. **Design spike; not a proven removable library duplicate.**                                                                                                                                                            |
| F25 | Instruction drift                | `AGENTS.md:991`, `:1087`, `:1310`, `docs/enhancements/README.md:4`                                                                                                    | Low      | S      | **Completed 2026-09-29 after re-evaluation.** Canonical instructions describe explicit shared-core dependencies, ESLint 9 check/fix tasks, and one complete-or-abandoned archive rule; the enhancements index uses the same lifecycle.                                                                                                                                                                |

## Top five implementation priorities

### 1. Make shared locks use one protocol (F01)

`withFileLock` selects `.flock` on Bun/Unix and `.lock` on Node or when FFI is
unavailable. A local probe held the former and acquired the latter for the same
key before releasing it. The callback overlap was observed, not inferred.
Existing tests exercise contention within a backend, not interoperability.

Refactor outline:

1. Define which processes must coordinate for binary installation, auth
   migrations, and cached state. Choose a canonical protocol independent of
   whichever runtime starts a process.
2. Evaluate `proper-lockfile` for portable directory locking, including stale
   detection, heartbeat compromise, cancellation/deadline adaptation, and file
   ownership. It is a candidate, not a verified drop-in or an installed dependency.
3. Retain the small dbx-tools key/deadline facade. Do not add native bindings to
   all Node consumers solely to remove this implementation.
4. Define a transition for running older processes. Changing the default alone
   does not coordinate a new process with an old process using the other lock.
5. Include cleanup safety when ownership changes after stale recovery; the
   current directory backend unconditionally removes its path on exit.

Acceptance: actual Bun and Node child processes using the default API cannot
overlap; crashes release/recover locks; timeout and long-running operations work;
an old owner cannot delete a replacement owner's lock. Keep all fixtures in
temporary directories. Preserve native Rust `fs4` locking where it already owns
the data; do not assume different language key formats coordinate automatically.

### 2. Make the Projen public consumer contract executable (F05–F08, F18)

Constructor probes reproduced duplicate `tsconfig.json`, duplicate
`GithubWorkflow#release`, and the wrong repository URL for an explicit external
`outdir`. Those are stronger evidence than the size of `project-js.ts`.

Refactor outline:

```text
DBXToolsNodeProject / DBXToolsTypeScriptProject
  -> shared root-workspace component
  -> explicit root passed to discovery and generation
  -> existing native TypescriptConfig, when present
  -> explicit release mode and validation task
```

Keep cwd inference at CLI entrypoints. Do not require consumers to `chdir` before
using library constructors. Derive repository directories from `project.root`,
not the immediate parent. Let `gh` resolve the current actor for the repository
host; repository owner and actor are separate values.

Add one packed-engine fixture outside the source workspace with an unrelated
cwd, custom scope, custom JS/Python roots, and no local `projen/` directory. Run
real post-synth hooks, two deterministic synths, compile, tests, and pack without
publishing. It must resolve dependencies from its archive/manifests rather than
source-workspace links. Add organization, collaborator, and enterprise remotes
as mocked command cases. Exercise GitHub/release enabled and disabled combinations.

Check the minimum declared Projen version and the installed/tested version;
record the minimum version of each adopted API instead of relying on a permissive
caret range. A latest-version canary can be added when available.

### 3. Replace Python Lakebase transport with its owning SDK (F03)

The installed SDK parses `DatabaseCredential.expire_time`; the local helper
returns no expiry for that payload and falls back to a 50-minute cache duration.
A fake first project page with `next_page_token` is also treated as the entire
workspace, so it can be incorrectly considered unambiguous.

Replace `_get`, `_list`, raw credential POST, and response dictionaries with
typed `WorkspaceClient.postgres` methods. Preserve dbx-tools' resource selection,
credential refresh coordination, SQLAlchemy integration, and injectable
credential providers. Keep provisioned compatibility until intentionally retired.
Change the SDK floor in `.projenrc.ts`, then synthesize the manifest; test the
chosen floor, not just installed SDK 0.123.0.

Acceptance: real-shaped `expire_time` fixtures, short-lived tokens, multipage
projects/endpoints/databases, ambiguous-resource rejection, SDK workspace-id
headers, sync/async connection behavior, and custom credential providers. The
current tests passing is insufficient because their fake responses reproduce
the handwritten contract instead of the actual SDK/API contract.

### 4. Use one Graphiti tool registry and native AppKit contracts (F04, F09)

Mastra currently receives `{ type: "object", properties: {} }` for Graphiti
tools. The MCP facade already retains discovered descriptions and input schemas.
Make the discovered, permitted, group-scoped tools the source of both views.

Resolve readiness explicitly: the existing toolkit callback is synchronous and
agent tools are resolved at startup, while sidecar discovery is asynchronous.
Await readiness at registration or use Mastra's native dynamic tools surface.
Do not introduce a handwritten snapshot of upstream schemas to avoid the timing
problem. Readiness must include successful MCP discovery with bounded timeout,
cancellation, and failure handling; the existing startup promise only launches
processes. Native dynamic tools are supported, but this wrapper currently resolves
its tools callback once and checks approval/storage at startup
(`packages/js/node/appkit-mastra/src/agents.ts:832`, `:586`, `:635`). A dynamic
adapter must preserve those callback and approval guarantees. Evaluate native
`listToolsets()` to avoid stripping namespace prefixes.

Import AppKit's public `ToolkitOptions`, `ToolkitEntry`, `ToolProvider`, and
annotation types. Preserve the real local extension: passing the trusted Mastra
resource id to the executor. Native AppKit recognizes providers exposing
`getAgentTools()` and `executeAgentTool()` without `.toolkit()`; the local adapter
must handle those too. AppKit's resolver implementation is not publicly exported
in the inspected version, so keep one small supported adapter rather than deep
importing an internal implementation.

Acceptance: a fixture MCP server's required fields/descriptions appear on both
surfaces; invalid input fails; valid input reaches the tool; forced user groups
remain isolated; cancellation and sidecar failure work. Plain native ToolProvider
fixtures and explicit-toolkit fixtures both work, including filtering, renaming,
and annotations. Specify approval translation rather than changing it as a side
effect of importing a larger annotation type.

### 5. Preserve legitimate auth hosts without trusting arbitrary Origin (F02)

The runtime returns the request's own Origin in `trustedOrigins`. Login routes
are intentionally open before authentication. A local cookie-bearing request
with an unrelated Origin returned 200 from native sign-out through this wrapper.
This verifies loss of the origin restriction; it is not a claim of a demonstrated
account takeover or a browser exploit across every cookie configuration.

Pass a configured set of accepted origins from the tunnel/runtime owner. Include
known local or overlay origins explicitly where supported. Keep the WebAuthn RP
ID and expected origin derived from trusted configuration. Preserve Better
Auth's native session, OTP, passkey, and CSRF machinery.

Acceptance: configured public/overlay origins succeed; arbitrary Origin and
Referer values fail on protected auth actions; cookie-bearing and first-login
cases are both covered; missing-Origin handling follows the chosen server-client
contract. Replace the existing unrestricted-origin test with positive and
negative trust-set tests. Also cover compatibility logout routes, which call the
library API directly and need deliberate CSRF/method semantics.

## Native-library replacement decisions

These decisions are based on inspected installed declarations/source. A library
appearing transitively is not permission to rely on an undeclared dependency.

| Current responsibility                         | Verified upstream surface                                                                                                                                                                                        | Decision / boundary to preserve                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better Auth migration URL and module assertion | Better Auth 1.7.3 exports `better-auth/db/migration`; `getMigrations` imported successfully. Declaration: `node_modules/better-auth/dist/db/get-migration.d.mts:30`.                                             | Adopt directly (F20); preserve the existing Postgres/local migration locks. Use native module types for conditional Bun imports instead of handwritten mirrors where available.                       |
| AppKit toolkit types and provider resolution   | AppKit 0.60.0 exports types from `@databricks/appkit/beta`, `node_modules/@databricks/appkit/dist/beta.d.ts:20`; native fallback is in `node_modules/@databricks/appkit/dist/core/agent/toolkit-resolver.js:22`. | Adopt public types (F09); keep the minimum adapter until a public resolver exists. Do not add a private deep import.                                                                                  |
| Graphiti MCP discovery                         | Mastra MCP 2.1.0 `listTools()` and `listToolsets()`, `node_modules/@mastra/mcp/dist/client/configuration.d.ts:636`.                                                                                              | Reuse discovered schemas and group-scoped wrappers (F04), not an unscoped upstream tool set.                                                                                                          |
| HTML text/entities/selectors                   | Installed `html-to-text` 9.0.5 and `entities` 4.5.0 correctly handled the local malformed/quoted-attribute fixtures.                                                                                             | Declare a direct parser/converter dependency in the feature package (F11). Keep URL policy, text limits, scripts/styles removal, and whitespace behavior. No browser automation dependency is needed. |
| Native SSE usage observation                   | `eventsource-stream` 0.2 and `aigw-openai` 0.6.0 are already dependencies; framing is used at `packages/rs/model-proxy/src/stream.rs:180`.                                                                       | Use complete events plus JSON parsing (F12). Preserve exact downstream bytes, bounded observation memory, backpressure, cancellation, and exactly-once reconciliation.                                |
| Python Autoscaling API                         | Installed databricks-sdk 0.123.0 `.venv/lib/python3.11/site-packages/databricks/sdk/service/postgres.py:1286` owns credential expiry, `:6495` credential generation, and `:6997` paginated branch iteration.     | Adopt (F03). Verify required methods on the new declared minimum; the current `>=0.63.0` is insufficient evidence of compatibility.                                                                   |
| Signal combination                             | `AbortSignal.any` works in the installed Bun runtime; declarations and supported browser/Node floors still need a compatibility check.                                                                           | Preserve zero/one-signal shortcuts; use native combination for multiple signals (F21). This does not automatically replace every operation that mutates an existing AbortController.                  |
| Filesystem locking                             | `proper-lockfile` is a maintained candidate; not installed or audited in this pass.                                                                                                                              | Evaluate against F01 acceptance before selecting it. Fix protocol ownership even if the final implementation remains small and local.                                                                 |
| Python YAML subset                             | Node already uses `yaml`; Python core intentionally has no runtime dependencies.                                                                                                                                 | Design decision (F13). Optional maintained parser/extra or clearly constrained syntax; do not add PyYAML to the base without resolving YAML 1.2 compatibility and install cost.                       |

F11 fixtures must include quoted `>` in attributes, decimal/hex/unknown/invalid
entities, malformed HTML, nested blocks, scripts/styles, and anchor attribute
order. F12 fixtures must include arbitrary chunk boundaries, CRLF, multiline
SSE data, `usage: null`, whitespace before JSON colons, unrelated nested usage,
large terminal events, disconnects, and failed upstream streams.

F13 already has two concrete parity failures: `value: "literal" # comment`
loads in Node but disappears in Python, and YAML 1.2 `value: yes` is a string in
Node but becomes an unusable boolean in the Python subset. Shared fixtures should
pin documented semantics before selecting a parser or changing the contract.

## What Projen already provides

Installed Projen **0.101.37** was inspected. The engine requests **^0.101.16**;
that is a range, not the exact installed version. Latest public registry metadata
was unavailable, so this plan makes no assertion about the newest published
release.

| Concern                         | Native capability / source                                                                                           | Recommendation                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm workspace YAML/catalogs    | `javascript.PnpmWorkspaceYaml`                                                                                       | Already adopted. Keep state needed for late discovery and the Bun mirror; do not rewrite this subsystem.                                                                                                            |
| Bun trusted dependencies        | `NodePackage.addAllowedScripts` / `removeAllowedScripts`, `node_modules/projen/lib/javascript/node-package.d.ts:707` | Already adopted. Keep only mapping from the shared allowance model.                                                                                                                                                 |
| Python and uv metadata          | `PythonProject`, `Uv`, `PyprojectTomlFile`, `node_modules/projen/lib/python/uv.d.ts:14`                              | Already adopted. Workspace/git dependency policy remains a useful extension.                                                                                                                                        |
| Cargo and other TOML files      | `TomlFile`, `node_modules/projen/lib/toml.d.ts:15`                                                                   | Replace the custom TextFile emitter with nested objects/arrays (F15). No verified native Cargo/UniFFI release component replaces the whole Rust layer.                                                              |
| Root TypeScript configuration   | `TypescriptConfig` / `TypescriptConfigExtends`, `node_modules/projen/lib/javascript/typescript-config.d.ts:5`        | Reuse/compose the existing config instead of adding colliding raw JsonFiles (F05).                                                                                                                                  |
| Build validation workflow       | `build.BuildWorkflow` with public `buildTask`, `node_modules/projen/lib/build/build-workflow.d.ts:39`                | Create the workflow around a validation task (F16); remove readonly-step casts and exact-name replacement. Preserve configured pre/post steps and anti-tamper behavior.                                             |
| Mixins and tree traversal       | constructs mixins, `Construct.with`, `node.findAll`                                                                  | Already used. Small package predicates and tag ergonomics are useful extensions.                                                                                                                                    |
| Publishing                      | Native `Release` / `Publisher`, `node_modules/projen/lib/release/publisher.d.ts:98`                                  | Not equivalent to this reviewed VERSION, Cargo/UniFFI artifact graph, local registries, per-distribution environments, and recovery behavior. Keep orchestration; evaluate an npm-only preset separately if needed. |
| Root-only installs              | Protected install method; no verified public root-only switch                                                        | Isolate and test the narrow compatibility adapter. Seek a public upstream option; do not claim this hook can simply be deleted.                                                                                     |
| Source-to-published entrypoints | TypeScript extension rewriting plus Bun packaging                                                                    | Keep native compiler support. Retain necessary publish-map projection until an actual packed-consumer test proves Bun handles the required semantics.                                                               |

For F15, accept native deterministic TOML formatting after verifying parsed
semantic equivalence. Cover Cargo `[[bin]]`, target-specific tables, features,
UniFFI sections, Python dependencies, and restoration after temporary publication
stamps. Use the existing TOML parser for runtime edits. Rust release rows must
remain able to run their standalone scripts without an incidental npm/Bun install.

The current `AGENTS.md` explicitly requires Python TOML normalization. If the
team accepts deleting the formatting patch, change that canonical rule first in
the implementation PR. Do not silently violate it during the refactor.

For F14/F16, keep generic release task/step/output hooks in the engine and move
this repository's docs layout and reduced PR validation policy into `.projenrc.ts`.
Avoid turning every default into an option: retain an explicit Databricks/Bun
preset, while making repository-specific paths and policies replaceable.

Internally separate root workspace setup, package policy, workflows, and
compatibility hooks in `project-js.ts`; separate manifest data/rendering and
release composition in `project-rs.ts` as these findings are fixed. Split root
authoring configuration into a few local modules for JS policy/catalogs,
Rust/Python configuration, and docs/branding. Preserve one authoring source for
each fact; do not generate dependency declarations from import scans.

## Package consolidation decisions

Consumer counts below are internal evidence, not proof of external usage. A
public export with no internal callers still needs a compatibility decision.

| Packages / boundary                                   | Decision                                                        | Reason and prerequisites                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@dbx-tools/cli` binary helpers and `appkit-graphiti` | **Extract a narrow runtime seam (F19).**                        | Graphiti's CLI edge reaches 12 additional workspace packages in the inspected manifest graph, including tunnel, email, auth, and native auth bindings. A smaller dependency is justified even if package count rises by one. Keep generated binary metadata in one owner and re-export the old CLI subpath during transition.                                               |
| `cli-auth`, `cli-appkit-env`, `cli-tunnel`            | **Conditional consolidation; not a first batch.**               | The umbrella CLI already depends on all three and loads commands lazily (`packages/js/cli/dbx-tools/src/cli.ts:127`). Merging can reduce release bookkeeping, but direct consumers may currently avoid unrelated dependencies. Inventory public entrypoints and compare isolated install graphs before choosing. Preserve command names/subpaths and announce deprecations. |
| `node/fs` and `shared/fs`                             | **Keep.**                                                       | Node filesystem access and browser-safe filesystem contracts are distinct runtime boundaries. One internal Node consumer does not justify exposing Node dependencies to shared users.                                                                                                                                                                                       |
| `node/genie` and `appkit-mastra`                      | **Keep.**                                                       | Genie streaming has a supported non-Mastra backend use case. Mastra integration should depend on that driver, not absorb it.                                                                                                                                                                                                                                                |
| Node/shared/UI feature triplets                       | **Keep.**                                                       | These isolate browser contracts from server credentials, SDKs, persistence, and React. Merge internal helpers within their owning package where useful.                                                                                                                                                                                                                     |
| `shared/email-template`, `email`, `ui-email`          | **Keep.**                                                       | Shared React Email presentation is used on server and browser; SMTP/runtime behavior remains server-specific.                                                                                                                                                                                                                                                               |
| `node/path`, `databricks-zerobus`                     | **Keep.**                                                       | They isolate glob/watch dependencies and the Zerobus SDK, respectively. Small source size is not a removal criterion.                                                                                                                                                                                                                                                       |
| Rust crates and generated native facades              | **Keep.**                                                       | They separate auth, Google, model policy, binaries, and platform artifacts. Generated repetition is not hand-maintained DRY debt. The new model binding consolidates policy and is already completed work.                                                                                                                                                                  |
| Python core, Postgres, Graphiti                       | **Keep.**                                                       | Dependency-free helpers, SQLAlchemy/SDK integration, and the graph runtime have different installation costs and consumers. Share fixtures for common semantics rather than merging distributions.                                                                                                                                                                          |
| `@dbx-tools/projen`                                   | **Keep one published package; consolidate internal ownership.** | Most parts share lifecycle, metadata, and release state. Separate internal components and repo-only configuration, not several new versioned packages.                                                                                                                                                                                                                      |

For F19, keep generic atomic archive installation in core and product-specific
release registry/URL policy in its narrow runtime owner. Move metadata through
the generator, not by copying interfaces or release tables. Do not move CLI
commands or model-proxy product policy into dependency-light core. Acceptance:
Graphiti can install/run its binary without the CLI graph; CLI commands retain
the same exact-version/platform selection; missing-platform errors and signal
forwarding remain covered. Measure a packed isolated install rather than claiming
unverified byte savings.

## Execution sequence and acceptance gates

### Batch A: correctness and supported reuse

- [x] F01: interoperable lock protocol and cross-runtime contention tests.
- [x] F02: configured auth trust set and positive/negative origin cases.
- [x] F03: typed Python Postgres SDK with real expiry/pagination fixtures.
- [x] F04/F09: one Graphiti tool contract and native AppKit provider parity.
- [x] F05/F06/F07/F08: external Projen construction, roots, credentials, and
      release-mode contracts.
- [x] Start F18's packed consumer fixture with these fixes; do not defer it until
      after all generator refactoring.

Keep these as focused changes; they can proceed independently except that F04
benefits from F09's native types. Validation for each is specified above. Review
the resulting behavior rather than accepting line-count reduction as completion.

### Batch B: remove proven parallel implementations

- [x] F20: public Better Auth migration import; retain migration-lock tests.
- [x] F11: parser-backed HTML with the malformed-input fixture corpus.
- [x] F12: framed SSE usage observation and accounting parity.
- [x] F15: native/structured TOML with parsed-equivalence and restoration tests.
- [x] F16: explicit native build workflow; keep root-only install behavior.
- [x] F17: shared dependency-free Python binding placement helper; compare local
      and release output, Windows executable naming, and dependency mappings.
- [x] F21/F23: native abort combination and generated SSL enum ownership.

F20 and importing the public F09 types are the best small native-reuse wins.
F22's private helper deletion is also small, but do not delete a public pagination
export solely because an internal usage search is empty.

### Batch C: ownership and dependency reach

- [ ] F10: replace process-global feature runtime state with plugin-owned
      instances. Test two apps with different policies/backends and shutdown of
      one while the other remains active; reuse existing `execution.run`.
- [x] F14: generic docs/output hooks, actual configured Python roots, optional
      repository title policy, and declared extra tooling members.
- [x] F18: finish isolated archive lifecycle coverage and supported Windows
      command fixes. Use `path.delimiter`; replace POSIX `find | grep` conditions;
      remove the task targeting missing `projen/tasks/demo.ts`.
- [x] F19: narrow release-binary runtime and install-graph validation.
- [x] F22/F25: remove obsolete private code and reconcile current docs and
      canonical instructions. Keep source READMEs as the docs-site input.

### Batch D: decisions that need a contract before code changes

- [ ] F13: choose the Python YAML dependency/syntax policy, then implement shared
      config fixtures without compromising dependency-free imports.
- [ ] F24: define journal commit/retry/replay semantics and fault tests before
      choosing a persistence-library replacement or expanding the journal.
- [ ] Decide whether CLI command consolidation provides enough consumer benefit
      to justify public API/dependency migration. Record a keep decision if it
      does not; a smaller package count is not itself an acceptance criterion.

For F24, test failures after a Neo4j transaction body succeeds but commit fails,
driver retry callbacks, non-idempotent mutations, permanently invalid journal
entries, transaction grouping, clone/database identity, and retention/checkpoint
behavior. A supported persistent graph backend or backup facility is a candidate
only if it meets the deployment's actual durability requirement. The current
intentional write-ahead behavior must not be classified as accidental dead code.

### Completion rule

Update each finding's disposition in this document as it is fixed, declined, or
superseded, recording relevant validation. Change future-agent behavior in
`AGENTS.md` before subordinate docs. Archive this plan only when all findings have
a recorded disposition; record the final date. Implementation edits generated
artifacts through their authoring inputs and normal synthesis, never by hand.

## Things that look problematic but should remain

- **Current Mastra transport and memory integration:** `packages/js/node/appkit-mastra/src/chat.ts:8` uses native
  `chatRoute`; `packages/js/ui/mastra/src/support/mastra-client.ts:117` uses
  `DefaultChatTransport`; `packages/js/ui/mastra/src/react/chat-stream.ts:66` consumes
  `readUIMessageStream`; approval continuation uses `resumeData`. Keep the
  Databricks identity, scope, model policy, concurrent-thread, and steering
  behavior layered around those APIs.
- **Native AppKit search:** `packages/js/node/search/src/native.ts:73` already
  delegates queries. Federated search, index lifecycle, and Lakebase full text
  remain extensions; do not restore or re-remove a second query implementation.
- **Teams' two-pass answer/card flow:** it preserves tool use and answer content.
  Structured output does not make the first answer pass redundant. Do not switch
  to an obsolete Bot Framework library just to replace HTTP calls.
- **Small shared utilities and the logger:** the large `shared/core/src/object.ts`
  is not evidence that every helper should become a dependency. Existing
  canonicalization, compatibility behavior, and dependency budgets matter. Keep
  logging dependency-free.
- **Native authentication and protocol ownership:** Rust already uses `oauth2`,
  `reqwest-middleware`, `fs4`, and `google-cloud-auth`; Graphiti delegates process
  supervision to Honcho; AppKit feature plugins use native tool registries.
  These are substantial examples of appropriate library reuse.
- **The proxy token queue:** its FIFO weighted input/output reservations,
  reconciliation, calibration, and selective activation are not equivalent to a
  generic rate limiter. No verified drop-in replacement was found.
- **Generated manifests, barrels, schemas, and bindings:** repeated generated
  output has one authoring source. The first broad clone scan mostly detected
  generated task JSON; it was discarded as a source-debt measure.
- **Public packages with one internal consumer:** internal counts omit external
  users. Keep the documented runtime/dependency boundaries unless an isolated
  consumer test proves a better arrangement.
- **Current release orchestration:** native Projen publisher primitives do not
  automatically preserve the repository's reviewed polyglot release contract.
  Replace specific internal duplication, not the whole workflow.

## Evidence, coverage, and limitations

Reviewed the root/package manifests and READMEs, relevant canonical instructions,
recent 200 commits, six months of non-merge file churn, installed upstream
declarations/source, and archived audits. The earlier September 15 audit and
closed pruning plan were used as history, not as an unchecked task list.
Previously suggested Python SDK replacement and binding-generation DRY work
were reopened only after confirming current code still contains the issue.

Local validation performed during the audit:

- Reproduced same-key overlapping file-lock callbacks across the two backends.
- Reproduced the foreign-origin auth response and verified the public Better
  Auth migration import.
- Reproduced HTML conversion failures and checked the installed converter.
- Reproduced Python credential-expiry/pagination and YAML parity failures using
  production helpers and local fixtures.
- Reproduced Projen constructor failures and incorrect external repository
  metadata without synthesis.
- Ran the focused Python engine and Graphiti persistence suites: **19 passed**,
  with one upstream Pydantic deprecation warning. Those passing tests do not
  cover the new fault/contract cases proposed above.
- Scanned selected source with jscpd: minimum 10 lines / 70 tokens;
  TypeScript, TSX, JavaScript, Python, Rust; excluded dependency/build/generated
  binding trees, `.projen`, barrels, generated Genie SDK schemas, and explicit
  test directories/files. **371 files, 90,634 lines, 3 clones, 73 repeated lines.**
  Rust inline test modules remain in that denominator. Two clones are in those
  tests (`routes.rs:1010`, `throttle.rs:858`); the third is a 12-line UI block
  (`tool-pill.tsx:334`). None warrants a new general abstraction alone.
- Inspected the declared workspace dependency graph: no cycle was found in the
  reviewed graph. This is not a full import-level or dynamic-registration proof.

The inventory below counts tracked non-barrel code after excluding recognized
generated output and native binding trees; it includes tests. It covered roughly
123,000 lines across 609 files. Size/churn select review targets; neither proves
debt by itself.

| Largest files                                         | Lines | Most changed files over six months                  | Non-merge commits |
| ----------------------------------------------------- | ----: | --------------------------------------------------- | ----------------: |
| `projen/src/project-rs.ts`                            | 1,503 | `.projenrc.ts`                                      |               189 |
| `packages/js/shared/core/src/object.ts`               | 1,488 | `projen/test/project-rs.test.ts`                    |                50 |
| `projen/src/project-js.ts`                            | 1,460 | `projen/src/project-rs.ts`                          |                48 |
| `.projenrc.ts`                                        | 1,286 | `projen/tasks/bump.ts`                              |                40 |
| `packages/rs/model-proxy/src/routes.rs`               | 1,264 | `projen/src/project.ts`                             |                37 |
| `packages/js/node/appkit-mastra/src/chart.ts`         | 1,235 | `projen/src/release.ts`                             |                33 |
| `packages/js/node/appkit-mastra/src/plugin.ts`        | 1,224 | `projen/test/release.test.ts`                       |                33 |
| `packages/rs/model-proxy/src/throttle.rs`             | 1,206 | `docs/scripts/sync-readmes.mjs`                     |                26 |
| `scripts/install.ts`                                  | 1,190 | `projen/.projenrc.ts`                               |                25 |
| `packages/js/node/appkit-mastra/src/genie.ts`         | 1,158 | `projen/src/project-py.ts`                          |                25 |
| `packages/js/ui/mastra/src/react/mastra-chat.tsx`     | 1,063 | `projen/test/project-py.test.ts`                    |                25 |
| `packages/js/ui/mastra/src/support/mastra-client.ts`  |   994 | `projen/src/project-js.ts`                          |                23 |
| `packages/js/node/appkit-mastra/src/agents.ts`        |   993 | `docs/scripts/generate-api-docs.mjs`                |                19 |
| `packages/js/node/appkit/src/lakebase-resolver.ts`    |   944 | `projen/tasks/uniffi-release.mjs`                   |                17 |
| `packages/py/core/src/dbx_tools/core/config.py`       |   918 | `packages/rs/model-proxy/src/main.rs`               |                15 |
| `packages/js/shared/fs/src/base-fs.ts`                |   882 | `projen/src/pnpm-workspace.ts`                      |                15 |
| `packages/rs/model/tests/model.rs`                    |   876 | `projen/src/project-predicate.ts`                   |                15 |
| `packages/js/node/appkit-mastra/src/remote-skills.ts` |   856 | `projen/tasks/release-pr.ts`                        |                15 |
| `packages/js/shared/model/src/openai-responses.ts`    |   841 | `packages/example/server/appkit-demo/src/server.ts` |                14 |
| `scripts/install.test.ts`                             |   813 | `projen/tasks/publish.ts`                           |                14 |

This was a source/contract audit with targeted offline probes, not a deployment,
performance benchmark, full vulnerability audit, or full workspace test run.
No live Databricks, Graphiti, Teams, model inference, release, or publication was
performed. Coverage percentages and bundle/install-byte savings were not
measured. Knip/madge were not installed for a fresh broad unused-export/import
scan; dead-code claims above were checked against actual callers and public
exports. Network-backed dependency advisory scans were not run, so dependency
security is unassessed rather than declared clean.

## Decisions to record during implementation

1. Is a standalone compiling Projen root a supported product promise? Current
   documentation says yes; this plan recommends fixing it rather than silently
   narrowing the API.
2. Which Node/browser versions are supported by dependency-light packages? State
   them before replacing compatibility helpers with newer platform APIs.
3. Which legitimate tunnel/overlay origins must be accepted, and how are they
   supplied as trusted configuration?
4. Should Python core provide full YAML through an optional adapter, or promise a
   documented subset? Keep its dependency-free import contract either way.
5. Do direct CLI command-package consumers gain enough install isolation to keep
   those package boundaries? Measure before consolidation.
6. Does the Graphiti journal promise replay of attempted writes, committed
   transactions, or another explicit recovery model? Set that contract before
   replacing or extending persistence.

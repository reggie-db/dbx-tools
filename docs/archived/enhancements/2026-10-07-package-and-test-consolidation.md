# Package and test consolidation plan

Date: 2026-10-07

Updated: 2026-10-08

Status: Completed. The package consolidation, test-tier split, generated
workspace graph, dependency-boundary checks, documentation updates, and final
validation described below were completed on 2026-10-08.

## Decision

Reduce the npm publication surface from **50 packages to 38 packages** while
retaining the two Python distributions. The repository should keep boundaries
that isolate browser, React, Node, optional SDK, and Python dependency costs. It
should retain capability-specific shared packages as the browser-safe contract
between Node implementations and browser or UI consumers. It should remove
boundaries that only restate command wiring, AppKit adapters, or UI foundations
released in lockstep.

The test suite has useful coverage. Its main cost is orchestration and expensive
integration fixtures, not widespread duplicate scenarios. Keep the scenarios,
move each assertion to one owner, add affected-test selection, and separate fast
unit tests from process, package, Git, and database integration tests.

## Repository snapshot

The snapshot at `390edcbd` contains:

- 52 Bun workspace packages: 49 under `packages/js`, two example packages, and
  `@dbx-tools/projen`.
- 50 publishable npm packages and two publishable Python distributions.
- 12 browser-safe shared packages, 21 Node packages, nine CLI packages, seven
  UI packages, and the Projen package.
- 99,066 handwritten TypeScript, JavaScript, and Python source lines across 494
  files, excluding generated Python source.
- 28,915 test lines across 227 JavaScript and Python test files.
- 186 internal npm dependency edges. The root demo server directly consumes 12
  internal packages.
- 49 package-specific dependency rules in the 1,457-line `.projenrc.ts`.

The package graph is horizontally layered. A capability such as Graphiti or the
model gateway can have separate shared, Node, AppKit, CLI, Python, and UI
surfaces. This preserves runtime safety, but it also creates a manifest,
README, generated dependency file, barrel, compile task, test task, release
artifact, and documentation surface for small amounts of code.

Examples of boundaries with little implementation weight include:

| Package                        | Source lines | Internal consumers |
| ------------------------------ | -----------: | -----------------: |
| `@dbx-tools/cli-graphiti`      |           93 |                  1 |
| `@dbx-tools/shared-email`      |           99 |                  3 |
| `@dbx-tools/shared-graphiti`   |          131 |                  1 |
| `@dbx-tools/cli-model-gateway` |          150 |                  1 |
| `@dbx-tools/graphiti`          |          152 |                  2 |
| `@dbx-tools/cli-appkit-env`    |          198 |                  1 |
| `@dbx-tools/cli-args`          |          208 |                  7 |
| `@dbx-tools/shared-search`     |          276 |                  2 |
| `@dbx-tools/shared-teams`      |          277 |                  2 |
| `@dbx-tools/ui-appkit`         |          298 |                  6 |

Small size alone does not justify a merge. The relevant question is whether the
boundary avoids installing or loading dependencies that a consumer does not
need. Several current boundaries do not meet that test:

- `@dbx-tools/cli` already depends on every command package, so command packages
  do not reduce install reach for the main CLI.
- Shared packages are justified when they own the browser-safe schemas, values,
  and serialization contracts used by both a Node capability and its browser or
  UI consumers. Their small size is not a reason to merge them.
- `ui-appkit`, `ui-branding`, `ui-auth`, `ui-email`, and `ui-search` share React,
  AppKit UI, branding, and styling dependencies. Their separation creates more
  release surfaces than dependency isolation.
- `appkit-graphiti` has one purpose and depends on `graphiti`; it is a natural
  `@dbx-tools/graphiti/appkit` entrypoint.

## Comparison with established monorepos

The comparison uses current source snapshots rather than package-count rules.

### Databricks AppKit

Databricks AppKit has four packages under `packages/`: `appkit`, `appkit-ui`,
`lakebase`, and an internal `shared` package. AppKit keeps agents, connectors,
database support, evals, plugins, telemetry, testing helpers, and workspace
clients inside the main package and exposes selected subpaths. It does not
publish one package per plugin or CLI command.

Its tests run from one root Vitest configuration with named projects for the
main package, UI, Lakebase, shared code, tools, and playground. CI first filters
documentation-only changes, then runs unit, integration, and template smoke
tests as separate jobs.

Evidence:

- [Workspace layout](https://github.com/databricks/appkit/blob/97e00e94cfea00c793050810ac785f0bddd5691f/pnpm-workspace.yaml)
- [Root scripts](https://github.com/databricks/appkit/blob/97e00e94cfea00c793050810ac785f0bddd5691f/package.json)
- [AppKit exports](https://github.com/databricks/appkit/blob/97e00e94cfea00c793050810ac785f0bddd5691f/packages/appkit/package.json)
- [Root Vitest projects](https://github.com/databricks/appkit/blob/97e00e94cfea00c793050810ac785f0bddd5691f/vitest.config.ts)
- [Change-filtered CI](https://github.com/databricks/appkit/blob/97e00e94cfea00c793050810ac785f0bddd5691f/.github/workflows/ci.yml)

This repository is closer to AppKit than to an adapter marketplace. Most
dbx-tools packages are parts of one AppKit-oriented product and release in
lockstep. The AppKit structure supports consolidating CLI commands and related
implementations behind subpath exports. Its internal `shared` package does not
map directly to dbx-tools, where capability-specific shared packages are public
contracts consumed by browser code.

### Mastra

Mastra has hundreds of package manifests because its public surface includes
independently installable stores, deployers, server adapters, auth providers,
observability exporters, browser providers, voice providers, workspace
providers, and client SDKs. Those packages isolate third-party dependencies and
allow consumers to install one integration.

Mastra still keeps its central runtime in a large `@mastra/core` package. It
also provides focused build and test commands and a source dependency graph
that maps changed files to transitively affected test files.

Evidence:

- [Workspace groups](https://github.com/mastra-ai/mastra/blob/2f14b267b06da7255ef7c131f1138993c39bd733/pnpm-workspace.yaml)
- [Focused build and test scripts](https://github.com/mastra-ai/mastra/blob/2f14b267b06da7255ef7c131f1138993c39bd733/package.json)
- [Task graph](https://github.com/mastra-ai/mastra/blob/2f14b267b06da7255ef7c131f1138993c39bd733/turbo.json)
- [Affected-test resolver](https://github.com/mastra-ai/mastra/blob/2f14b267b06da7255ef7c131f1138993c39bd733/scripts/affected-tests.mjs)

The Mastra comparison supports retaining packages such as
`databricks-zerobus`, `ui-teams`, and `appkit-mastra` when they isolate a large
or optional external dependency. It also supports explicit public contract
packages when multiple runtimes consume them. It does not support separate
packages for small CLI wiring that the umbrella CLI always installs.

### Vercel AI SDK

The Vercel AI SDK publishes many provider packages because each provider has an
independent SDK and install cost. It keeps framework integrations such as React,
Vue, Svelte, and Angular separate, then uses a Turborepo task graph for cached,
dependency-aware builds and tests.

Evidence:

- [Workspace layout](https://github.com/vercel/ai/blob/5028fa46b4b4e695bf0d80e968db43268e9ec5ef/pnpm-workspace.yaml)
- [Filtered and parallel test scripts](https://github.com/vercel/ai/blob/5028fa46b4b4e695bf0d80e968db43268e9ec5ef/package.json)
- [Build and test task graph](https://github.com/vercel/ai/blob/5028fa46b4b4e695bf0d80e968db43268e9ec5ef/turbo.json)

This supports keeping optional SDK packages separate while consolidating code
that shares dependencies and release cadence.

## Target package map

### Retain capability-specific shared contracts

Keep the 12 `packages/js/shared/*` packages separate. A shared package is the
runtime-neutral contract for one capability, primarily from its Node
implementation to browser or UI consumers. It may contain Zod schemas,
serialized request and response shapes, browser-safe clients, pure value
objects, and deterministic parsers. It must not contain Node process, filesystem,
credential, database, or server lifecycle behavior.

The dependency direction remains:

1. Shared contract package owns wire types and browser-safe behavior.
2. Node capability package imports its shared contract.
3. Browser and UI packages import the same shared contract directly.
4. Shared packages never import Node or UI packages.

`@dbx-tools/shared-core` remains the dependency-light foundation used by the
other shared packages. `@dbx-tools/shared-email-template` remains separate
because React Email and React are part of its cross-runtime rendering contract.

Acceptance criteria:

- Every shared package documents its Node owner and browser or UI consumers.
- Browser builds import no Node built-ins through a shared package.
- Wire shapes have one schema owner and are not mirrored in Node or UI packages.
- Node-only helpers found in a shared package move to the owning Node package.
- Generated Python bindings consume the owning shared contract without creating
  a second schema surface.

### Consolidate CLI command packages

Merge `cli-args`, `cli-appkit-env`, `cli-auth`, `cli-graphiti`,
`cli-lakebase-proxy`, `cli-model-gateway`, and `cli-tunnel` into
`@dbx-tools/cli`. Preserve the existing executable names in one `bin` map and
expose reusable code through subpaths such as `@dbx-tools/cli/args`,
`@dbx-tools/cli/graphiti`, and `@dbx-tools/cli/tunnel`.

Keep `@dbx-tools/cli-service` separate in the first migration. It is a
substantial service and systray runtime used by several commands. Rename it to
`@dbx-tools/service` only if a later API review confirms that non-CLI consumers
are supported.

Acceptance gates:

- `dbx`, `dbx-tools`, `dbx-graphiti`, `dbx-lakebase-proxy`, and
  `dbx-model-gateway` retain their command names and help output.
- The root CLI continues to load heavy commands lazily.
- Direct imports of command builders and option schemas use supported subpaths.
- A packed CLI smoke test proves all bins without installing sibling packages.

### Consolidate common UI packages

Create `@dbx-tools/ui` from `ui-appkit`, `ui-branding`, `ui-auth`, `ui-email`,
and `ui-search`. Expose `react`, `branding`, `auth`, `email`, `search`, assets,
and styles as explicit subpaths.

Keep `@dbx-tools/ui-mastra` separate because it has a large implementation and
dependencies on Mastra, AI SDK, ECharts, Shiki, and SQL formatting. Keep
`@dbx-tools/ui-teams` separate because Adaptive Cards is an optional rendering
runtime that other UI consumers should not install.

Acceptance gates:

- Importing `@dbx-tools/ui/auth` or `@dbx-tools/ui/search` does not initialize
  unrelated UI modules.
- CSS exports preserve their current order and brand token behavior.
- React and React DOM remain peers.
- Bundle-size probes show no material increase for auth-only and search-only
  consumers.

### Consolidate Graphiti integration

Move `@dbx-tools/appkit-graphiti` into `@dbx-tools/graphiti/appkit`. Keep
`@dbx-tools/shared-graphiti` as the runtime-neutral Graphiti option contract and
move the CLI command into `@dbx-tools/cli/graphiti`.

Keep `dbx-tools-graphiti` as a Python distribution. It owns the FastAPI, MCP,
PostGraph, embedded PostgreSQL, and Python runtime dependency set.

The current PostgreSQL role changes follow the intended ownership model:

- `@dbx-tools/postgres` owns role validation, identifier quoting, startup
  options, and asyncpg server settings.
- Node Postgres consumers use that owner when they construct pools or dedicated
  sessions.
- Python Graphiti consumes generated bindings and owns only Graphiti-specific
  schema, extension, embedded server, and Lakebase lifecycle behavior.

Do not move the PostgreSQL helpers back into Graphiti. Extend
`@dbx-tools/postgres` when another PostgreSQL consumer needs the same policy.

### Retain dependency-isolating packages

Keep these boundaries unless install and bundle measurements prove otherwise:

- `@dbx-tools/appkit-mastra`
- `@dbx-tools/appkit-model-gateway`
- `@dbx-tools/appkit-web-search`
- `@dbx-tools/auth`
- `@dbx-tools/auth-gate`
- `@dbx-tools/core`
- `@dbx-tools/databricks`
- `@dbx-tools/databricks-zerobus`
- `@dbx-tools/email`
- `@dbx-tools/fs`
- `@dbx-tools/genie`
- `@dbx-tools/lakebase`
- `@dbx-tools/model`
- `@dbx-tools/path`
- `@dbx-tools/postgres`
- `@dbx-tools/search`
- `@dbx-tools/teams`
- `@dbx-tools/tunnel`
- `@dbx-tools/projen`
- Both Python distributions

These packages isolate a meaningful runtime, optional SDK, external protocol,
or language boundary. `path` retains Chokidar, Glob, and Minimatch;
`databricks-zerobus` retains the optional Zerobus SDK; `ui-teams` retains
Adaptive Cards.

The resulting target is 38 npm packages and two Python distributions:

- Shared packages: remain at 12
- CLI packages: 9 to 2
- UI packages: 7 to 3
- Graphiti Node packages: 2 to 1
- Other Node packages and Projen: unchanged

## Test findings

### Measured baseline

`bun run --filter '*' test` completed in **47.27 seconds** on the audit machine.
The package runners reported **1,357 tests across 206 files**. Summed runner
time was 70.15 seconds because packages execute concurrently.

The complete `bun run test` gate, including three ESLint passes, documentation
tests, generated Python checks, Ruff, Pytest, and all workspace tests, completed
in **96.15 seconds** after the implementation formatting issues were corrected.

The largest package suites were:

| Package                    | Reported duration | Tests |
| -------------------------- | ----------------: | ----: |
| `@dbx-tools/projen`        |           35.85 s |   172 |
| `@dbx-tools/core`          |           10.49 s |    89 |
| `@dbx-tools/appkit-mastra` |            4.70 s |   140 |
| `@dbx-tools/cli-tunnel`    |            1.52 s |    13 |
| `@dbx-tools/email`         |            1.51 s |    84 |
| `@dbx-tools/tunnel`        |            1.47 s |    65 |

Ten workspace packages started a Bun test process and found no tests. Python
completed **37 tests in 2.90 seconds** with 3.63 seconds of wall time.

The slowest individual tests are integration tests:

- Projen packed-consumer lifecycle: 6.63 s
- Python Node binding generation scenarios: 0.8-2.64 s each
- Workspace version synthesis: 1.63 s
- Projen release Git workflows: 0.44-1.00 s each
- PostgreSQL topic bus notification: 1.05 s
- Core binary install/download scenarios: 0.29-0.55 s each
- AppKit Mastra remote-skill download/cache scenarios: 0.21-0.52 s each

### Duplication assessment

Do not delete broad sets of tests. The reviewed Graphiti and model-gateway
suites mostly test distinct owners:

- Shared tests validate schemas, defaults, and serialization.
- Node tests validate runtime construction and protocol behavior.
- AppKit tests validate plugin lifecycle, routing, and toolkit integration.
- CLI tests validate command wiring and service persistence.
- Python Graphiti tests validate FastAPI/MCP composition, PostGraph behavior,
  embedded PostgreSQL, Lakebase credentials, and asyncpg settings.

The repeated cost is mainly structural:

- Every package starts its own test process, including packages with no tests.
- Shared schema behavior is sometimes reasserted in Node and CLI suites instead
  of those suites testing only their wiring.
- Projen unit and integration tests run in the same command.
- Real Git repositories, package consumers, generated bindings, downloads, and
  subprocesses are recreated for many integration scenarios.
- The default root test has no changed-package or reverse-dependent selection.

## Target test model

### Commands

Define four explicit test tiers in Projen:

1. `test:focused` runs named files or one package during implementation.
2. `test:changed` runs tests for changed packages and their reverse dependents.
3. `test:unit` runs all deterministic JavaScript and Python unit tests without
   package, Git, network, or external-process fixtures.
4. `test:all` runs lint, generated-source checks, unit tests, integration tests,
   Python tests, packed-consumer tests, and release fixtures.

Use `test:changed` for normal pull-request validation and `test:all` for release
tags, scheduled validation, and changes to the task graph itself. Keep `test`
as an alias chosen explicitly by repository policy; do not let release and local
commands silently diverge.

### Affected-test selection

Start with the generated workspace dependency graph:

- A changed package selects its own tests.
- It also selects every transitive reverse-dependent package.
- Changes to root Projen policy, catalogs, shared compiler settings, or release
  tasks select the full relevant layer or `test:all`.
- Changes to a `@dbx-tools/shared-*` package select that contract package's Node,
  browser, UI, and generated Python consumers.
- Changes to generated Python binding owners select their Python consumers.

Add source-level transitive selection only after package-level selection is
stable. Mastra's affected-test script is a useful reference, but this repository
should first reuse its generated package graph instead of adding a second graph
owner.

### Unit and integration ownership

Move expensive tests into explicit integration suites:

- Projen packed consumer and release Git workflows
- Python Node binding generation through subprocesses
- Core binary download, extraction, and cross-process lock tests
- PostgreSQL LISTEN/NOTIFY and external database tests
- AppKit Mastra remote download/cache and worker lifecycle tests
- CLI service install/start/stop tests

Keep pure schema, parsing, routing, serialization, error mapping, and state
machine tests in unit suites.

For layered capabilities, apply one-owner assertions:

- Shared contract tests own valid, invalid, default, and serialization cases.
- Node consumers assert that the resolved contract is passed to the runtime.
- CLI consumers assert command mapping and one invalid-input smoke case.
- Python binding tests assert generated parity once per binding generator, then
  each Python package keeps only behavior tests that cross the language boundary.

### Runner consolidation

After package consolidation, run tests in a small number of root runner
projects instead of one Bun process per package. Use at least these projects:

- browser/shared
- Node
- React/UI
- Projen unit
- Projen integration
- examples and packed consumers
- Python unit and integration

Prototype root-level Bun discovery first. If tests require package-local working
directories, generate one command per project group rather than restoring one
command per package. Packages with no tests must not start a test process.

### Performance reporting

Record timing for each test tier as informational CI output. Do not fail CI from
elapsed-time thresholds because runner capacity and corporate infrastructure can
vary substantially. Compare trends only across equivalent runners and retain
the raw durations with the build artifacts or job summary.

Use timing data to prioritize orchestration work, identify unexpected changes,
and support code review. Do not weaken correctness assertions or block a change
solely because a slow machine crosses a target duration. Move expensive coverage
to the correct tier, reuse fixtures where isolation is not part of the test, and
remove orchestration overhead first.

## Implementation results

The implementation produced 40 JavaScript workspaces: 38 publishable npm
packages and two example applications. The two Python distributions remain
separate. The publishable package map now contains 12 shared contract packages,
two CLI packages, three UI packages, and one Node Graphiti package.

The consolidated CLI preserves the `dbx`, `dbx-tools`, `dbx-graphiti`,
`dbx-lakebase-proxy`, and `dbx-model-gateway` binaries. The primary `dbx`
install already reached every command package before consolidation, so its
external dependency reach did not increase. Direct users of a former standalone
command package now receive the umbrella CLI dependency set. Five local
`dbx --help` runs completed in 0.07-0.09 seconds on the audit machine. This is
recorded as informational data; the original branch did not retain an equivalent
startup sample for a numerical regression claim.

The consolidated UI manifest contains the union of the former foundation,
branding, auth, email, and search dependencies. Auth-only consumers therefore
install the small shared email and search contract packages as part of
`@dbx-tools/ui`, but no new large external runtime dependency was introduced.
Minified browser probes reported:

| UI subpath | Bytes |
| ---------- | ----: |
| auth       | 19,235 |
| email      | 20,910 |
| search     | 16,390 |

The final test and validation results were:

- `test:unit`: 204 files selected; 17.52 seconds reported by the runner and
  17.88 seconds wall time.
- `test:integration`: 15 files selected; 68 passed and two live-download tests
  skipped; 16.68 seconds reported by the runner and 16.85 seconds wall time.
- `test:all`: 219 JavaScript and TypeScript files selected in 49.89 seconds;
  the complete command, including 37 passing Python tests, completed in 59.26
  seconds.
- `compile`: passed in 11.25 seconds.
- ESLint, Ruff, documentation source and README checks, version checks, and UI
  bundle probes passed.
- Three consecutive Projen synthesis runs produced an identical repository
  snapshot after the first completed synthesis.

The Graphiti review confirmed the intended ownership. `AppKitChildProcess`
uses `@dbx-tools/core/exec` spawn arguments and shutdown behavior. Graphiti,
tunnel transports, and wrapped tunnel applications use that supervisor.
`@dbx-tools/postgres` owns role validation, quoting, Node startup options, and
asyncpg server settings. Python Graphiti consumes those functions through the
generated PythonMonkey bindings and retains only its schema, extension,
embedded-server, and Lakebase lifecycle code.

## Delivery sequence

### Phase 1: Measurement and task separation

- [x] Generate a machine-readable package and reverse-dependency graph from the
      Projen workspace owner.
- [x] Add informational timing output for each root test runner group and record
      the remaining validation command timings in this result.
- [x] Add `test:unit`, `test:integration`, `test:changed`, and `test:all`.
- [x] Classify the current Projen, core, Postgres, service, and remote-skill
      tests without changing assertions.
- [x] Stop spawning test processes for packages with no tests.

Exit condition: current coverage passes in the new tiers and the timing report
identifies each tier's wall time.

### Phase 2: Shared contract boundary enforcement

- [x] Record the Node owner and browser or UI consumers for every shared package.
- [x] Add dependency-direction checks that reject Node and UI imports from shared
      packages.
- [x] Keep Node-only implementation helpers outside shared packages without
      merging the shared contract packages.
- [x] Verify that each wire shape has one Zod schema owner.
- [x] Validate browser import safety, generated Python bindings, docs, and packed
      consumers.

Exit condition: all 12 shared packages remain separate, browser-safe contract
owners with documented consumers and no mirrored schemas.

### Phase 3: CLI consolidation

- [x] Move argument generation and command builders under `@dbx-tools/cli`.
- [x] Preserve dynamic imports and all existing bin names.
- [x] Generate command documentation from the consolidated parser tree.
- [x] Remove seven command packages after packed-bin tests pass.

Exit condition: CLI packages fall from 9 to 2 and startup time does not regress.

### Phase 4: UI consolidation

- [x] Merge UI foundation, branding, auth, email, and search into
      `@dbx-tools/ui` subpaths.
- [x] Keep Mastra and Teams UI packages separate.
- [x] Add auth-only, email-only, and search-only bundle-size probes.
- [x] Validate CSS export ordering and demo builds.

Exit condition: UI packages fall from 7 to 3 without material bundle growth for
focused consumers.

### Phase 5: Graphiti consolidation

- [x] Move the AppKit plugin into `@dbx-tools/graphiti/appkit`.
- [x] Move Graphiti CLI wiring into `@dbx-tools/cli/graphiti`.
- [x] Retain the Python distribution and generated Node bindings.
- [x] Verify embedded PostgreSQL, external PostgreSQL, Lakebase, configured role,
      and shutdown behavior.

Exit condition: one Node Graphiti package owns runtime and AppKit integration;
PostgreSQL policy remains in `@dbx-tools/postgres`.

### Phase 6: Full validation and cleanup

- [x] Run Projen twice and require an identical second synthesis.
- [x] Run `test:all`, compile, docs checks, version checks, and packed-consumer
      validation.
- [x] Review dependency and installation reach, record current CLI startup and
      UI bundle sizes, and compare total test duration with the baseline.
- [x] Update `AGENTS.md`, root/package READMEs, generated API docs, and the
      package catalog.
- [x] Archive this plan with final counts and measured results.

## Non-goals

- Do not merge the Python distributions into npm packages.
- Do not merge browser and Node entrypoints without an import-safety test.
- Do not combine capability-specific shared contracts into one catch-all shared
  package.
- Do not absorb optional Zerobus, Adaptive Cards, Mastra, model-gateway, or web
  search dependencies into a common package solely to reduce package count.
- Do not fail CI based on test wall-clock duration.
- Do not replace Projen with another task runner as part of this work.
- Do not fix the existing native `oxc-parser` post-synthesis deadlock in this
  plan unless it blocks a consolidation phase.
- Do not remove Graphiti/PostgreSQL database-mode tests merely because they are
  integration tests.

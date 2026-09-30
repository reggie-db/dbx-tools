# evaAppKit 0.81 upgrade and native reuse plan

Date: 2026-09-29

Status: Completed and archived on 2026-09-30. Required changes passed their
acceptance gates; parity-gated replacements that lacked public support were
explicitly retained or declined.

Scope: compare the repository's AppKit 0.60.0 integration with the latest
published AppKit and AppKit UI, identify custom code that can be reduced, and
define a staged upgrade. This is a separate review from the completed
[cleanup and reuse plan](2026-09-29-code-cleanup-and-reuse-plan.md).
It does not implement an upgrade, retire packages, or change current runtime
contracts.

## Snapshot and evidencevae

- Both registry queries, `bun info @databricks/appkit version --json` and
  `bun info @databricks/appkit-ui version --json`, returned **0.81.0**.
- The inspected upstream tag is `v0.81.0`, commit
  `113094713e4c2094bfe55983e2d2da89bed65208`, dated 2026-09-29. Upstream links
  below pin that commit rather than a moving branch.
- The repository resolves both packages to **0.60.0**. Its source catalog is
  `projen/src/pnpm-workspace.ts:90`; `^0.60.0` does not admit 0.81.0. Generated
  manifests and the lockfile agree. Repository review began at `2a96bfab` and
  was reconciled with `beac23f8`; unrelated concurrent release and Graphiti
  changes were excluded.
- Read the CLI docs and published `.d.ts` files for both versions, then compared
  relevant implementations across `v0.60.0..v0.81.0`. The latest package was
  inspected in an isolated directory without changing this repository's
  dependencies. Release notes alone were insufficient to establish parity.
- A TypeScript 5.9.3 declaration probe passed for all **13 selected packages**
  against both versions after sharing the repository's React, Express, and
  Postgres types. This is evidence of source compatibility, not an upgraded
  installation or a production runtime test. Details and limits are below.

## Assessment

**Upgrade AppKit, then remove bounded scaffolding where the native contract
matches. There is no evidence for retiring a major dbx-tools package.**

1. The clearest new reduction is the native testing kit. It can replace fake
   routers, partial plugin contexts, and portions of HTTP/lifecycle test setup.
   A published-package probe works under the repository's Bun test runner.
2. The new native `database()` plugin creates a concrete integration gap:
   dbx-tools automatic environment resolution currently detects only
   `lakebase()`. Support the new plugin without creating an extra pool.
3. Native agent discovery, curated skills, and evaluation make simple AppKit
   agent apps substantially easier. Prefer those surfaces for that use case;
   they do not supply the complete Mastra contract used here.
4. Keep Genie Agent Mode, model discovery and Responses routing, user-scoped
   skills, Sandbox/Monty, durable approvals, and concurrent Mastra chat.
5. AI Search execution, generic UI primitives, the SDK facade, and the native
   shutdown budgets mostly predate this upgrade. Their names appearing in
   0.81 documentation is not evidence of newly redundant code.
6. Two pre-existing parity issues deserve focused fixes: Lakebase search accepts
   HTTP projection overrides that native AI Search discards, and the Mastra
   toolkit adapter does not honor the legacy `destructive` annotation.
7. Retain the private cache compatibility seam until a public native policy
   handles the existing-table ownership case. Latest AppKit has not fixed it.
8. Keep the Node/shared/UI boundaries and the reusable Projen engine. Native
   AppKit's new server-build preset solves a narrower application-layout need.

## Architectural model

AppKit owns the application lifecycle, request identity, native plugins,
execution context, and browser primitives. dbx-tools adds two kinds of code:
small integration conveniences around those services, and independent product
behavior such as Mastra sessions, policy-controlled tools, model selection,
Genie event projection, and cross-runtime packages. The first category should
shrink when AppKit exposes an equivalent public API. The second should remain
unless the native replacement preserves its actual protocol and identity rules.

AppKit 0.81 expands the platform with application-owned database entities,
discovered native agents, skill loading, evaluations, and test harnesses.
These are useful additions, but they do not turn Mastra memory into AppKit
threads, database CRUD into Better Auth migrations, or an outbound MCP client
into the Graphiti MCP server. Prefer composition through public exports over
adapters that pretend these contracts are interchangeable.

## What actually changed since 0.60

| Native area                     | New in the inspected interval                                                   | Effect on this repository                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Testing                         | `/testing`, real test contexts, mock clients, HTTP app boots, cache/env cleanup | Direct reduction candidate for integration-test scaffolding. See [testing exports](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/testing/index.ts#L42).                                                                                                                                                                                         |
| Database                        | Typed entity API, generated reads/writes, hooks and transactions                | New application feature and wrapper compatibility work; not a general storage migration. See [database plugin](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/plugins/database/database.ts#L37).                                                                                                                                                 |
| Agent authoring                 | Code-agent discovery, registry/default resolution, curated skills               | Simpler native-app option. Mastra definitions carry a different runtime contract. See [discovery](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/core/agent/load-code-agents.ts#L80) and [skill configuration](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/core/agent/types.ts#L228). |
| Evaluations                     | `EvalDriver`, matchers, datasets, judges, reports and suite execution           | Reuse test orchestration through a small supported driver. See [eval contracts](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/evals/types.ts#L53).                                                                                                                                                                                              |
| Model inference                 | `fromAiGateway` and Gateway Chat Completions routing                            | Useful for exact Chat model IDs; not Responses inference or endpoint ranking. See [Gateway transport](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/connectors/serving/client.ts#L133).                                                                                                                                                         |
| Lifecycle                       | Joinable teardown and non-exiting test shutdown                                 | Makes native lifecycle behavior easier to verify. The 15s/10s/2s budgets already existed. See [lifecycle](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/core/lifecycle-manager.ts#L11).                                                                                                                                                         |
| Server builds                   | `/tsdown` preset with code-agent entry discovery                                | Optional native server-build integration. No current duplicate tsdown setup to delete. See [preset](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/tsdown/index.ts#L43).                                                                                                                                                                         |
| Genie                           | No material new connector execution behavior                                    | Native still polls the Conversation API. Keep Agent Mode. See [Genie connector](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/connectors/genie/client.ts#L93).                                                                                                                                                                                  |
| AI Search                       | No material new query or React-hook capability                                  | Continue delegating Vector Search queries upstream; retain extensions. See [native query policy](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/plugins/ai-search/ai-search.ts#L150).                                                                                                                                                            |
| Tables, charts, UI primitives   | No relevant supplied-data table, scoped-theme, or assistant-shell replacement   | Consider existing primitive reuse separately from the version bump. See [table contract](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit-ui/src/react/table/types.ts#L32) and [theme hook](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit-ui/src/react/charts/theme.ts#L93).                      |
| SDK facade and persistent cache | Internal SDK facade relocation; no equivalent AbortSignal API or ownership fix  | Keep the narrow SDK/cancellation and cache seams. See [workspace client](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/shared/src/workspace-client/client.ts#L1) and [persistent storage](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/cache/storage/persistent.ts#L53).                         |

## Findings register

High means a correctness/policy gap or a required upgrade integration gate;
Medium means material maintenance or reuse value; Low means an optional bounded
improvement. Effort S is roughly one day, M several days, and L a substantial
design effort. These are planning bands, not delivery estimates. **Keep** rows
are reviewed dispositions, not requests to rewrite the corresponding packages.

| ID   | Category                          | Repository evidence                                                                                                   | Severity | Effort | Recommendation and status                                                                                                                                          |
| ---- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AK01 | Upgrade ownership                 | `projen/src/pnpm-workspace.ts:90`, `.projenrc.ts:413`                                                                 | High     | M      | **Complete.** AppKit/AppKit UI are exact-aligned at 0.81.0; synthesis, full compile, plugin catalog, and packed consumer root/beta/testing/tsdown/UI imports pass. |
| AK02 | New native reuse                  | `packages/js/node/appkit-graphiti/test/plugin.test.ts:114`, `packages/js/node/appkit-mastra/test/toolkit.test.ts:56`  | Medium   | M      | **Complete.** Selected router and plugin contexts use the public testing kit; sidecar, MCP, and external-service fakes remain domain-owned.                        |
| AK03 | New plugin compatibility          | `packages/js/node/appkit/src/appkit.ts:96`, `:140`, `:228`                                                            | High     | M      | **Complete.** Automatic resolution recognizes `database` and `lakebase`, preserves explicit modes, avoids another plugin/pool, and limits implicit grants.         |
| AK04 | Existing lifecycle overlap        | `packages/js/node/appkit/src/interceptor.ts:115`, `:125`, `:148`                                                      | Medium   | M      | **Retained.** Native close is joined/idempotent, but no public production shutdown handle preserves SIGHUP, early child failure, status, and full grace.           |
| AK05 | Existing provider-policy mismatch | `packages/js/node/search/src/lakebase-plugin.ts:27`, `:116`, `:178`                                                   | High     | S–M    | **Complete.** HTTP projection is bounded by configured columns; programmatic overrides remain trusted and route auth supports explicit SP/OBO modes.               |
| AK06 | New evaluation reuse              | `packages/js/node/appkit-mastra/src/chat.ts:1`, `packages/js/node/appkit-mastra/src/mlflow.ts:35`                     | Medium   | M      | **Complete.** An in-process imported-contract `EvalDriver` maps native Mastra generate results; production feedback, tracing, and chat remain separate.            |
| AK07 | Native authoring alternative      | `packages/js/node/appkit-mastra/src/agents.ts:170`, `packages/js/node/appkit-mastra/src/workspaces.ts:171`            | Medium   | S–M    | **Complete.** A focused native code-agent, curated-skill, and tsdown fixture documents the simple path and its SP/async limitations; Mastra runtime remains.       |
| AK08 | Toolkit contract parity           | `packages/js/node/appkit-mastra/src/agents.ts:953`, `:1019`, `packages/js/node/appkit-graphiti/src/plugin.ts:476`     | High     | S–M    | **Complete.** Legacy destructive annotations require approval and type-owned local toolkit entry construction is shared without private AppKit imports.            |
| AK09 | Inference and Genie boundaries    | `packages/js/node/appkit-mastra/src/model.ts:46`, `packages/js/node/genie/src/chat.ts:131`                            | Medium   | —      | **Keep.** Native Gateway Chat and polling Genie do not replace model policy, stateless Responses, or Agent Mode.                                                   |
| AK10 | Private cache and runtime seams   | `packages/js/node/appkit/src/_cache-storage.ts:59`, `src/databricks.ts:32`, `src/appkit.ts:379`                       | Medium   | M      | **Complete; retained.** 0.81 constructor and cancellation/context tests pass; ownership fallback remains required for DML-only existing tables.                    |
| AK11 | Existing UI primitive reuse       | `packages/js/ui/search/src/react/search-box.tsx:79`, `packages/js/ui/mastra/src/react/mastra-assistant.tsx:288`       | Medium   | M      | **Complete.** SearchBox uses Command with remote ordering; assistant shell reuse was declined because native overlays unmount and resize by percentage.            |
| AK12 | UI protocol and rendering         | `packages/js/ui/mastra/src/react/chat-sessions.ts:20`, `src/react/data-grid.tsx:191`, `src/support/chart-theme.ts:86` | Medium   | —      | **Keep.** Native chat, DataTable and charts do not meet the concurrent-session, materialized-data or scoped-theme contracts.                                       |
| AK13 | New build preset                  | `projen/src/bun-app.ts:125`, `packages/example/server/appkit-demo/stage-deploy.ts:77`                                 | Low      | S      | **Complete, scoped.** Native `appkitServerConfig` is proven in the code-agent fixture and declined for generic Projen/demo builds.                                 |
| AK14 | Package positioning               | `AGENTS.md:869`, `README.md:22`, `packages/js/ui/appkit/src/react/appkit-ui.ts:9`                                     | Medium   | S      | **Complete.** Canonical/package docs reflect 0.81 reuse and retained boundaries; no package merger or retirement is justified.                                     |

## Top five implementation priorities

### 1. Make the paired upgrade reproducible (AK01, AK10)

Change the generator's catalog, not generated package manifests. Synthesize with
the repository's Bun workflow, refresh the lockfile, and verify the root,
`/beta`, `/testing`, UI, and optional `/tsdown` entrypoints from an installed
consumer. The current optional-peer declaration for `@dbx-tools/appkit` also
comes from the catalog; decide deliberately whether the published packages
support only the new minor or an explicitly tested older range.

Preserve the exact shared Zod pin and framework singleton resolution
(`projen/src/pnpm-workspace.ts:78`, `projen/src/bun-app.ts:35`). AppKit 0.81
continues to depend on SDK experimental 0.17.0, updates its Lakebase dependency
from 0.5.0 to 0.6.0, and declares optional `@mlflow/core`, `autoevals`, and Vitest
peers. Optional evaluation features must not silently become runtime requirements
for every consumer; inspect the [published dependency contract](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/package.json#L45).

Keep the cache adapter during this step. Native `PersistentStorage.initialize`
still runs migrations and rethrows, while `CacheManager` can disable cache on a
strict-persistence failure ([storage](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/cache/storage/persistent.ts#L53), [manager](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/cache/index.ts#L178)). The
dbx-tools adapter probes existing tables under DML-only credentials; deleting it
would change supported deployments. Its private file/class access is a concrete
upgrade risk even though the underlying implementation barely changed.

Acceptance:

- Fresh install, deterministic synthesis, affected-package compilation, current
  tests and demo browser build pass with one selected AppKit/UI pair.
- A packed consumer resolves public exports without this repository's source
  aliases or undeclared peers. Browser bundles contain no Node-only stream or
  native-binding imports introduced by the change.
- Exercise cache schema ownership, DML-only existing tables, missing tables,
  unrelated migration failure, unhealthy connections, strict persistence,
  caller-provided storage and read/write behavior. Preserve existing grant scope.
- Preserve OBO request identity, caller `AbortSignal`, native plugin discovery,
  multiple isolated extension runtimes and non-App execution-context fallback.

### 2. Replace test scaffolding with native contexts before further refactors (AK02)

Use public `createTestPlugin`, `createTestPluginContext`, `createTestApp`,
`createMockRequest`, and `expectStream`. These exercise actual config merging,
route registration, dispatch, user scoping and teardown instead of incomplete
structural assertions. Start with the Graphiti router and Mastra toolkit fixtures
identified in the register. See [testing exports](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/testing/index.ts#L42),
[plugin construction](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/testing/create-test-plugin.ts#L12), and [context attachment](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/testing/test-plugin-context.ts#L233).

The source imports Vitest, but **a separate runner is not currently required**:
the published kit was successfully exercised with Bun 1.3.14, `node:test`, and
no installed Vitest package. Bun provides the test-runner compatibility. Keep
these imports inside test files; importing the kit from ordinary `bun` execution
without its optional Vitest peer fails. Extend this probe for each adopted helper
before adding a runner or a compatibility layer.

`createTestApp` permits one live app per process and must be closed before another
boot ([harness lifetime](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/testing/create-test-app.ts#L228)). Its resource validation does not validate
arbitrary plugin configuration against `manifest.config.schema`. Do not count
it as schema coverage or remove real validation tests. Keep explicit fakes for
Python/Caddy/Graphiti, email transport, and platform services outside the harness.

Acceptance: real route mounts and error responses; OBO and missing-token cases;
abort and timeout propagation; resource failures; two sequential boots; joined,
idempotent close; environment/cache restoration; stream ordering. Delete the
superseded fake-router/context setup only after equivalent behavior passes.

### 3. Support native database demand without duplicating storage (AK03)

The current wrapper gates automatic resolution and soft-cache handling on a
plugin named `lakebase`. A database-only app can therefore bypass the wrapper's
environment resolution even though native `database()` owns a Lakebase pool
([plugin](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/plugins/database/database.ts#L37), [pool initialization](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/plugins/database/lifecycle.ts#L183)). An explicit
`autoConfigure: "env"` is the existing workaround when resolution is needed.

Generalize the detection of the native plugins that require the existing
resolver. Preserve `autoConfigure: false` and caller environment precedence.
Decide explicitly when cache-schema provisioning is appropriate; recognizing a
database plugin should not implicitly broaden grants. Do not add `lakebase()`
just to trigger setup or create a second application pool.

The new native `initializeLakebasePool` helper is internal and is not exported
from the package root. It also performs a different job: startup identity and
pool setup, rather than flexible project/resource/URI discovery and environment
output. Keep `lakebase-resolver.ts` and `cli-appkit-env`; do not deep-import the
initializer ([native initializer](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/connectors/lakebase/index.ts#L28)).

Use native `database()` for future application-owned typed entities and CRUD.
It is not a replacement for Better Auth's schema/migrations, Mastra's storage
adapter, the Graphiti journal, Postgres advisory locks or LISTEN/NOTIFY.

Acceptance: database-only, lakebase-only, both and neither; complete platform
environment versus unresolved local address; explicit `"env"`, `"provision"`
and `false`; no duplicate application pool; no changed auth-library schema
ownership. Add native read/write/hook tests only for application features that
actually adopt this plugin.

### 4. Close the two concrete policy-parity gaps (AK05, AK08)

**Lakebase search:** its HTTP handler passes `req.body` to programmatic `query`,
which gives `request.columns` precedence over configured columns. Native AI
Search intentionally drops HTTP-supplied columns while retaining trusted
programmatic overrides ([native route](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/plugins/ai-search/ai-search.ts#L150)). If stored documents contain
fields omitted from the configured projection, the current Lakebase route can
return them when a caller names them. This mismatch predates 0.81.

Strip or constrain HTTP projection through the configured policy before calling
the shared query implementation. The public Lakebase index config also inherits
native `auth`, but its route does not select native `asUser` behavior. Explicitly
reject unsupported auth modes or implement and prove their meaning; matching
route/response shapes is not full OBO parity.

Acceptance: configured `[id, title]` cannot be widened by HTTP to a stored
internal field; trusted programmatic overrides remain documented; unsupported
auth fails at setup; invalid bodies and unknown aliases return bounded errors.
Keep native Vector Search execution upstream and the custom Lakebase full-text
backend separate.

**Toolkit approval:** the local Mastra adapter checks `annotations.effect`,
while native approval also recognizes `annotations.destructive === true`
(`agents.ts:1019`; [native approval](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/plugins/agents/approval.ts#L12)). Include both supported native
signals so a legacy destructive tool does not lose its approval classification.
Test the full approval/execute path, not just a Boolean helper.

Small toolkit-entry construction is duplicated locally and upstream, but the
native construction/resolution helpers are absent from the public beta barrel.
Consolidate the local code only if that reduces real duplication, using imported
`ToolkitEntry`, `ToolkitOptions` and annotation types. Do not add handwritten
contract mirrors or private imports ([internal helper](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/core/agent/build-toolkit.ts#L22),
[public barrel](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/beta.ts#L47)).

Preserve async tool discovery and the trusted fourth resource-ID argument.
Native toolkit construction and `AgentDefinition.tools` factory callbacks remain
synchronous; tool execution itself can return a promise. Graphiti must await MCP
discovery before producing its toolkit.
Acceptance includes plain ToolProviders, sync/async toolkits, filter/rename
precedence, read-only/mutating/legacy-destructive annotations, cancellation,
two resource IDs, forged group overwrites and structured result fidelity.

### 5. Reduce competing shutdown ownership with real subprocess tests (AK04)

The dbx-tools interceptor installs signal listeners and a process-exit timer
with a 10-second child grace. Native AppKit separately owns SIGINT/SIGTERM,
plugin shutdown, cache close and telemetry flush. Its total budget is 15 seconds,
with 10-second plugin and 2-second phase limits. These budgets already existed
in 0.60; the new joinable/non-exiting teardown improves verification, not child
supervision ([native lifecycle](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/core/lifecycle-manager.ts#L11)).

The independent dbx-tools timer can preempt native cleanup. In the other
direction, a quickly completed native shutdown can exit before a child uses
the promised grace. Prefer native plugin shutdown participation for child drain,
with one application exit owner. Keep signal forwarding and escalation as the
small custom responsibility. A public production shutdown handle was not found;
child-failure-triggered shutdown may require an upstream seam. Do not reach into
the internal lifecycle manager to make the refactor appear complete.

Acceptance: subprocess fixtures cover SIGINT, SIGTERM, SIGHUP, child failure,
simultaneous termination, graceful child exit, a hanging child, no-server mode,
exit status and final cache/telemetry cleanup. Existing tests that remove process
listeners and manually emit wrapper events do not establish native integration
(`packages/js/node/appkit/test/interceptor.test.ts:31`, `:121`). Retain the
current supervisor until the replacement passes these tests.

## Further bounded reuse

### Native agent authoring and skills (AK07)

Add a small native-agent example or documentation path for apps needing AppKit
toolkits, exact Chat model IDs, simple history, and curated skills. Native code
discovery expects branded AppKit agent definitions and conventional source or
compiled directories ([discovery](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/core/agent/load-code-agents.ts#L80), [factory](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/core/agent/create-agent.ts#L14)).
The local Mastra factory returns a different definition, adds a workspace, and
preserves Mastra request context, memory and approvals. It cannot become an
alias of the native factory. Avoid building a parallel discovery engine solely
to reproduce the native convenience.

Native skills now provide progressive disclosure and local/volume sources, but
volume discovery runs as the service principal and `skillCredentialMode: "obo"`
is explicitly unwired ([configuration](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/core/agent/types.ts#L228)). Keep the per-request
Assistant trees, writable user mounts, custom filesystems, pinned remote skill
sources and refresh bounds (`workspaces.ts:369`, `:421`, `remote-skills.ts:148`,
`:191`, all under `packages/js/node/appkit-mastra/src`). Skills do not replace
Databricks Sandbox or the Monty fallback.

Acceptance for the native example: source/compiled discovery, default and
duplicate handling, a supported dbx-tools ToolProvider, curated skill visibility
and collisions, and no `@dbx-tools/appkit-mastra` runtime/plugin. Existing dbx-tools
tool packages still bring transitive Mastra dependencies; use an AppKit-only
baseline if testing their complete absence. Keep OBO-required workloads on the
existing path until two-identity isolation and no SP fallback are demonstrated.
Async Graphiti registration requires a deliberate bridge; do not advertise
unqualified compatibility with native synchronous toolkit registration.

### Evaluation and feedback (AK06)

Trial `runEval` with a small Mastra implementation of the imported `EvalDriver`
contract. Reuse native assertions, dataset helpers and reports. The native HTTP
driver sends `{ message, agent, threadId }` and parses Responses-shaped agent
events; changing its URL does not make it a Mastra AI SDK transport
([driver](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/evals/http-driver.ts#L87)). Observe completed messages/tools through supported
Mastra APIs and translate test observations into `DriveResult`; do not write a
second production chat reducer. In 0.81, `runEvalsInDir` has no custom-driver
option and constructs its HTTP driver internally ([suite runner](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/evals/run-evals.ts#L211)).
Use `runEval` as the supported reuse boundary; suite-level driver injection
requires an upstream API change.

Acceptance: deterministic tool name/argument assertions, two turns, reset,
failure, timeout cancellation and concurrent trace attribution. Normalize
third-party report glyphs before forwarding output. Keep optional judges and
MLflow dependencies behind evaluation usage.

Native `reportToMlflow` reports evaluation results, including V3/V4 trace
routing; it is not an arbitrary HUMAN feedback API that returns assessment IDs
([reporting](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/evals/mlflow-report.ts#L118)). Retain `packages/js/node/appkit-mastra/src/mlflow.ts:95`
and the AppKit-global OTel bridge. Investigate classic and UC-backed trace
fixtures, ingestion lag, HUMAN attribution, OBO renewal and assessment IDs
before sharing more transport. No duplicate exporter or production trace-store
change is part of this upgrade.

### UI primitives and server builds (AK11, AK13)

- **SearchBox:** replace generic keyboard-selection/list markup with AppKit's
  existing Command primitives ([Command](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit-ui/src/react/ui/command.tsx#L14)), using remote results and
  `shouldFilter={false}`. Preserve `useSearch`, render customization and index
  badges. Verify arrows, Enter/Escape, server ranking, duplicate IDs across
  indexes, asynchronous replacement, loading/error/empty/clear states and labels.
- **Assistant shell:** investigate existing Dialog/Sheet and Resizable primitives
  for focus and sizing mechanics. Keep the controller and persistent chat
  driver. Native wrappers create their own portal/overlay and do not expose
  every portal persistence control ([Sheet](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit-ui/src/react/ui/sheet.tsx#L59)); content `forceMount`
  alone does not prove close/reopen persistence. Require retained in-flight
  turns, draft and scroll, nested popovers, focus restoration, all four edges,
  breakpoint transitions, per-orientation sizing and pointer cleanup before
  deleting manual listeners. This is a bounded experiment, not an approved
  wholesale shell rewrite.
- **Server preset:** if the native example uses compiled code agents, use public
  `appkitServerConfig` for entry union, externals and stale-output cleanup
  ([preset](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/tsdown/index.ts#L43)). The current demo runs source and Projen owns Bun browser
  builds. There is no tsdown duplication to delete, and no reason to replace
  polyglot package discovery, publication or generation with an app scaffold.

## Code and package boundaries to retain

These are explicit keep decisions, including code that initially looked like a
native replacement candidate.

| Local area                                              | Why 0.81 is insufficient                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Reconsider only when                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| AppKit resolver, CLI, safe context and SDK cancellation | Flexible address/env discovery remains custom; native context throws before initialization; the WorkspaceClient services still use legacy SDK cancellation. Evidence: `packages/js/node/appkit/src/lakebase-resolver.ts:305`, `src/databricks.ts:32`, `src/appkit.ts:379`; [SDK facade](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/shared/src/workspace-client/client.ts#L1).                                                                                                                                                                                         | Public APIs preserve those inputs, cancellation and non-request usage.                                 |
| Mastra runtime and UI                                   | Native `useAgentChat` cancels the previous send and consumes its own protocol. It does not provide concurrent sessions, steering queues, per-run context, durable approval resumes or the persistent assistant shell. Evidence: `packages/js/ui/mastra/src/react/chat-stream.ts:66`, `src/react/chat-approvals.ts:25`; [native hook](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit-ui/src/react/hooks/use-agent-chat.ts#L201).                                                                                                                                    | Full protocol, memory, concurrency and approval parity is demonstrated.                                |
| Model packages and Rust proxy                           | Gateway support invokes Chat Completions. Native agent Responses-shaped output does not imply upstream Responses inference. Keep Rust-owned capability/ranking policy and stateless `store:false` continuation. Evidence: `packages/js/node/model/src/resolve.ts:140`, `src/invoke.ts:35`; [Gateway transport](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/connectors/serving/client.ts#L133).                                                                                                                                                              | Responses-only models, tool replay, capability filtering, overrides and identity all pass.             |
| Genie/shared Genie and progress bridge                  | Native connector uses Conversation API polling; its toolkit collects events before returning. Keep Agent Mode terminal validation, pre-stream fallback, cancellation and inline-result projection. Evidence: `packages/js/node/genie/src/agent-mode.ts:81`, `:102`; [native polling](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/connectors/genie/client.ts#L93).                                                                                                                                                                                           | Native public events satisfy the standalone async-iterator and snapshot contracts.                     |
| Native-search extensions and Lakebase full text         | Native owns Vector Search queries, OBO, cache, reranking and pagination; it adds no Lakebase full-text backend or extension toolkit here. Current delegation is already correct. Evidence: `packages/js/node/search/src/plugin.ts:201`, `src/native.ts:82`, `packages/js/ui/search/src/react/use-search.ts:76`; [native query](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/plugins/ai-search/ai-search.ts#L150).                                                                                                                                            | A public native extension actually covers fan-out, index lifecycle or full text.                       |
| Static DataGrid and chart adapter                       | Native DataTable requires `queryKey`/`parameters`; it has no supplied rows/columns API. Native theme tokens use a root cache, while local charts read the chart element and support full planner options plus light export. Evidence: `packages/js/ui/mastra/src/react/data-grid.tsx:191`, `src/support/chart-theme.ts:86`; [table](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit-ui/src/react/table/types.ts#L32), [theme](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit-ui/src/react/charts/theme.ts#L93). | Raw IDs/nulls/arbitrary headings, sorting/CSV, scoped themes, brand changes and export remain correct. |
| Graphiti sidecar and MCP server                         | Native outbound MCP declarations/client calls do not republish a user-scoped server, supervise Python/Caddy or overwrite groups. Its MCP client joins text content, which can lose structured results. Evidence: `packages/js/node/appkit-graphiti/src/plugin.ts:293`, `:332`, `:466`; [native MCP call](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/connectors/mcp/client.ts#L337).                                                                                                                                                                        | Lifecycle, structured payloads, discovery timing, cancellation and group isolation match.              |
| Email, web search, Teams, auth and branding             | Existing tool plugins already use native registry helpers. Native 0.81 does not supply SMTP approval policy, independent web-capable model selection, Bot JWT/reply handling, Better Auth passkeys or portable brand/email presentation. Evidence: `packages/js/node/email/src/plugin.ts:124`, `packages/js/node/appkit-web-search/src/plugin.ts:156`, `packages/js/node/teams/src/plugin.ts:147`; [public exports](https://github.com/databricks/appkit/blob/113094713e4c2094bfe55983e2d2da89bed65208/packages/appkit/src/beta.ts#L47).                                                                               | A domain-equivalent public integration exists and passes its policy checks.                            |
| Thin UI foundation and shared contracts                 | `packages/js/ui/appkit/src/react/appkit-ui.ts:9` already re-exports native components. Shared packages protect browser-safe runtime schemas; they are not a second native component library.                                                                                                                                                                                                                                                                                                                                                                                                                           | Actual dependency reach or contract ownership changes, not merely package count.                       |
| Postgres, Rust/Python and Projen boundaries             | Native typed CRUD and an app build preset do not own cross-language auth, release binaries, locks, topic buses, journals or reusable workspace publication.                                                                                                                                                                                                                                                                                                                                                                                                                                                            | A separately scoped comparison proves the same consumer contract.                                      |

## Delivery sequence and completion gates

| Phase | Focused change                                                            | Exit condition                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | AK01 paired upgrade and AK10 compatibility fixtures                       | Real install, packed-consumer check, compile, existing tests and demo build pass; no unsupported private seam silently removed.                                                    |
| 2     | AK02 selected harness migration; AK03 database-only auto-configuration    | Native harness works under Bun for the adopted helpers; new plugin compositions pass without duplicate pools or changed grant policy.                                              |
| 3     | AK05 search policy and AK08 annotation parity                             | Behavior tests prove bounded HTTP projection, explicit auth semantics and fail-closed legacy destructive approval. These fixes can land earlier on 0.60 independently.             |
| 4     | AK04 lifecycle consolidation                                              | Subprocess tests prove one app shutdown sequence, preserved child grace and complete native cleanup; otherwise retain the supervisor and record the upstream API gap.              |
| 5     | AK07 native example; AK06 evaluation trial; optional AK11/AK13 reductions | Each experiment meets its own parity gate, or records an explicit retain/decline decision. No dependency on completing every optional migration.                                   |
| 6     | AK14 documentation and audit closure                                      | Update canonical AGENTS guidance first where behavior changed, then affected package READMEs and root positioning; mark each row complete/retained/declined and archive this plan. |

Keep runtime changes separated from optional UI or native-agent experiments so
failures can be attributed and rolled back. Do not remove deprecated public
exports merely because an internal implementation shrinks. Refresh line
citations and the comparison version if implementation begins against a newer
AppKit release.

## Verification performed and limits

The declaration probe used each package's existing compiler options with
`noEmit`, first against installed 0.60.0 and then with TypeScript path mappings
to the published 0.81.0 root/beta/UI declarations. It covered Node AppKit,
AppKit-Mastra, Search, Graphiti, Web Search, Email, Teams, Auth Gate, Tunnel;
UI AppKit, Mastra, Search; and CLI AppKit Env. Both passes produced zero
diagnostics after mapping React, Express and Postgres type dependencies to the
repository's installed copies. An initial unaligned fixture produced missing
React/Express inference and duplicate Postgres-type errors; those were fixture
dependency differences, not established AppKit API breaks.

Two published-package Bun tests passed with `node:test`. They exercised a real
native plugin context, fake tool dispatch and OBO attribution, then real HTTP
routing across two sequential app boots, joined/idempotent close, a single
plugin shutdown per boot and environment restoration. This validates a useful
testing-kit subset, not every Vitest API or the entire repository's integration
suites. Source and export-map checks verified the private-helper limitations.

Implementation upgraded the installed and generated AppKit/AppKit UI pair to
0.81.0. Synthesis, the complete TypeScript workspace compile, focused package
tests, a packed external consumer, native testing contexts, database-demand
policy, cache constructor tripwire, SDK cancellation, search projection/auth,
toolkit annotations, EvalDriver, native code-agent/skill fixture, native
lifecycle close, and demo browser build all passed. Live Lakebase migrations,
AI Gateway calls, and production OBO permissions remain deployment acceptance
concerns rather than unit-test claims.

## Decisions to settle during implementation

- **Published version support:** 0.81.0 is the exact-tested baseline; no
  unverified dual-version claim is made.
- **Database configuration:** `database` and `lakebase` both trigger resolution;
  only explicit provision or native Lakebase demand broadens cache grants.
- **Native example:** one focused code-agent/skill/tsdown fixture documents the
  simple path; the feature demo remains Mastra-based.
- **Optional reuse:** Command and EvalDriver reuse landed. The assistant shell,
  generic tsdown adoption, lifecycle supervisor replacement, production
  feedback transport replacement, model policy, and Genie Agent Mode were
  retained or declined at their recorded parity gates.

## Pinned upstream sources

All links resolve within AppKit commit
`113094713e4c2094bfe55983e2d2da89bed65208` (tag `v0.81.0`). Published declarations
and package exports were also inspected; source-only functions are not treated
as consumer APIs.

# AppKit Best Practices

Distilled conventions from [`databricks/appkit`](https://github.com/databricks/appkit)
and the [AppKit v0 docs](https://developers.databricks.com/docs/appkit/v0),
written as house rules for authoring `@dbx-tools/*` AppKit plugins, packages,
and docs. Read this before adding or changing an AppKit-facing plugin.

The goal is that a `dbx-tools` plugin is indistinguishable in shape, ergonomics,
and documentation from a first-party AppKit plugin - so an app author (or an
agent) who knows AppKit already knows our packages.

The AppKit source itself is the ground truth. Two ways to consult it:

```sh
# API reference index (always run with no query first - do not guess paths)
npx @databricks/appkit docs
npx @databricks/appkit docs ./docs/plugins/custom-plugins.md

# Installed copy also ships docs + llms.txt
ls node_modules/@databricks/appkit/docs
```

This file is a distillation, so it can drift from the AppKit version actually
installed. Confirm any symbol against the installed typings before you implement
against it - `Plugin` lives in `dist/plugin/plugin.d.ts`, the interceptor option
bags in `dist/shared/src/execute.d.ts`, and the error classes under
`dist/errors/`. A prescription here that the pinned version does not export is a
bug in this file; fix it here rather than working around it in a package.

## AppKit's Core Principles

AppKit publishes seven principles. They are the "why" behind every convention
below, and our packages inherit them:

1. **Highly opinionated** - strong defaults, advanced customization when needed.
2. **Built for application use cases** - an application SDK, not a service wrapper.
3. **Delightful developer experience** - plug-and-play interfaces, examples, docs.
4. **Zero-trust security** - minimal surface area, fail safely, validate all input.
5. **Optimized for humans and AI** - every API discoverable, self-documenting, inferable.
6. **Production-ready from day one** - observability and reliability from the first commit.
7. **Layered extensibility** - high-level plugins, low-level primitives, extension points.

Practical consequence for this repo: a package that only works when the caller
already knows the exact serving endpoint alias, secret name, or SSE frame shape
is not finished. Resolve, default, and validate on the caller's behalf.

## Plugin Authoring

### Canonical Shape

Every plugin is a `Plugin` subclass with a static manifest, exported through
`toPlugin()` so `createApp({ plugins: [...] })` gets a typed factory:

```ts
import { Plugin, toPlugin, type IAppRouter, type PluginManifest } from "@databricks/appkit";

export class MyPlugin extends Plugin<MyPluginConfig> {
  static manifest = {
    name: "my-plugin",
    displayName: "My Plugin",
    description: "One sentence on what this plugin does for the app.",
    stability: "beta",
    resources: { required: [], optional: [] },
    config: { schema: MY_CONFIG_SCHEMA },
  } satisfies PluginManifest<"my-plugin">;

  override async setup(): Promise<void> {}
  override injectRoutes(router: IAppRouter): void {}
  override exports() {
    return {};
  }
}

export const myPlugin = toPlugin(MyPlugin);
```

Rules we follow:

- `name` matches `^[a-z][a-z0-9-]*$` (schema-enforced). It is the registry key,
  the route mount (`/api/<name>`), and the `AppKit.<name>` accessor, so it is
  effectively public API - treat a rename as a breaking change.
- Use `satisfies PluginManifest<"<name>">` on an inline manifest so the literal
  name flows into `toPlugin()`'s inferred factory type. AppKit's own plugins use
  `manifest.json` + `as PluginManifest<"...">` because the CLI reads their JSON
  from `dist/plugins/<name>/`; our packages ship a single barrel and are not
  scanned that way, so inline `satisfies` (better type inference, no
  `resolveJsonModule`) is the house form.
- Export both the class and the factory. The class is what callers need for
  `InstanceType<...>` typing and sibling lookup; the factory is what they
  register.
- `resources.required` / `resources.optional` are always present, even when
  empty - the schema is `strict()` and requires both keys.
- Set `stability: "beta"` until an API is settled. Absent means GA and implies
  strict semver. There is no reverse promotion path.

### Lifecycle And Phases

- `static phase: PluginPhase` is `"core" | "normal" | "deferred"`; default
  `"normal"`. Only take `"deferred"` when you must read other plugin instances
  at construction (AppKit's `server` plugin does this to collect routes). Prefer
  sibling lookup at request time over phase games.
- `setup()` is the async init hook, awaited for all plugins before
  `onPluginsReady`. Do connectivity checks and config resolution here so a
  misconfiguration shows up in boot logs, not on the first user request.
- `shutdown()` releases resources. Graceful shutdown has a 15s budget and runs
  every plugin's hook, so make it bounded and idempotent.
- `abortActiveOperations()` already aborts the plugin's `StreamManager`; extend
  it only for additional in-flight work.
- Constructors must tolerate being called before core services exist. Never
  touch `this.cache` / `this.telemetry` in a constructor unless you also handle
  them being unbound; prefer `setup()`.

### Config Resolution

- Config type extends `BasePluginConfig` (which carries `name`, `host`,
  `telemetry`, and an index signature).
- Publish the config shape as JSON Schema on `manifest.config.schema`. This is
  what tooling and scaffolding agents read; keep every property `description`d.
- Precedence is **explicit plugin config → environment variable → default**.
  Document the env name on the same line as the field in both the TS doc comment
  and the JSON Schema description.
- Follow AppKit's env naming when a resource is a Databricks resource:
  `DATABRICKS_WAREHOUSE_ID`, `DATABRICKS_GENIE_SPACE_ID`,
  `DATABRICKS_SERVING_ENDPOINT_NAME`, `DATABRICKS_VOLUME_<KEY>`,
  `DATABRICKS_JOB_<KEY>`. Unprefixed names (`SMTP_HOST`, `EMAIL_DOMAIN`) are for
  non-Databricks third-party services only.
- Support the **alias map** pattern for plugins that can address several of the
  same resource: `{ spaces: { sales: "...", support: "..." } }`, falling back to
  `{ default: <env value> }`. Alias becomes the route segment and tool-name
  prefix.
- Support **env auto-discovery** where AppKit does: scan `process.env` for
  `PREFIX_*` keys, merge with explicit config, explicit config wins per key.
- **Fail loudly at construction on a config contradiction** (an alias mapped to
  an undefined id) with a message naming the field and the env var to set.
  AppKit's Genie plugin is the model here.

### Resource Requirements

- Declare Databricks resources in the manifest, not in prose. `required` is
  always needed; `optional` is may-be-needed, and both are read by static
  tooling (CLI init, `plugin sync`, app scaffolding).
- For config-dependent resources, list them under `optional` and implement
  `static getResourceRequirements(config)` returning entries with
  `required: true` at runtime. That gives static tools the full picture and the
  runtime registry the accurate one.
- Reuse an upstream plugin's manifest resources instead of retyping them when
  you consume the same binding, so existing `app.yaml` wiring keeps working:

```ts
const GENIE_MANIFEST = plugin.data(genie).plugin.manifest;
// ...
resources: { required: [], optional: [...GENIE_MANIFEST.resources.required] }
```

- Permission enums are per resource type and ordered weakest→strongest
  (`CAN_VIEW < CAN_MANAGE_RUN < CAN_MANAGE`). Ask for the weakest that works.
- Each resource field carries an `env` and a `description`; add `discovery` when
  the CLI should offer candidate values, preferring the `kind` variant
  (`warehouse`, `genie_space`, `volume`, `postgres_*`) over the free-form `cli`
  escape hatch.

### Routes

- Register through `this.route(router, { name, method, path, handler })` - never
  `router.get(...)` directly. `route()` adds async error forwarding and records
  the endpoint in the plugin's endpoint map, which is what the client can
  discover. `skipBodyParsing: true` is for upload routes.
- Paths are mount-relative; AppKit mounts the plugin at `/api/<plugin name>`.
  Do not hard-code the `/api/<name>` prefix in `path`.
- Validate inputs in the handler and return the specific status:
  `404` for an unknown alias, `400` for a missing field. Keep messages
  actionable but free of upstream/internal detail.
- Wrap user-scoped handlers with `this.asUser(req)` at the route boundary, then
  keep the private handler oblivious to auth:

```ts
this.route(router, {
  name: "sendMessage",
  method: "post",
  path: "/:alias/messages",
  handler: async (req, res) => {
    await this.asUser(req)._handleSendMessage(req, res);
  },
});
```

- Use path suffixes for scoping (`/history/:agentId`), not query params, when the
  scope is part of the resource identity.

### Execution: `execute()` And `executeStream()`

Route all outbound I/O through the interceptor pipeline. It is how a plugin gets
caching, retry, timeout, and telemetry for free - including the
`execution.context` / `caller.id` span attributes that make OBO calls
auditable.

- Interceptor order is telemetry → timeout → retry → cache.
- `execute()` returns `ExecutionResult<T>`: `{ ok: true, data }` or
  `{ ok: false, status, message }`. **It never throws.** Callers branch on `ok`;
  handlers map `status` straight onto the HTTP response.
- `executeStream(res, handler, settings)` handles SSE: the handler is an async
  generator receiving an `AbortSignal`. Pass a stable `stream.streamId` so a
  reconnecting client can replay from the ring buffer via `Last-Event-ID`.
- Always forward the `AbortSignal` into awaited I/O; a plugin whose cancel
  doesn't unwind is a bug.
- Choose interceptor defaults deliberately and **comment the reasoning**, per
  AppKit's `defaults.ts` convention:

```ts
export const genieStreamDefaults: StreamExecutionSettings = {
  default: {
    // Cache disabled: chat messages are conversational and stateful, not repeatable queries.
    cache: { enabled: false },
    // Retry disabled: Genie calls are not idempotent (retries could create duplicate
    // conversations/messages), and the SDK Waiter already handles transient polling failures.
    retry: { enabled: false },
    timeout: 120_000,
  },
  stream: { bufferSize: 100 },
};
```

Read operations cache and retry; writes and conversational turns do neither.
Keep the defaults in a sibling `defaults.ts`, not inline at the call site.

- Poll loops use exponential backoff with jitter and an abortable sleep, capped
  by an explicit timeout. Copy the shape from AppKit's jobs plugin rather than
  reinventing it.

### Exports And Client Config

- `exports()` is the public programmatic API surface (`AppKit.myPlugin.foo()`).
  AppKit binds `this`, recurses into nested plain objects, and adds
  `asUser(req)` automatically. Return only what you intend to support.
- `clientConfig()` publishes boot-time, JSON-serializable, non-secret values to
  the browser (read with `usePluginClientConfig` / `getPluginClientConfig`). It
  runs once at startup, so nothing request- or user-scoped belongs in it. Values
  matching non-public env vars are redacted, which is a safety net, not a
  design.
- Anything per-user, per-agent, or dynamic is an **endpoint**, not client config.

### Tool Providers

When a plugin exposes agent tools, implement AppKit's `ToolProvider`
(`getAgentTools()` + `executeAgentTool()`), building a `ToolRegistry` with
`defineTool` and dispatching via `executeFromRegistry` / `toolsFromRegistry`.
These live on the beta entry point, so import them from
`@databricks/appkit/beta` rather than `@databricks/appkit`, and expect the
shape to move between minor releases:

- Registry keys are the public tool names; use `alias.method` for
  per-resource tools.
- Zod schema per tool; `.describe()` every field - the description is the
  model's only documentation.
- `annotations: { effect: "read" | "write", requiresUserContext: true }` is how
  hosts reason about safety. Be accurate.
- `autoInheritable` defaults to false and stays false for anything destructive
  or privilege-sensitive. Opt in only for safe reads.
- Validation failure returns an LLM-friendly error string so the model can
  self-correct; it does not throw.

### Errors And Logging

- Throw `AppKitError` subclasses (`ValidationError`, `AuthenticationError`,
  `ConfigurationError`, `ConnectionError`, `ExecutionError`, ...). Each carries
  `code`, `statusCode`, `isRetryable`, and a redacting `toJSON()`.
- Prefer the static factories (`ValidationError.missingField("warehouseId")`,
  `ConfigurationError.missingEnvVar("DATABRICKS_HOST")`) over ad-hoc strings, and
  add new ones rather than repeating message text.
- Never put a secret or a raw value in `context` - record the field name and the
  value's _type_. `toJSON()` redacts sensitive context keys, so log that rather
  than interpolating the raw value into the message.
- Do not forward an upstream `message` (or a stack, or a Zod issue string) to a
  client. Return a stable, actionable message of your own and attach the
  `statusCode` the error already carries; log the full error separately.
- One module-scoped logger per module. AppKit uses
  `const logger = createLogger("genie")`; this repo uses
  `log.logger(this)` / `log.logger(<module name>)` from `@dbx-tools/shared-core`.
  Do not `console.log`.
- Log at boot what would otherwise be invisible: the effective policy, whether a
  restriction is active, which mode was resolved. `logger.info("ready", {...})`
  is the house pattern.

### Security Defaults

- Zero-trust: validate every input, deny by default, and make the permissive
  option explicit and named.
- User-scoped work goes through `asUser(req)`; service-principal work is the
  default and should be the narrower case. In development a missing user token
  falls back to the service principal with a warning and an
  `execution.obo_dev_fallback` span attribute - never suppress that signal.
- Namespace caches per user via the `userKey` argument so an OBO result cannot
  leak across identities.
- Bound anything unbounded: upload sizes, row counts, result counts, fetch
  lengths, param key counts. Every cap gets a named constant.
- Never build SQL by string concatenation; use parameterized `:name` placeholders.

## Code Style

The AppKit repo runs Biome with double quotes and 2-space indent; this repo runs
Prettier (100 col, double quotes, semicolons, trailing commas) plus ESLint,
generated by projen. Follow the local formatter - `pnpm run format` - and these
shared conventions:

- **ESM only.** `import` / `export`, never `require()`.
- **`import type`** for type-only imports. Several packages here run
  `verbatimModuleSyntax`, where the distinction is load-bearing.
- **Named exports.** No default exports outside generated code.
- **Import order** is builtin → external → internal, alphabetized (enforced by
  `import/order`).
- **`#private` or `private`** for internals; only `exports()`, routes, and
  documented methods are public. AppKit marks intentionally-internal-but-exported
  helpers with `@internal`.
- **`readonly`** for injected collaborators; avoid mutable module state beyond
  memoization caches (`WeakMap` keyed on a stable object is the accepted form).
- **Named numeric constants** instead of inline magic numbers
  (`const DEFAULT_WAIT_TIMEOUT = 600_000;`), with numeric separators.
- **Small pure helpers** at module top for anything testable in isolation
  (`isTerminalRunState`, `nextPollDelay`, `abortableSleep`).
- **Discriminated unions over booleans** for result and mode types
  (`ExecutionResult`, `mode: "smtp" | "file"`).
- **Zod at runtime boundaries**, TypeScript types inside. Derive the type from
  the schema rather than declaring both.
- **`satisfies`** over `as` whenever the literal type should be preserved. Reach
  for `as` only when a package's export map makes the real type unimportable -
  and say so in a comment.
- **Structural interfaces** for types AppKit does not export (e.g.
  `PluginContextLike { getPlugins(): ReadonlyMap<string, unknown> }`), with a
  comment explaining why the nominal type was unavailable.
- **No `@deprecated` shims.** Remove, or ask.

## Documentation Style

AppKit docs are terse, task-shaped, and example-first. Match them.

### Doc Comments

- Every module gets a `/** ... @module */` header explaining what the module
  owns and, when non-obvious, why it exists at all.
- Every exported symbol gets a doc comment. For anything a caller configures,
  document the default and the env var inline:
  `/** SMTP server port (`SMTP_PORT`). Defaults to 587. */`
- Use `@example` with realistic, copy-pasteable code - imports included. AppKit's
  `Plugin` class carries two full examples; that is the bar for a base class.
- Prefer `{@link Symbol}` over backticked prose so generated API pages link up.
- **Explain the "why" for anything surprising.** AppKit comments a vendor quirk
  (Gemini thought signatures), a security decision (why a value is not stored),
  and every disabled interceptor. Those comments are the most valuable ones in
  the codebase.
- No agent-speak: no "ported from", "no longer used", "as requested", or change
  narration. Write as if the code always looked this way.

### Package READMEs

Keep the AppKit plugin-page structure. Our packages already follow it; new ones
should too:

1. `# <package name>` and a one-paragraph description of what importing it gets you.
2. `**Key features:**` - a short bullet list, benefit-first.
3. `## Why Use This Over Native AppKit` - required whenever the package overlaps
   a native surface. Name the native alternative and when it is the better pick.
4. `## Register The AppKit Plugin` / `## Basic usage` - the smallest working
   snippet, using real exported subpaths.
5. Task-shaped `##` sections in the order a reader hits them
   (configure → use → restrict → observe).
6. `## Configuration` - a table of option / type / default / description.
7. Environment variables and HTTP routes as tables when there are more than two.
8. `## Modules` - the subpath/module map.
9. Links to adjacent packages instead of restating them.

Additional rules:

- Lead with what the reader can do, not with internal architecture.
- Every code block must be runnable as written - real import paths, no
  pseudo-code, no invented APIs.
- Document loading/error/empty handling for UI surfaces.
- Tables for anything enumerable (options, env vars, event types, endpoints);
  prose only for behavior that resists tabulation.
- Do not document generator internals, predecessor repos, or migration history
  in package docs.

### Docs Site

- `README.md` + `packages/**/README.md` remain the single source of truth;
  `docs/scripts/sync-readmes.mjs` and `docs/scripts/generate-api-docs.mjs`
  generate the site. Fix prose in the README, navigation in the generator.
- AppKit publishes `llms.txt` / an `appkit docs <query>` CLI so agents can read
  the docs; this repo publishes `llms.txt` / `llms-full.txt` from the same
  generator. Keep first paragraphs of READMEs tight - they become the summaries
  in both.

## Testing

- Colocate tests with the code under test (AppKit: `<plugin>/tests/*.test.ts`;
  this repo: package `test/`). Name them after the unit, not the ticket.
- Unit-test the pure helpers directly - that is why they are extracted.
- Mock the singletons, not the plugin: `CacheManager.getInstanceSync`,
  `ServiceContext`, and the connector are the seams. AppKit's
  `createMockRequest` / `createMockResponse` / `createMockRouter` /
  `mockServiceContext` helpers show the shape.
- Cover the failure paths that matter: missing config, aborted signal, denied
  policy, non-`ok` `ExecutionResult`, reconnect/replay.
- Integration tests that need a workspace stay separately named
  (`*.integration.test.ts`) so they can be excluded.

## Checklist Before Shipping A Plugin Change

- Manifest `name`, `displayName`, `description`, both `resources` keys, and
  `stability` are correct; config schema properties all have descriptions.
- Config resolves explicit → env → default, with documented env names and a
  loud failure on contradiction.
- All outbound I/O goes through `execute()` / `executeStream()` with commented
  defaults; `AbortSignal` is forwarded everywhere.
- Routes registered via `this.route(...)`, mount-relative, user-scoped through
  `asUser(req)`, with specific status codes.
- `exports()` is intentional; `clientConfig()` holds only static non-secret data.
- Errors are `AppKitError` subclasses; no secrets in `context`; no `console.log`.
- Caps and limits are named constants; caches namespaced by `userKey`.
- Module `@module` headers, `@example` blocks, and README sections updated.
- `pnpm -r compile` and `pnpm run format` clean; tests added for new helpers and
  failure paths.

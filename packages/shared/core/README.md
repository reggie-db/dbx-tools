# @dbx-tools/shared-core

Browser-safe utility base for `@dbx-tools/*` packages.

Import this package for small, dependency-light helpers that can run in Node,
browsers, workers, CLIs, and shared schema packages. Modules are exported as
namespaces so call sites stay explicit:

```ts
import {
  async,
  brand,
  env,
  error,
  hash,
  http,
  json,
  log,
  net,
  object,
  string,
} from "@dbx-tools/shared-core";
```

Node-only helpers live in [`@dbx-tools/core`](../../node/core). AppKit and
Databricks SDK helpers live in [`@dbx-tools/appkit`](../../node/appkit).

Key features:

- Abort-aware async utilities for polling, sleeping, and connecting cancellation
  across web and Node runtimes.
- Error normalization for unknown thrown values, nested causes, and HTTP-ish
  status/message extraction.
- Deterministic non-cryptographic hashes and short ids for cache keys, slugs,
  and generated names.
- Non-throwing JSON parsing for untrusted input, with record narrowing so parsed
  data is not cast blindly.
- String normalization helpers for slugs, identifiers, unique labels, human
  labels, config lists, and prompt descriptions.
- Object/iterable, predicate, HTTP, cookie, network, token, memoization, and
  logging helpers that avoid Node-only dependencies.
- Namespace exports that make utility call sites explicit without creating a
  grab-bag default import.
- A Zod-backed `BrandContext` contract with dbx tools defaults, JSON Schema
  output, and prompt serialization for browser, library, and LLM consumers.

## Brand Context

```ts
import { brand } from "@dbx-tools/shared-core";

const context = brand.parseBrandContext({ name: "Acme Data" });
const jsonSchema = brand.brandContextJsonSchema();
const instructions = brand.brandContextPrompt(context);
```

`BrandContextSchema` validates identity, theme-aware assets, colors,
typography, links, audience, and voice. Every field has a dbx tools default, so
an empty object is a complete context. Use [`@dbx-tools/core`](../../node/core)
to discover and read YAML/JSON files, and
[`@dbx-tools/ui-branding`](../../ui/branding) to apply the same context to a UI.

## Async Control

```ts
for await (const status of async.poll(fetchStatus, {
  intervalMs: 250,
  timeoutMs: 30_000,
  predicate: (s) => s !== "READY",
})) {
  render(status);
}

await async.sleep(500, abortSignal);
```

`async.poll()` is useful for Databricks APIs that expose long-running state.
`async.tieAbortSignal()` and `async.sleep()` let route handlers connect caller
cancellation to background work.

## Error Handling

```ts
try {
  await run();
} catch (err) {
  logger.warn("run failed", { error: error.errorMessage(err) });
  const ctx = error.errorContext(err);
  return Response.json({ message: ctx.message }, { status: ctx.status ?? 500 });
}
```

`error.toError()`, `error.errorMessage()`, `error.errorMessages()`, and
`error.errorNodes()` normalize unknown thrown values. `error.errorContext()`
extracts HTTP-ish status/message detail from nested errors.

## Hashes And Ids

```ts
const id = hash.id(8);
const cacheKey = hash.fnvHash("workspace", host, endpointName);
const suffix = hash.fnvHashWithOptions({ length: 6 }, longName);
```

These hashes are deterministic and non-cryptographic. Use them for cache keys,
slug suffixes, and trace-stable identifiers, not secrets or signatures.

## Parsing Untrusted JSON

```ts
const body = json.parseRecord(await readRequestText(req)) ?? {};
const chunk = json.parse<StreamChunk>(sseData);
if (!chunk) continue;

const settings = json.parse<Settings>(process.env.SETTINGS, DEFAULT_SETTINGS);
```

`json.parse()` returns the fallback (or `undefined`) instead of throwing, so a
malformed request body, env var, config file, subprocess stdout, or third-party
response does not need its own `try`/`catch`. `json.parseRecord()` additionally
narrows to `Record<string, unknown>`, which a bare `JSON.parse(...) as Record<...>`
does not: it rejects a parsed `null`, array, or scalar rather than letting it
through as an object.

Reach for `JSON.parse` directly only when a throw is the correct outcome, such as
reading a file this repo generated itself.

## Strings And Descriptions

```ts
const slug = string.toSlug("My Cool Project!");
const id = string.toIdentifierWithOptions({ delimiter: "_" }, "Model Name");
const unique = string.toUniqueSlug("Send Email", { fallbackPrefix: "tool" });
const description = string.toDescription([
  "Answer with SQL first.",
  { "When data is missing": "Say what is missing." },
]);
```

`string.tokenize()`, `toSlug()`, and `toIdentifier()` keep package names, tool
ids, schema ids, and generated labels consistent. `toDescription()` turns nested
description data into prompt/tool text without hand-concatenating paragraphs.

Three helpers exist so call sites stop re-implementing them:

```ts
const label = string.toLabel("web_search"); // "Web Search"
const name = string.capitalize(segment); // no charAt(0).toUpperCase() idiom
const host = string.trimToEmpty(parsed.host); // unknown JSON field -> string
const allowed = string.parseList(process.env.ALLOWED_URLS);
```

`toLabel()` and `capitalize()` are the humanizers for identifiers and path
segments. `trimToNull()` / `trimToEmpty()` / `firstNonEmpty()` coerce an unknown
field off parsed JSON. `parseList()` normalizes a config value that may arrive as
an array or as one comma/whitespace-separated env string, de-duplicating as it
goes.

## Configuration From The Environment

```ts
const config = {
  host: env.string(options.host, "SMTP_HOST"),
  // Several names for one setting; earlier names win.
  appId: env.string(options.appId, ["TEAMS_APP_ID", "MICROSOFT_APP_ID"]),
  timeoutMs: env.positiveInt(options.timeoutMs, "SEARCH_TIMEOUT_MS", 30_000),
  threshold: env.positiveNumber(options.threshold, "FUZZY_THRESHOLD", 0.4),
  fuzzy: env.boolean(options.fuzzy, "SEARCH_FUZZY") ?? true,
  fallbacks: env.list(options.fallbacks, "MODEL_FALLBACKS"),
};
```

Every plugin resolves config the same way - the caller's typed value, else one or
more environment variables, else a default - and hand-writing that chain per
field is how `config.x ?? Number(process.env.X)` bugs get in. `positiveInt()`
floors, so a count cannot go fractional; `positiveNumber()` keeps the fraction
for a threshold or ratio. `boolean()` goes through `object.toBoolean()`, so the
loose spellings an env var actually carries (`1`, `on`, `yes`) are accepted, and
returns `undefined` when neither source is interpretable so `??` picks the
default. A name that is SET but unusable is not skipped for a later name in the
chain - ignoring what a deployment explicitly configured hides the mistake.

Browser-safe: `process` is reached through `globalThis` and guarded, so every
lookup simply misses off-process and the caller's fallback applies.

Pair it with `object.optional()` when a resolved value is an optional field -
`...object.optional("endpoint", env.string(...))` keeps an absent field ABSENT
rather than setting it to an explicit `undefined`, which
`exactOptionalPropertyTypes` rejects.

## Objects And Predicates

```ts
if (object.isRecord(value)) {
  const enabled = object.toBoolean(value.enabled);
}

const same = object.deepEqual(left, right);

const isRunnable = predicate
  .create((pkg: Package) => pkg.tags.includes("node"))
  .and((pkg) => pkg.name.includes("appkit"));
```

`object.deepEqual()` supports an optional comparator for domain-specific
short-circuits. `predicate.create()` returns composable predicates with `and`,
`or`, and `negate`, used heavily by the projen engine.

## Iterables

```ts
const names = object
  .sequence(packages)
  .map((p) => p.name)
  .filter(Boolean)
  .distinct()
  .toArray();

const grouped = object.group(packages, {
  node: (p) => p.tags.includes("node"),
  ui: (p) => p.tags.includes("ui"),
});
```

The iterable helpers are lazy and work well for filesystem scans, package lists,
and one-pass generated data. Use `sequence(..., { cache: true })` when a source
must be re-read.

## HTTP Headers And Cookies

```ts
const cookies = http.parseCookies(req);

let bearer: string | undefined;
http.forEachHeaderValue(req, "authorization", (value) => {
  if (value.startsWith("Bearer ")) bearer = value.slice("Bearer ".length);
});
```

`http.HeaderLike` works with Fetch `Request`, Express-ish requests, Node header
records, and plain `{ headers }` objects. `http.createFetchError()` turns a
failed `Response` into an error with response text attached.

## Intercepted Execution

`execution.directExecutor()` gives plugin-backed tools a no-plugin fallback with
the same success/failure shape as AppKit's executor. `execution.run()` merges the
plugin timeout signal with the caller's cancellation signal and centralizes
result unwrapping without imposing an AppKit dependency on shared code.

## Network Strings, Email, And CIDR

```ts
const url = net.urlBuilder("example.com")?.withPathAppend("api", "2.0");
const emails = net.parseEmails("alice@example.com; bob@example.com");
const cidr = net.parseCidr("10.0.0.0/8");
const internal = cidr ? net.ipInCidr("10.1.2.3", cidr) : false;
```

`net.urlBuilder()` is a forgiving URL builder for config and REST helpers.
`net.pathMatch()` compares path prefixes on segment boundaries. IP/CIDR helpers
parse IPv4 and IPv6 into a shared bigint comparison model.

## Allow-List Patterns

```ts
// One matcher from a config array OR a delimited env string.
const forwardable = pattern.toPatternMatcher(["x-mastra-*", "/^x-trace-/", "x-tenant"]);

forwardable("x-mastra-model"); // true  (glob)
forwardable("x-trace-parent"); // true  (regex literal)
forwardable("x-tenant"); // true  (literal, whole-string)
forwardable("x-forwarded-user"); // false
```

Every configurable allow-list in this repo takes the same three shapes, so the
compilation lives here once: a `/regex/` literal (with optional flags), a
shell-style glob (`*`, `?`, anchored at both ends, all other characters escaped),
or a literal compared whole-string. Matching is case-insensitive by default -
what HTTP header names and email addresses both want - and `caseSensitive` opts
out.

An invalid regex is skipped with a warning instead of throwing, so one bad
config entry cannot stop a process from starting. No usable patterns yields a
matcher that always returns `false`; a caller that reads "no patterns" as "permit
everything" must say so itself. The result is a `predicate`, so it composes with
`.and()` / `.or()` / `.negate()`.

Reach for [`@dbx-tools/path`](../../node/path)'s `toPathMatcher` instead when
matching a filesystem path or URL path, where `/` is a segment boundary and `**`
is meaningful - that one is `minimatch`-backed. This module is deliberately
dependency-free so it stays usable in a browser bundle.

## Token Claims

```ts
const scopes = token.getAccessTokenScopes(req, "x-forwarded-access-token");
const canReadWorkspace = token.includesAccessTokenScope(scopes, ["workspace", "all-apis"]);
```

Token helpers decode JWT payloads without validating signatures. Use them for
request-scoped authorization hints after the platform has already authenticated
the request.

## Memoization

```ts
const getRanges = functionModule.memoize(fetchRanges, {
  ttlMs: 24 * 60 * 60 * 1000,
});
```

`functionModule.memoize()` caches sync or async factories, evicts rejected
promises, and supports TTL-based refresh. It is useful for public metadata feeds,
SDK catalogues, and expensive computed constants.

## Logging

```ts
const logger = log.logger("mastra/genie");
logger.info("space:resolved", { spaceId });

if (log.isLevelEnabled("debug")) {
  logger.debug("large payload", expensivePayload());
}
```

`log.logger()` uses `consola` when installed and falls back to `console`. It
honors `LOG_LEVEL` per call, so debug statements can stay in production code
without paying formatting cost when disabled.

## Modules

- `async` - polling, sleep, and abort-signal wiring.
- `error` - unknown-error normalization and HTTP-ish error context.
- `hash` - ids, FNV hashes, and base32 encoding.
- `json` - non-throwing `parse()` and record-narrowing `parseRecord()`.
- `string` - tokenization, slugs, identifiers, human labels, string coercion,
  config lists, descriptions, pluralization, and HTML escaping.
- `object` - record checks, boolean coercion, present-only field spreading, deep
  equality, shape types, and lazy sequence transforms + collection helpers.
- `env` - config-over-environment resolution: strings, booleans, positive
  numbers/integers, and lists, with env-name fallback chains.
- `predicate` - composable boolean/type predicates.
- `pattern` - literal / glob / `/regex/` allow-list matching compiled to a
  predicate.
- `http` - header iteration, cookie parsing, and fetch error creation.
- `execution` - direct executor fallback, cancellation merging, and result unwrapping.
- `net` - URL building, email parsing, path matching, IP/CIDR helpers.
- `token` - JWT payload and scope readers.
- `functionModule` - memoization.
- `log` - tagged leveled logging.
- `brand` - Zod schema, defaults, JSON Schema, and LLM prompt serialization.

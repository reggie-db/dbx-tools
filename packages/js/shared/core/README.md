# @dbx-tools/shared-core

Browser-safe utility base for `@dbx-tools/*` packages.

Import this package for small, dependency-light helpers that can run in Node,
browsers, workers, CLIs, and shared schema packages. Modules are exported as
namespaces so call sites stay explicit:

```ts
import {
  async,
  brand,
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

## Serializable Values And Stable Identities

```ts
if (object.isSerializableValue(requestBody)) {
  await bus.broadcast("orders", { type: "order.updated", body: requestBody });
}

const key = object.toStableKey({ schema: "billing", version: 2 });
```

`object.isSerializableValue()` answers "does this survive a JSON round trip
unchanged", which is stricter than `JSON.stringify` not throwing: that succeeds
while turning a `Date` into a string, `NaN` into `null`, and a `Map` into `{}`,
and while dropping `undefined`. It narrows to `SerializableValue` instead of
throwing, so it doubles as the validator for a request body. Type a serializing
boundary as `SerializableValue` to catch the same mistakes at compile time.

`object.toStableKey()` canonicalizes a value so an identity can be derived from
it. Object key order does not affect the result, but types and structure do:
`1` and `"1"` differ, and so do `["a", "bc"]` and `["ab", "c"]`. It throws on a
cycle, a non-finite number, or a function/symbol rather than returning an
identity two callers could disagree about. `@dbx-tools/postgres` derives both its
advisory-lock ids and its notification channel names through it. Use
`hash.fnvHash()` instead when a short collision-tolerant digest is enough — its
canonicalizer is looser and folds every `Date` onto one token.

## Numbers, Dates, And Durations

```ts
object.toNumber("1,000"); //     1000
object.toNumber(" -2.5 "); //    -2.5
object.toNumber("12.5 %"); //    0.125
object.toNumber(""); //          undefined - `Number("")` would be 0
object.toNumber("12px"); //      undefined

object.toDate("2026-08-02"); //  a date or ISO instant
object.toDate("1785697899"); //  epoch SECONDS (not the year 1785697899)
object.toDate(1785697899000); // epoch millis
object.toDate("30 days ago"); // relative to now
object.toDate("now");
object.toDate("nope"); //        undefined - never throws

object.toDuration("1 hour 30 minutes"); // 5_400_000
object.toDuration("2ms"); //               2
object.toDuration("-7d"); //               -604_800_000
object.toDuration("2026-08-02"); //        ms from now until that instant
```

All three are for values typed by HAND into env vars, CLI flags, and config
files, so they are deliberately lenient: whitespace between amount and unit is
optional, units are case-insensitive, and plurals and abbreviations are
equivalent (`2ms` === `2 milliseconds`, `1h` === `1 hr` === `1 Hour`). Signs make
a duration an OFFSET, which is what lets `toDate` read `-30d` / `12 hours ago` /
`in 45s` as instants.

`toNumber` is the base the other two are built on, and the reason to reach for it
over `Number(value)` is that `Number` invents values: `""`, `null`, `[]`, and a
whitespace string all become `0`, so every caller has to re-check the result.
`toNumber` returns `undefined` instead, and accepts the spellings a person
actually types — digit-group separators, a bare fraction, a trailing point, an
exponent, a trailing percent. `ToNumberOptions` disables the `separators` and
`percent` leniencies for a string whose other characters carry meaning; a SQL
cell uses that so `"1,000"` in a text column stays the string the query returned.

`toDate` exists rather than `new Date(value)` because a bare epoch usually
arrives as a STRING (`date +%s`, a JSON field, a copied log line) and
`Date.parse("1785697899")` reads that as a YEAR, landing 1.7 billion years out.
Numeric input is therefore routed to the epoch path, with values under `1e11`
read as seconds and the rest as milliseconds. An unknown unit fails the whole
duration parse instead of being skipped, so `1 fortnight` is `undefined` rather
than `1`. Neither function throws - like `toBoolean` they return `undefined`, so
the caller decides whether a bad value is fatal, a warning, or a fallback
(`@dbx-tools/tunnel`'s `TUNNEL_AUTH_SESSION_CUTOFF` warns and carries on).

### Dates And Durations Are Inverses

Each function falls back to the other, so one field accepts both readings: a
duration reaching `toDate` resolves against now, and a date reaching
`toDuration` becomes the signed offset from now (`date - now`, so a past instant
is negative). Each tries its own reading first — `toDate` runs `Date.parse`
before the duration fallback — and recurses with the other's parser off, so a
value cannot bounce between them.

```ts
object.toDate("30 days ago", { parseDuration: false }); //  undefined
object.toDuration("2026-08-02", { parseDate: false }); //    undefined
```

Turn the fallback off where only one reading can be correct. A stored timestamp
or an `expires_at` field must not accept a duration, because resolving against
the current clock makes the same input mean something different on every call. A
timeout or a poll interval must not accept a date, because it would yield a
plausible but wrong number that also drifts.

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

Serializing whole callbacks rather than caching one value is a Node concern
(it needs `node:worker_threads`), so it lives in
[`@dbx-tools/core`](../../node/core)'s `processLock` instead.

## Logging

```ts
const logger = log.logger("mastra/genie");
logger.info("space:resolved", { spaceId });

if (log.isLevelEnabled("debug")) {
  logger.debug("large payload", expensivePayload());
}
```

`log.logger()` is dependency-free and uses the platform console in browsers or
formatted stderr output on server runtimes. It honors `LOG_LEVEL` per call, so
debug statements can stay in production code without paying formatting cost
when disabled.

## Modules

- `async` - polling, sleep, and abort-signal wiring.
- `error` - unknown-error normalization and HTTP-ish error context.
- `hash` - ids, FNV hashes, and base32 encoding.
- `json` - non-throwing `parse()` and record-narrowing `parseRecord()`.
- `string` - tokenization, slugs, identifiers, human labels, string coercion,
  config lists, descriptions, pluralization, and HTML escaping.
- `object` - record checks, number/boolean/date/duration coercion, present-only
  field spreading, deep equality, JSON-round-trip guards
  (`isSerializableValue`), canonical identity keys (`toStableKey`), shape types,
  and lazy sequence transforms + collection helpers.
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

# @dbx-tools/shared-core

Browser-safe utility base for `@dbx-tools/*` packages.

Import this package for small, dependency-light helpers that can run in Node,
browsers, workers, CLIs, and shared schema packages. Modules are exported as
namespaces so call sites stay explicit:

```ts
import {
  async,
  error,
  hash,
  http,
  iterable,
  log,
  net,
  object,
  string,
} from "@dbx-tools/shared-core";
```

Node-only helpers live in [`@dbx-tools/node-core`](../../node/core). AppKit and
Databricks SDK helpers live in [`@dbx-tools/node-appkit`](../../node/appkit).

Key features:

- Abort-aware async utilities for polling, sleeping, and connecting cancellation
  across web and Node runtimes.
- Error normalization for unknown thrown values, nested causes, and HTTP-ish
  status/message extraction.
- Deterministic non-cryptographic hashes and short ids for cache keys, slugs,
  and generated names.
- String normalization helpers for slugs, identifiers, unique labels, and prompt
  descriptions.
- Object, predicate, iterable, HTTP, cookie, network, token, memoization, and
  logging helpers that avoid Node-only dependencies.
- Namespace exports that make utility call sites explicit without creating a
  grab-bag default import.

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
const names = iterable
  .sequence(packages)
  .map((p) => p.name)
  .filter(Boolean)
  .distinct()
  .toArray();

const grouped = iterable.group(packages, {
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
- `string` - tokenization, slugs, identifiers, descriptions, pluralization, and
  HTML escaping.
- `object` - record checks, boolean coercion, deep equality, and shape types.
- `iterable` - lazy sequence transforms and collection helpers.
- `predicate` - composable boolean/type predicates.
- `http` - header iteration, cookie parsing, and fetch error creation.
- `net` - URL building, email parsing, path matching, IP/CIDR helpers.
- `token` - JWT payload and scope readers.
- `functionModule` - memoization.
- `log` - tagged leveled logging.

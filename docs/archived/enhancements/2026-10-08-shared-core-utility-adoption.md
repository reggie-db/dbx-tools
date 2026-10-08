# Shared-core utility adoption and duplicate removal

Date: 2026-10-08

Status: Complete

Archived: October 8, 2026

## Outcome

Removed unused `object.generator`, `net.pathMatch`, and `options.serializeOpts`.
Local record guards, trim-to-nullish helpers, delay-only sleeps, the docs
`escapeRegExp` copy, and matching config-list splitters now import
`@dbx-tools/shared-core`. Selected eager map/filter/Set pipelines use
`object.sequence`. `bun run shared-core:usage` reports runtime-export use;
architecture tests fail unused exports and duplicated owned helpers. OAuth
scope splitting stays protocol-local. Generated PythonMonkey `runtime.js`
bundles remain excluded from duplicate detection.

## Objective

Make `@dbx-tools/shared-core` the single owner for browser-safe utility behavior
that already exists there. Remove unused public utilities, replace local copies,
and use the lazy `object.sequence` pipeline where it avoids repeated eager array
allocation. Preserve specialized domain helpers whose behavior differs from the
shared utility.

This work is a repository-wide adoption pass. It does not add another utility
package or another general-purpose helper surface.

## Audit method

The review covered all 18 modules under `packages/js/shared/core/src` and every
tracked TypeScript, TSX, JavaScript, and MJS file outside generated output.

The audit used four checks:

1. Enumerate exported runtime values and exported types from the TypeScript AST.
2. Trace root, namespace, and subpath imports to production, test, and
   package-internal references.
3. Hash normalized function bodies inside `shared-core` to identify exact
   repeated implementations, then review related utility families manually for
   semantic overlap.
4. Search the repository for local implementations of record guards, string
   normalization, list parsing, delay promises, deduplication, and eager iterable
   pipelines.

Generated PythonMonkey bundles and synchronized upstream Python sources were
excluded from duplicate detection. Generated Python bindings were inspected to
identify runtime entrypoints that static TypeScript imports cannot see.

## Current usage

`shared-core` exports 128 unique runtime values and 58 types. Repository usage
falls into these categories:

| Category | Runtime exports | Meaning |
| --- | ---: | --- |
| Direct production use | 88 | Imported by repository production or build code |
| Package-internal building blocks | 35 | Used to implement another exported utility |
| Generated Python binding entrypoints | 2 | `bindings.logActiveLevel` and `bindings.logLevelEnabled` |
| Test-only | 1 | `options.serializeOpts` |
| No repository use | 2 | `net.pathMatch` and `object.generator` |

AST-resolved direct imports occur in 231 source files across 36 package,
example, Projen, and documentation-script groups. Thirty-four non-root package
manifests declare a direct dependency on `@dbx-tools/shared-core`.

Representative adoption is already strong:

- `object.isRecord`: 30 production files.
- `errorUtils.errorMessage`: 33 production files.
- `stringUtils.trimToNull`: 28 production files.
- `object.sequence`: 10 production files.
- `asyncUtils.sleep`: 11 production files.
- `hash.id`: 14 production files.
- `stringUtils.toDescription`: seven production files.

The generated Graphiti Python runtime calls `bindings.logLevelEnabled` through
`packages/py/graphiti/src/dbx_tools/graphiti/_generated/node/shared_core/bindings.py`.
The binding wrappers are therefore production APIs even though TypeScript import
analysis sees only their tests.

## Duplicate review inside shared-core

The exact-body scan found no repeated complete utility implementation. The only
matching bodies were small callbacks used in sibling branches of the same
algorithm, such as predicate evaluation and recursive serialization.

The following utility families are composed rather than copied and should stay:

- `trimToUndefined` and `trimToEmpty` delegate to `trimToNull`.
- `toSlug` delegates to `toSlugWithOptions`, which delegates to
  `toIdentifierWithOptions`.
- `Sequence` methods delegate to the standalone iterable functions.
- `errorMessages` and `errorContext` consume `errorNodes`.
- `serializeOpts` and `serializeOptsEnvironment` share the private
  `serializedOpts` implementation.
- The `bindings` functions are deliberately binding-safe wrappers around the log
  module for generated Python calls.

Two public helpers overlap with an existing owner and have no callers:

1. `object.generator` repeats the scalar-or-iterable flattening role of
   `object.sequence` without the `Sequence` API. It also iterates a `Map` as
   entries while `sequence` consistently uses map values. Remove `generator` and
   use `sequence` as the only lazy mixed-source owner.
2. `net.pathMatch` is a one-line wrapper over
   `net.urlBuilder(input)?.pathMatches(path)`. It has no production or test use.
   Remove it rather than retaining a second path-matching entrypoint.

`options.serializeOpts` is tested but has no production caller. The owning
options module still needs schema parsing and environment serialization, but a
JSON string serializer should remain public only when a real command or runtime
uses it. Remove it and its test unless a current caller is identified before the
cleanup lands.

## Repository rewrites

### Record guards

Replace the following local `isRecord` implementations with
`object.isRecord`:

| File | Current owner |
| --- | --- |
| `docs/scripts/package-exports.mjs:8` | Documentation scripts |
| `packages/js/cli/service/src/_package.ts:150` | CLI service package parsing |
| `packages/js/cli/service/src/_runtime.ts:97` | CLI service runtime parsing |
| `packages/js/node/appkit-model-gateway/src/protocols/decode.ts:259` | Gateway protocol decoding |
| `packages/js/node/appkit-model-gateway/src/router.ts:172` | Gateway routing |
| `packages/js/node/graphiti/src/appkit/_openapi.ts:156` | Graphiti OpenAPI parsing |
| `packages/js/node/lakebase/src/client.ts:368` | Lakebase response parsing |

`@dbx-tools/cli-service` does not currently declare `shared-core`; add the
dependency through `.projenrc.ts` before importing it. The other package owners
already declare the dependency.

### String normalization

Replace local trim-to-nullish expressions with the matching `stringUtils`
function. High-confidence replacements include:

| File | Current expression | Shared owner |
| --- | --- | --- |
| `packages/js/node/appkit-mastra/src/remote-skills.ts:570` | `trim() || undefined` | `trimToUndefined` |
| `packages/js/cli/dbx-tools/src/lakebase-proxy/proxy.ts:118` | optional user trim | `trimToUndefined` |
| `packages/js/node/fs/src/os-path.ts:137` | command output trim | `trimToUndefined` |
| `packages/js/node/teams/src/auth.ts:206` | bearer token trim | `trimToNull` |
| `packages/js/ui/mastra/src/react/chat-stream.ts:14` | response header trim | `trimToUndefined` |
| `packages/js/node/lakebase/src/client.ts:378` | local `text` helper | `trimToUndefined` |
| `packages/js/node/databricks/src/workspace-client.ts:137` | current-user name guard | `trimToUndefined` |
| `packages/js/node/model/src/_ranking.ts:297` | local `stringValue` helper | `trimToUndefined` |
| `packages/py/node-runtime/shims/databricks-runtime-auth.ts:39` | runtime token guard | `trimToUndefined` |

Review callers that intentionally preserve surrounding whitespace before
rewriting them. For example, `packages/js/node/auth/src/client.ts:300` validates
with `trim()` but returns the original string. Converting it to
`trimToUndefined` changes the returned value and should be an explicit behavior
decision, not a mechanical replacement.

Use `trimToEmpty` for loose JSON fields that must become a string,
`trimToNull` where `null` is part of the protocol shape, and
`trimToUndefined` for optional configuration and object properties. Do not keep
new local `text`, `stringValue`, or optional-string helpers with the same
semantics.

### Lists and tokenization

Replace general configuration-list splitting with `stringUtils.parseList`.
The first target is `projen/tasks/python-registry.ts:124`, whose
`splitIndexList` helper performs a subset of `parseList`. Review OAuth scope
splitting in `packages/js/node/auth/src/_service-principal.ts:83` at the same
time.

Keep protocol-specific parsing local when delimiters have protocol meaning. An
HTTP `Authorization` header, forwarded-address list, filesystem path, or SQL
fragment should not be routed through the generic comma-and-whitespace config
list parser.

Replace `docs/scripts/repository-docs.mjs:28` with
`pattern.escapeRegExp`; documentation scripts should not own a second regular
expression escaping implementation.

### Delay and cancellation

Use `asyncUtils.sleep` for delay-only promises so cancellation behavior and
timer cleanup remain available:

- `packages/js/cli/service/src/service.ts:476`
- `packages/js/node/search/src/lakebase.ts:142`

Test-only delays may also use `asyncUtils.sleep`, but this is lower priority than
production replacement. Keep callback-based timeouts that resolve with domain
state, such as child-process exit races; those are not simple sleeps.

### Lazy sequence adoption

Use `object.sequence` for dynamic iterable sources that currently allocate
several intermediate arrays. Materialize only where an API requires an array or
sorting.

Initial rewrite targets:

| File | Current pipeline | Proposed shape |
| --- | --- | --- |
| `projen/tasks/test-workspace.ts:151` | concatenate, filter, `Set`, sort | `sequence(...).filter(...).distinct().toArray().sort()` |
| `projen/tasks/python-node-bindings-watch.ts:44` | concatenate, `Set`, sort | `sequence(...).distinct().toArray().sort()` |
| `projen/src/project-js.ts:278` | merge manifest file arrays with `Set` | `sequence(...).distinct().toArray()` |
| `projen/src/project-js.ts:1285` | merge tag candidates with `Set` | `sequence(...).distinct().toArray()` |
| `projen/tasks/publish.ts:172` | deduplicate compiled targets | `sequence(...).distinct().toArray()` |
| `packages/js/node/appkit-mastra/src/validation.ts:20` | map, filter, `Set` | `sequence(...).map(...).filter(...).distinct().toArray()` |
| `docs/scripts/generate-api-docs.mjs:402` | map, `Set`, map | one lazy sequence, then `toArray()` |

Do not replace short literal arrays, `Array.from({ length })`, React render
arrays, or code that depends on array mutation only to increase `sequence`
usage. The objective is one iterable owner and fewer intermediate collections,
not a blanket ban on arrays.

## Deliberate non-rewrites

The following similarly named code has different semantics and should remain
local unless its contract changes:

- `packages/js/shared/model-gateway/src/client.ts:80` formats a gateway HTTP
  status and response body; it is not `errorUtils.errorMessage`.
- Throwing `readJson` helpers in Projen tasks intentionally fail on malformed
  repository manifests; `json.parse` is a non-throwing parser.
- Shape guards such as the HTTP `Headers` wrapper checks in
  `packages/js/shared/core/src/http.ts` narrow a specific host object and are not
  generic record guards.
- `Array.from({ length })` creates a sized test or data fixture and is not an
  iterable-normalization rewrite target.

## Delivery plan

### Phase 1: Remove dead public surface

- [x] Remove `object.generator` and its generated exports.
- [x] Remove `net.pathMatch` and its generated exports.
- [x] Remove `options.serializeOpts` unless a production caller is identified.
- [x] Run Projen twice and confirm the second synthesis is unchanged.

### Phase 2: Replace exact local copies

- [x] Replace every local generic `isRecord` implementation listed above.
- [x] Replace high-confidence trim-to-nullish expressions.
- [x] Replace the documentation regular-expression escaper.
- [x] Replace production delay-only promises with `asyncUtils.sleep`.
- [x] Add any required direct dependency through `.projenrc.ts`.

### Phase 3: Adopt shared pipelines

- [x] Replace generic configuration-list splitters with `parseList` where the
      delimiter semantics match.
- [x] Convert the initial eager deduplication targets to `object.sequence`.
- [x] Keep final materialization at sorting, serialization, React, and external
      API boundaries.
- [x] Review the remaining `map`/`filter`/`Set` chains and record explicit
      non-candidates rather than converting them mechanically.

### Phase 4: Prevent regression

- [x] Add a focused `shared-core:usage` report that records runtime-export use by
      production, test, internal, and generated-binding callers.
- [x] Fail a focused architecture test when a runtime export has no caller and
      is not an explicit generated-binding entrypoint.
- [x] Reject new generic local implementations of owned utilities such as
      `isRecord`, `sleep`, `escapeRegExp`, and trim-to-nullish helpers outside an
      explicit specialized allowlist.
- [x] Keep usage and timing reports informational; do not add wall-clock gates.

## Validation

- Run focused tests for `@dbx-tools/shared-core` and each rewritten package.
- Run `bun run test:changed` after each phase.
- Run `bun run compile`, `bun run eslint`, `bun run test:all`,
  `bun run docs:check-source`, and `bun run docs:check-readmes` before completion.
- Run `bunx projen` twice after dependency, export, or generated-file changes.
- Confirm generated Python bindings still expose `log_active_level` and
  `log_level_enabled` and run the Python Graphiti tests.

## Exit criteria

- Every runtime export has a production, package-internal, or generated-binding
  caller.
- No generic local record guard duplicates `object.isRecord`.
- Optional string normalization uses the appropriate `stringUtils` helper where
  semantics match.
- `object.sequence` owns mixed lazy iteration and selected dynamic
  map/filter/deduplication pipelines.
- Generated output, documentation, JavaScript tests, and Python tests pass.

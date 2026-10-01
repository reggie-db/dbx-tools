# Module Namespace Naming Plan

**Status:** Proposed; import-alias audit complete  
**Scope:** TypeScript source modules, generated package barrels, repository consumers, and public docs

## Goal

Give utility and contract namespaces names that consumers can import directly.
Remove the recurring `async as asyncTools`, `project as coreProject`,
`plugin as appkitPlugin`, `activity as sharedActivity`, and `xyz as xyzModule`
pattern instead of making every caller repair an underspecified public name.

This monorepo changes in lockstep. The migration should update every caller and
remove the old names in the same change. Do not add deprecated aliases or
compatibility re-exports.

## Audit findings

The audit parsed non-generated TypeScript imports under `packages`, `projen`,
and `.projenrc.ts`. It found 163 aliased named imports, of which 138 refer to
repository-owned or repository-relative modules. Many are legitimate type or
implementation-boundary disambiguations. The following package namespaces are
repeatedly renamed because their exported name is too generic:

| Package                    | Current namespace | Aliased imports | Direct imports | Frequent local name                        |
| -------------------------- | ----------------- | --------------: | -------------: | ------------------------------------------ |
| `@dbx-tools/core`          | `config`          |              10 |              8 | `coreConfig`                               |
| `@dbx-tools/core`          | `project`         |               7 |             15 | `coreProject`                              |
| `@dbx-tools/shared-core`   | `async`           |               7 |             10 | `asyncTools`, `asyncModule`, `sharedAsync` |
| `@dbx-tools/shared-core`   | `error`           |               7 |             28 | `sharedError`                              |
| `@dbx-tools/shared-teams`  | `activity`        |               7 |              0 | `sharedActivity`                           |
| `@dbx-tools/appkit`        | `plugin`          |               5 |              3 | `appkitPlugin`                             |
| `@dbx-tools/shared-search` | `search`          |               5 |              1 | `sharedSearch`                             |
| `@dbx-tools/appkit`        | `execution`       |               3 |              0 | `appkitExecution`                          |
| `@dbx-tools/shared-core`   | `brand`           |               3 |             11 | `sharedBrand`                              |
| `@dbx-tools/appkit`        | `brand`           |               2 |              0 | `appkitBrand`                              |
| `@dbx-tools/appkit`        | `toolkit`         |               2 |              0 | `appkitToolkit`                            |
| `@dbx-tools/auth-gate`     | `storage`         |               2 |              0 | `authStorage`                              |
| `@dbx-tools/databricks`    | `workspace`       |               2 |              1 | `databricksWorkspace`                      |
| `@dbx-tools/model`         | `serving`         |               2 |              3 | `modelServing`                             |

`@dbx-tools/shared-core` also exports `functionModule`, a name created because
`function.ts` cannot become a valid `function` namespace. Thirteen source files
use it. `@dbx-tools/search` similarly generates the vague `indexTools`
namespace even though the module only maps index-creation options.

## Naming rules

1. Name a namespace after the capability it owns, not its source package or its
   TypeScript representation. Prefer `pluginRegistry`, `searchContract`, and
   `memoization` over `appkitPlugin`, `sharedSearch`, and `functionModule`.
2. Do not use a reserved word, common local variable, or generic suffix such as
   `Module`, `Api`, or `Tools` to make an otherwise weak name compile.
3. Use a plural noun for a collection of homogeneous helpers (`errors`,
   `markers`) and a specific compound noun for a workflow (`pluginExecution`,
   `asyncControl`).
4. When a package already hoists a unique function, class, schema, or type at
   its root, import that symbol directly instead of importing and renaming its
   source-file namespace.
5. Preserve aliases that communicate a real collision between independent
   owners, such as two `WorkspaceClient` types. Generated-binding bridge aliases
   such as `NativeModelClass` or `rankModelsWithRust` are internal implementation
   distinctions and are outside this cleanup.
6. Source filenames and generator configuration own generated barrel names.
   Never hand-edit a generated `index.ts` or declaration file.

## Proposed public names

### Utility namespaces

| Package                  | Current          | Proposed          | Reason                                                                                                     |
| ------------------------ | ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `@dbx-tools/shared-core` | `async`          | `asyncControl`    | Covers concurrency, polling, retry delay, sleep, and cancellation without using the `async` keyword alone. |
| `@dbx-tools/shared-core` | `error`          | `errors`          | Avoids collision with the ubiquitous local `error` value.                                                  |
| `@dbx-tools/shared-core` | `functionModule` | `memoization`     | The module owns `memoize`; the new name describes the capability and removes the generated suffix.         |
| `@dbx-tools/shared-core` | `brand`          | `branding`        | Distinguishes brand operations from a local brand value.                                                   |
| `@dbx-tools/core`        | `config`         | `configuration`   | Names the layered configuration service rather than a local config object.                                 |
| `@dbx-tools/core`        | `project`        | `repository`      | The module discovers roots, repository identity, remotes, and registry context.                            |
| `@dbx-tools/appkit`      | `plugin`         | `pluginRegistry`  | The module reads plugin descriptors and resolves registered sibling instances.                             |
| `@dbx-tools/appkit`      | `execution`      | `pluginExecution` | The module adapts shared execution into AppKit plugin operations.                                          |
| `@dbx-tools/appkit`      | `brand`          | `branding`        | Matches the capability name while retaining AppKit's active-brand behavior.                                |
| `@dbx-tools/appkit`      | `toolkit`        | `toolkitEntries`  | The module names and builds AppKit toolkit entries.                                                        |
| `@dbx-tools/auth-gate`   | `storage`        | `persistence`     | Describes auth-state persistence rather than a generic storage object.                                     |
| `@dbx-tools/databricks`  | `workspace`      | `workspaceClient` | The module resolves and adapts workspace clients and workspace identity.                                   |
| `@dbx-tools/model`       | `serving`        | `catalogue`       | The module owns Model Serving catalogue loading, caching, enrichment, and resolution.                      |
| `@dbx-tools/search`      | `indexTools`     | `indexOptions`    | The module maps a wire request into index-creation options.                                                |

Before implementation, confirm each proposed compound noun against member
usage. Keep the capability together unless its members have two clearly
independent owners; do not split modules only to produce shorter names.

### Contract and feature entry modules

Some aliases exist because callers import a generated source-file namespace
even though the package root already exports the required symbols directly.
Handle these as public-surface cleanup rather than inventing another package
qualified namespace:

- Replace `activity as sharedActivity` with direct imports of `Activity`,
  `activitySchema`, `activityResponseSchema`, `cardsOf`, and related members.
  Rename the source namespace to `botFramework` only for callers that genuinely
  need the complete Bot Framework contract as one value.
- Replace `search as sharedSearch` with direct schema, type, and
  `toAiSearchQueryType` imports. Use `searchContract` only where a namespace is
  passed or retained as a unit.
- Replace feature `plugin as emailPlugin`, `plugin as teamsPlugin`, and similar
  imports with the already-hoisted factories (`email`, `teams`, `search`,
  `webSearch`, `mastra`, `graphiti`, `authGate`).
- Replace `tool as emailToolApi`, `interceptor as tunnelInterceptorApi`, and
  equivalent imports with their hoisted functions and types.

This removes the alias at its cause and leaves each feature's public entry point
named after the feature consumers invoke.

## Implementation phases

### 1. Make barrel intent explicit

- Extend the Projen barrel generator with an explicit per-module namespace
  policy: a semantic namespace override or `direct-only`.
- Keep filename-derived namespaces as the default for real utility modules.
- Use `direct-only` for feature entry modules whose unique public symbols are
  already hoisted. Do not generate a redundant `plugin`, `tool`, or
  `interceptor` namespace solely because that file exists.
- Reject configured namespace names ending in `Module`, `Api`, or `Tools` and
  reject reserved words. Allow an explicit, documented exception only for a
  third-party or generated contract that cannot be changed here.
- Test namespace overrides, direct-only modules, collisions, custom
  `exports.ts`, UniFFI barrels, read-only output, and deterministic regeneration.

### 2. Rename the foundational utility modules

- Rename the owning source files for `asyncControl`, `errors`, `memoization`,
  `branding`, `configuration`, and `repository`.
- Update JSDoc links, examples, tests, generated barrels, package declarations,
  README snippets, and every repository caller in the same change.
- Keep existing member function and type names unless a member itself has
  independent evidence of repeated aliasing.
- Run synthesis after source edits; never edit generated barrels directly.

### 3. Rename AppKit and domain namespaces

- Migrate AppKit to `pluginRegistry`, `pluginExecution`, `branding`, and
  `toolkitEntries`.
- Migrate Auth Gate to `persistence`, Databricks to `workspaceClient`, Model to
  `catalogue`, and Search to `indexOptions`.
- Update examples to demonstrate the final names without package-qualified
  aliases, because examples determine the import style copied by consumers.

### 4. Flatten contract and feature imports

- Convert Teams and Search consumers to direct root imports, using
  `botFramework` or `searchContract` only where a namespace is materially
  useful.
- Convert the AppKit demo and package docs from aliased `plugin`, `tool`, and
  `interceptor` namespaces to hoisted feature functions.
- Mark those entry modules `direct-only` in barrel configuration so the old
  generic namespace cannot return through regeneration.

### 5. Add a regression audit

- Add a TypeScript-AST check over source and tests that reports repository-owned
  named imports which are immediately aliased.
- Fail for the retired names and for aliases ending in `Module`, `Api`, or
  `Tools`; report other aliases for review without banning necessary type,
  generated-binding, or third-party disambiguation.
- Keep a small reasoned allow-list keyed by module and imported symbol. Do not
  use a numerical baseline that permits new generic aliases.
- Run the audit from the normal Projen validation path.

## Acceptance criteria

- No source import uses `async as`, `config as coreConfig`,
  `project as coreProject`, `error as sharedError`, `plugin as appkitPlugin`,
  `execution as appkitExecution`, `activity as sharedActivity`, or
  `search as sharedSearch`.
- No generated package barrel exposes a repository-owned namespace ending in
  `Module`, `Api`, or `Tools`.
- The old namespace names are absent from source, generated declarations,
  READMEs, examples, and API docs; no deprecated compatibility aliases remain.
- Necessary aliases are source-qualified and documented by the audit allow-list.
- `bunx projen` is idempotent, followed by successful `bun run compile`,
  `bun run eslint`, `bun run test`, `bun run docs:check-source`, and
  `bun run docs:check-readmes`.
- Package tarball checks confirm the generated JavaScript and declaration
  barrels expose only the intended names.

## Non-targets

- Do not rename generated UniFFI symbols or established `-rs` package names.
- Do not remove aliases that distinguish two same-named types from independent
  owners.
- Do not rename third-party imports such as `parse as parseYaml` or
  `constants as osConstants`; this plan controls repository-owned public names.
- Do not combine unrelated utility packages or move browser-safe code into a
  Node-only package as part of the naming migration.

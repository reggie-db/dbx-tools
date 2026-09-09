# Databricks SDK OpenAPI Generation Plan

Date: 2026-09-09

Status: implemented.

## Purpose

Generate deterministic OpenAPI JSON and Rust clients for every published
modular Databricks API SDK package. Node owns extraction and orchestration only.
It does not produce a Node client or package.

`packages/js/node/databricks-openapi/src/inputs.ts` pins one shared SDK version,
discovers API packages from installed `@databricks/sdk-*` dependencies, and
owns the small support-package exclusion list.

## Sources

Each modular SDK is an exact development dependency. The generator resolves its
public `v1`, `v2`, or `v3` export and derives the package root and version from
that installed package. It never depends on an sdk-js checkout.

The generated `client.js` files are authoritative for:

- HTTP methods;
- executable URL construction;
- path and query parameter names;
- request body selection;
- parsed, empty, or raw response behavior.

The generated `model.js` Zod declarations are authoritative for JSON wire
schemas. The extractor reads their syntax without evaluating SDK code or
arbitrary transforms.

The matching versioned `model.d.ts` declarations supply resource-name formats
from field documentation. Those formats expand SDK URL placeholders such as
`{name}` into unique OpenAPI path parameters without introducing a second
versioned upstream source.

## Outputs

The Node generator writes only Rust-owned artifacts:

- `packages/rs/databricks-client/assets/openapi/<api>/openapi.json`;
- `packages/rs/databricks-client/src/lib.rs`.

Each JSON document is OpenAPI 3.0.3 so the Rust `progenitor` generator can
consume it directly. The generated `dbx-tools-databricks-client` crate contains
one public API module per modular SDK package. Each module exposes its own
generated `Client` and types, which prevents operation and schema name
collisions between services. Keeping this in a separate crate prevents its
large generated type surface and dependencies from reaching lower-level
authentication consumers.

The crate-root `Client` exposes those modules as fields such as
`client.dataquality` and `client.jobs`. Its `new_with_client` constructor clones
one `reqwest::Client` handle into every generated service client, so they share
the same connection pool, TLS configuration, and default headers.

No output is written under `packages/js/openapi`.

## Configuration

`.projenrc.ts` performs three tasks:

1. Add every exact SDK version to the workspace catalog.
2. Add every SDK as a development dependency of
   `@dbx-tools/databricks-openapi`.
3. Write `dbxToolsConfig.databricksOpenapi` with the overrides file, JSON
   output directory, Rust client path, and strict mode.

The root `openapi` task runs the Databricks generator before the existing tsoa
generation path.

## Overrides

`openapi-overrides.yaml` is limited to operation-level facts that generated SDK
syntax does not encode:

- success status;
- request or response media type;
- raw response shape.

Every override requires a reason and an exact upstream source reference.
Generation fails when an override no longer matches an operation.

## Transactional Generation

Generation follows this sequence:

1. Discover pinned SDK dependencies and parse every client, model, and model
   declaration module.
2. Verify operation counts and strict AST diagnostics.
3. Expand documented resource formats and apply narrow overrides.
4. Render every document in memory.
5. Stage every JSON document in a sibling temporary directory.
6. Validate, optimize, and validate every staged document with the pinned
   Speakeasy executable.
7. Stage the complete Rust client module.
8. Replace all JSON documents and the Rust module as one rollback-capable batch.

Any failure before the commit phase leaves every existing output unchanged. A
commit failure restores replaced files from sibling backups.

## Drift Gates

The generator and tests enforce:

- one exact modular SDK version;
- 82 configured API packages;
- 939 extracted `buildHttpRequest` operations;
- one extracted operation per direct HTTP call;
- no unsupported URL, request body, response, or Zod syntax;
- unique method and path pairs after ambiguous resource paths are expanded;
- no stale overrides;
- no raw response without an explicit shape;
- deterministic JSON and Rust output;
- no timestamps or machine-specific source paths.

An SDK update is reviewed by changing the single version in `src/inputs.ts`,
re-synthesizing dependencies, regenerating, and updating the expected inventory
only after the resulting contract diff is accepted.

## Validation

Run:

```sh
bun run openapi
bun test test
cargo fmt --all -- --check
cargo check -p dbx-tools-databricks
```

The Rust check compiles every generated `progenitor` module against the
committed JSON documents.

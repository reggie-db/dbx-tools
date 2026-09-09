# `@dbx-tools/databricks-openapi`

Deterministic OpenAPI generation from Databricks modular JavaScript SDK
packages.

## Key features

- Resolves each SDK through its public `v1`, `v2`, or `v3` export.
- Extracts HTTP operations and Zod wire schemas with `oxc-parser`.
- Discovers API inputs from the package's pinned `@databricks/sdk-*`
  development dependencies, excluding SDK support packages.
- Expands ambiguous resource paths from the matching versioned SDK declaration
  comments.
- Supports narrow, source-cited YAML overrides for raw response details.
- Validates OpenAPI 3.0.3 before and after Speakeasy optimization.
- Generates a Rust `progenitor` client module from every validated document.
- Commits JSON contracts and the Rust client module as one transactional batch.
- Preserves every existing output when extraction, validation, optimization,
  or Rust client staging fails.

The generator is Databricks-specific and intentionally lives outside
`@dbx-tools/projen`. This repository prepends its one-shot CLI to the existing
`openapi` task through `.projenrc.ts`.

## Generate

```sh
bun run openapi
```

`src/inputs.ts` pins one modular SDK version and owns the short support-package
exclusion list. The current dependency inventory contains 82 packages,
including Model Serving, Postgres, Jobs, Pipelines, Files, Genie, SQL, compute,
Unity Catalog, identity, Apps, sharing, and account proxy services exposed
alongside workspace APIs.

Every OpenAPI document is written under
`packages/rs/databricks-client/assets/openapi/<api>/openapi.json`. The generated
`packages/rs/databricks-client/src/lib.rs` exposes one Rust client module per
API. No generated Node package or client is created. SDK packages are
development dependencies of this generator and do not become Rust runtime
dependencies.

## Overrides

`openapi-overrides.yaml` accepts only operation status, media type, and raw
response shape corrections. Every entry requires a reason and an upstream
source reference. Generation fails when an override no longer matches an
operation.

## Modules

- `config` resolves SDK inputs and overrides.
- `inputs` discovers API packages from pinned dependencies and owns exclusions.
- `ast` extracts HTTP operations and wire schemas.
- `overrides` applies narrow raw response and media-type corrections.
- `render` emits deterministic OpenAPI 3.0.3.
- `artifacts` validates and optimizes JSON, generates the Rust module, and
  commits outputs.
- `generator` coordinates one complete transactional generation.
- `cli` runs the configured one-shot generator.

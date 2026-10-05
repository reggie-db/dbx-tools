# AGENTS.md

Canonical instructions for coding agents and contributors.

## Tooling

- Use Bun for routine JavaScript and TypeScript package management, scripts, tests, and one-off commands: `bun`, `bun run`, and `bunx`.
- Use the configured corporate registries. Do not work around blocked public registries with direct downloads.
- Use the root Projen definition as the source of truth. Change `.projenrc.ts` or `projen/src/**`, then run `bunx projen`; do not hand-edit generated files.
- Before adding helpers, dependencies, generators, or Databricks integrations, inspect existing `@dbx-tools/*` packages and load `dbx-tools-reuse`.
- For Databricks CLI operations that access a workspace, ask the user to select a profile and pass `--profile <name>`.
- Never use emojis in source, generated output, logs, docs, commit messages, or user-facing text.

## Repository Boundary

- The repository is JavaScript/TypeScript and Python only.
- Rust, Cargo, UniFFI, native binding packages, native binary installers, and native release support have been removed. Do not restore them.
- The monorepo changes in lockstep. Remove obsolete APIs instead of adding compatibility aliases or deprecated shims; update every in-repo caller in the same change.
- Types, records, enums, interfaces, and module shapes have one owner. Import the owning type directly or fix its generator/export surface rather than creating mirrors.
- Generated bindings, barrels, OpenAPI clients, PythonMonkey bundles, and docs are derived artifacts. Fix their owner and regenerate them.

## Product Shape

`dbx-tools` provides companion packages for Databricks Apps, AppKit backends, Mastra agents, Genie workflows, Model Serving, Lakebase, approval-gated communication, and AppKit-oriented React UI.

Primary ownership:

- `packages/js/node/auth` owns Node/Bun Databricks authentication, profile selection, credential lifecycle, CLI-backed U2M, PAT, M2M, App SP/OBO, and the lightweight authenticated HTTP client. It must not add the Databricks SDK.
- `packages/js/node/model` owns model discovery, catalogue caching, classification, ranking, protocol selection, reasoning policy, and committed metadata snapshots.
- `packages/py/model-proxy` is the LiteLLM host. It defaults to `127.0.0.1`, keeps the admin UI disabled, injects dbx-tools lookup/ranking controls into OpenAPI, and delegates policy to Node-owned model/auth packages.
- `packages/js/node/lakebase` and `packages/js/cli/lakebase-proxy` own Lakebase parsing, discovery, credentials, and the loopback PostgreSQL proxy.
- `packages/js/node/postgres` and `packages/py/postgres` own advisory locks, topic buses, and Postgres/Lakebase helpers in their respective runtimes.
- `packages/js/node/appkit*`, `packages/js/shared/*`, and `packages/js/ui/*` own AppKit integrations and browser-safe contracts/UI. Before changing AppKit-facing APIs, inspect `bunx @databricks/appkit docs` and installed AppKit `.d.ts` files.
- `projen/shims/python-node` owns the trace-driven Node compatibility layer used by PythonMonkey bundles. Only shim Node built-ins actually imported by a bundle.

## Code And Generation Rules

- Public module namespaces come from capability-specific filenames; do not add filename-to-namespace repair maps.
- Keep `@dbx-tools/shared-core` logging dependency-free.
- Python Node bundles contain no production Python callbacks. Compatibility belongs in build-time shims.
- OpenAPI package files are generated from the owning service schema. Do not manually maintain parallel contracts.
- `packages/js/shared/model/src/contracts.ts` owns browser-safe model contracts; `model:contracts` generates matching Zod schemas.
- `bun run model:metadata` refreshes committed model metadata. Normal synthesis must not perform network-backed metadata refreshes.
- Documentation is generated from root/package READMEs by `docs/scripts/sync-readmes.mjs`, with API pages from `docs/scripts/generate-api-docs.mjs`.

## Documentation

- Keep the root `README.md` focused on Databricks developer value.
- Put detailed workspace/generator guidance in `projen/README.md`.
- Track active technical debt under `docs/enhancements/YYYY-MM-DD-*.md`; move completed or abandoned plans to `docs/archived/enhancements`.
- Do not mention predecessor repositories or migrations in public docs.
- When changing future-agent behavior, update this file first.

## Releases

- `bun run bump` increments `VERSION` locally and synchronizes generated package versions.
- Run `bun run release` with no arguments from `main`. It commits the synchronized bump, pushes `main`, creates an annotated `vX.Y.Z` tag, and pushes the tag.
- `.github/workflows/release.yml` runs only for `v*` tag pushes and verifies the tagged commit exactly equals `origin/main` before publishing Node, Python, docs, and the GitHub release.
- There is no release PR, manual stage recovery, Cargo/native publication, or alternate release entrypoint.
- Preserve local application/deployment flows and local npm/Python publication helpers.

## Validation

- Start with focused tests for changed packages, then broaden to relevant workspace tests and builds.
- Run `bunx projen` twice and ensure the second synthesis produces no additional diff when changing generated configuration.
- Run `bun run version:check` after version or workspace changes.
- Do not fix unrelated failures; report them clearly.

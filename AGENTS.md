# AGENTS.md

Canonical instructions for coding agents and contributors.

## Tooling

- Use Bun for routine JavaScript and TypeScript package management, scripts, tests, and one-off commands: `bun`, `bun run`, and `bunx`.
- Use the configured corporate registries. Do not work around blocked public registries with direct downloads.
- Use the root Projen definition as the source of truth. Change `.projenrc.ts` or `projen/src/**`, then run `bunx projen`; do not hand-edit generated files.
- Before adding helpers, dependencies, generators, or Databricks integrations, inspect existing `@dbx-tools/*` packages and load `dbx-tools-reuse`.
- Treat installed library and framework functionality as externally owned. Inspect the exact installed API, documentation, types, exports, and source before adding a local implementation for the same concern. Configure public APIs directly; do not wrap, subclass, copy, patch, or keep parallel policy for functionality the owner already provides.
- For Projen, use native project fields and components directly. A dbx-tools component may own only behavior Projen does not provide, and unsupported behavior must remain separate from the native owner.
- Prefer typed fields, options, and variables over string-keyed maps. Use maps only when keys are genuinely dynamic or an external API requires them.
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

- `packages/js/node/auth` owns Node/Bun Databricks profile selection, credential lifecycle, and token/header production for CLI-backed U2M, PAT, M2M, and App SP/OBO. It does not own workspace HTTP APIs or the Databricks SDK; consuming capability packages own their transport or inject auth into AppKit/SDK clients.
- `packages/js/shared/auth` owns browser-safe passwordless and Databricks auth values, secret-free profile summaries, profile selections, and auth client field schemas.
- `packages/js/node/model` owns model discovery, catalogue caching, classification, ranking, protocol selection, reasoning policy, and committed metadata snapshots.
- `packages/js/shared/model-gateway` owns browser-safe gateway schemas and model discovery clients. `packages/js/node/appkit-model-gateway` owns OpenAI Responses, Chat Completions, Anthropic Messages, embeddings, Codex, and Databricks AI Gateway transport. It reuses model-owned discovery and policy, prefers direct streaming fast paths, and uses AI SDK providers only for cross-protocol translation.
- `packages/js/cli/service` owns product-agnostic current-user install, start, stop, restart, status, uninstall, package-local Bun compilation into `~/.dbx-tools/bin`, and systray2 menu behavior for consuming CLIs.
- `packages/js/cli/model-gateway` owns foreground `dbx model-gateway` and `dbx-model-gateway` execution plus its tray-only service definition and Models URL menu item. There is no Python gateway or compatibility command.
- `packages/js/cli/graphiti` owns Graphiti CLI execution, exact-version Python runtime bootstrap, model-gateway command resolution, and its service definition. Reuse `cli/service` for local service lifecycle; `node/appkit-graphiti` owns only AppKit integration and app-scoped sidecar supervision, not installers or desktop services.
- `packages/js/node/lakebase` and `packages/js/cli/lakebase-proxy` own Lakebase parsing, discovery, credentials, and the loopback PostgreSQL proxy.
- `packages/js/node/postgres` and `packages/py/postgres` own advisory locks, topic buses, and Postgres/Lakebase helpers in their respective runtimes.
- `packages/js/node/appkit*`, `packages/js/shared/*`, and `packages/js/ui/*` own AppKit integrations and browser-safe contracts/UI. Before changing AppKit-facing APIs, inspect `bunx @databricks/appkit docs` and installed AppKit `.d.ts` files.
- `projen/shims/python-node` owns the trace-driven Node compatibility layer used by PythonMonkey bundles. Only shim Node built-ins actually imported by a bundle.

## Code And Generation Rules

- Public module namespaces come from capability-specific filenames; do not add filename-to-namespace repair maps.
- Keep `@dbx-tools/shared-core` logging dependency-free.
- Python Node bundles contain no production Python callbacks. Compatibility belongs in build-time shims.
- OpenAPI package files are generated from the owning service schema. Do not manually maintain parallel contracts.
- `packages/js/shared/model/src/contracts.ts` owns browser-safe model contracts; the package-local `contracts` task generates matching Zod schemas.
- `packages/js/shared/model-gateway` owns compositional Zod gateway and browser-client contracts.
- `bun run --filter '@dbx-tools/model' metadata` refreshes committed model metadata. Normal synthesis must not perform network-backed metadata refreshes.
- Documentation is generated from root/package READMEs by `docs/scripts/sync-readmes.mjs`, with API pages from `docs/scripts/generate-api-docs.mjs`.

## Documentation

- Keep the root `README.md` focused on Databricks developer value.
- Put detailed workspace/generator guidance in `projen/README.md`.
- Track active technical debt under `docs/enhancements/YYYY-MM-DD-*.md`; move completed or abandoned plans to `docs/archived/enhancements`.
- Do not mention predecessor repositories or migrations in public docs.
- When changing future-agent behavior, update this file first.

## Releases

- `bun run bump` increments `VERSION` locally and synchronizes generated package versions.
- Run `bun run release` with no arguments from any branch. It commits and pushes pending branch changes, safely fast-forwards `main` when needed, then calls `bump`, commits the synchronized changes, pushes `main`, creates an annotated `vX.Y.Z` tag, and pushes the tag. It fails instead of creating a merge commit when `main` cannot fast-forward. Use `--no-bump` only for an existing synchronized bump.
- `.github/workflows/release.yml` runs only for `v*` tag pushes and verifies the tagged commit exactly equals `origin/main` before publishing Node, Python, and docs.
- There is no release PR, GitHub Release, manual stage recovery, Cargo/native publication, or alternate release entrypoint.
- Preserve local application/deployment flows and local npm/Python publication helpers.

## Validation

- Start with focused tests for changed packages, then broaden to relevant workspace tests and builds.
- Run `bunx projen` twice and ensure the second synthesis produces no additional diff when changing generated configuration.
- Run `bun run version:check` after version or workspace changes.
- Do not fix unrelated failures; report them clearly.

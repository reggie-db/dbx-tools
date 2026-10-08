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
- Prefix dbx-tools-specific environment variables with `DBX_TOOLS_`; never use the ambiguous `DBX_` prefix. Keep standard external variables such as `DATABRICKS_*`, `PYTHON`, and `UV_*` unchanged.
- For Databricks CLI operations that access a workspace, ask the user to select a profile and pass `--profile <name>`.
- Never use emojis in source, generated output, logs, docs, commit messages, or user-facing text.

## Repository Boundary

- The repository is JavaScript/TypeScript and Python only.
- Rust, Cargo, UniFFI, native binding packages, native binary installers, and native release support have been removed. Do not restore them.
- The monorepo changes in lockstep. Remove obsolete APIs instead of adding compatibility aliases or deprecated shims; update every in-repo caller in the same change.
- Types, records, enums, interfaces, and module shapes have one owner. Import the owning type directly or fix its generator/export surface rather than creating mirrors.
- Generated bindings, barrels, PythonMonkey bundles, and docs are derived artifacts. Fix their owner and regenerate them.

## Product Shape

`dbx-tools` provides companion packages for Databricks Apps, AppKit backends, Mastra agents, Genie workflows, Model Serving, Lakebase, approval-gated communication, and AppKit-oriented React UI.

Primary ownership:

- `packages/js/shared/core/src/options.ts` owns common Databricks environment metadata, normalized URL and TCP/listener schemas, and schema-level option parse/serialization. `packages/js/cli/args` (`@dbx-tools/cli-args`) owns Commander argument binding and argv serialization.
- `packages/js/node/auth` owns Node/Bun Databricks auth option schemas, profile selection, credential lifecycle, and token/header production for CLI-backed U2M, PAT, M2M, App SP/OBO, and an inert Python-runtime auth hook. It does not own workspace HTTP APIs or construct SDK clients; consuming capability packages own their transport, while the Python Node runtime may install the SDK-backed process capability consumed by the hook.
- `packages/js/shared/auth` owns browser-safe passwordless and Databricks auth values, secret-free profile summaries, profile selections, and auth client field schemas.
- `packages/js/node/model` owns model discovery, catalogue caching, classification, ranking, protocol selection, reasoning policy, and committed metadata snapshots. Native web search follows documented models and later intra-family versions from `versionTuple`; GPT-OSS does not inherit. Gateway capability overrides remain the disable path.
- `packages/js/shared/model-gateway` owns browser-safe gateway schemas and model discovery clients. `packages/js/node/appkit-model-gateway` owns OpenAI Responses, Chat Completions, Anthropic Messages, embeddings, Codex, and Databricks AI Gateway transport. It reuses model-owned discovery and policy, prefers direct streaming fast paths, and uses AI SDK providers only for cross-protocol translation. OpenAI `capabilities.web_search` and Codex `supports_search_tool` follow discovered `webSearch`.
- `packages/js/cli/service` owns product-agnostic current-user install, start, stop, restart, status, uninstall, schema-or-object command option serialization, package-local Bun compilation into `~/.dbx-tools/bin`, service-owned uv Python environments, and systray2 menu behavior for consuming CLIs.
- `@dbx-tools/cli-args` owns Commander argument generation from Zod object schemas, including help defaults resolved through `node/core` configUtils (environment, `.env`, bundle, and app YAML). Consuming commands own their schemas. The consolidated CLI keeps command implementations behind subpath exports and dynamic imports.
- `@dbx-tools/cli/model-gateway` owns foreground `dbx model-gateway` and `dbx-model-gateway` execution plus its tray-only service definition and Models URL menu item. There is no Python gateway or compatibility command.
- `packages/py/graphiti` owns the one-process FastAPI composition of Graphiti's existing REST routers and MCP server, the PostGraph driver pinned from Graphiti PR 1777, persistent embedded PostgreSQL, and external Lakebase connections. The Projen Python source-sync engine copies the upstream REST, MCP, and driver subsets into the read-only generated tree at pinned commits so PyPI metadata contains no direct Git dependencies; change sync configuration instead of generated files. PythonMonkey owns model routing, authentication, Lakebase parsing, discovery, and per-connection credentials. `@dbx-tools/graphiti` owns typed option serialization, Python process supervision, and its `./appkit` plugin subpath.
- `packages/js/node/lakebase` owns Lakebase parsing, discovery, and credentials. `packages/js/cli/lakebase-proxy` owns its listener, URL, and service option schemas plus the loopback PostgreSQL proxy.
- `packages/js/node/tunnel` and `packages/js/node/auth-gate` own tunnel transport, gate, and storage schemas and resolution. `packages/js/cli/tunnel` composes their fields with wrapper-only options.
- `packages/js/node/postgres` owns advisory locks and the Postgres topic bus. Do not recreate Python counterparts; Python integrations should consume Node-owned behavior through generated PythonMonkey bindings when needed.
- `packages/js/node/appkit*`, `packages/js/shared/*`, and `packages/js/ui/*` own AppKit integrations and browser-safe contracts/UI. `@dbx-tools/ui` owns the common foundation plus branding, auth, email, and search subpaths; Mastra and Teams remain separate UI packages. Before changing AppKit-facing APIs, inspect `bunx @databricks/appkit docs` and installed AppKit `.d.ts` files.
- `packages/py/node-runtime` owns the trace-driven Node compatibility layer, shared `runtime.js` used by PythonMonkey bundles, and Databricks Python SDK auth injection for notebook and Job runtimes. Projen generates only package-specific bundles and thin Python adapters that import this runtime; it must not own or publish shim sources. Only shim Node built-ins actually imported by a bundle.

## Code And Generation Rules

- Public module namespaces come from capability-specific filenames; do not add filename-to-namespace repair maps.
- Keep `@dbx-tools/shared-core` logging dependency-free.
- Python Node bundles contain no production Python callbacks. Compatibility belongs in build-time shims.
- Use Zod for every type that crosses, or could plausibly cross, a serialization boundary: HTTP/SSE request and response bodies, upstream REST payloads, tool inputs/outputs, client config published to browsers, serialized env/JSON options, and persisted records. Define `XSchema`, document the schema and each field with `.describe()` (not JSDoc inside the object literal), and export `type X = z.infer<typeof XSchema>` (or `z.input` / `z.output` when defaults or transforms differ). Never export `type X = typeof XSchema`, and never keep a parallel interface for a schema-owned shape.
- Keep plain TypeScript interfaces and type aliases for in-process shapes: behavioral contracts and classes (`FileSystem`, clients, loggers), callables and generics, host objects (`Headers`, `URL`, `AbortSignal`, `Uint8Array`, `Date`), React props, parser results, and local helper option bags. Do not add Zod, or a `zod` dependency, to a package just to type those. Document them with ordinary JSDoc.
- Apply this when adding or changing a shared type; convert an existing interface only when it is or becomes wire data. Do not migrate utility packages wholesale.
- Generated API docs and `docs:check-source` accept either source: JSDoc on standard types, or `.describe()` on Zod schemas and their inferred aliases.
- `packages/js/shared/model/src/contracts.ts` owns browser-safe model contracts. Define schemas there and in sibling modules such as `openai-chat.ts`; do not generate a second contract surface.
- `packages/js/shared/model-gateway` owns compositional Zod gateway and browser-client contracts.
- `bun run --filter '@dbx-tools/model' metadata` refreshes committed model metadata. Normal synthesis must not perform network-backed metadata refreshes.
- Documentation is generated from root/package READMEs by `docs/scripts/sync-readmes.mjs`, with API pages from `docs/scripts/generate-api-docs.mjs`.

## Documentation

- Keep the root `README.md` focused on Databricks developer value.
- Write package READMEs for users: outcomes, runnable workflows, configuration, and operational limits. Keep development policies and implementation-history explanations out of product guides.
- Generate CLI command and option references from the owning parser's help or documentation API, including subcommands and forwarded options. Render each command as markdown tables for arguments, options, and child commands that command owns. Do not treat parent flags as global or repeat them on subcommands that do not declare them. Exclude built-in help commands and flags; do not maintain parallel option tables or hand-edit generated README sections.
- Put detailed workspace/generator guidance in `projen/README.md`.
- Track active technical debt under `docs/enhancements/YYYY-MM-DD-*.md`; move completed or abandoned plans to `docs/archived/enhancements`.
- Do not mention predecessor repositories or migrations in public docs.
- When changing future-agent behavior, update this file first.

## Releases

- `bun run bump` increments `VERSION` locally and synchronizes generated package versions.
- Run `bun run release` from any branch; without flags it retains all default steps. It commits and pushes pending branch changes, safely fast-forwards `main` when needed, then calls `bump`, commits the synchronized changes, pushes `main`, creates an annotated `vX.Y.Z` tag, and pushes the tag. It fails instead of creating a merge commit when `main` cannot fast-forward. Use `--no-bump` only for an existing synchronized bump.
- `.github/workflows/release.yml` runs only for `v*` tag pushes and verifies the tagged commit exactly equals `origin/main` before publishing Node, Python, and docs.
- The release workflow installs dependencies and validates/builds all release artifacts in one job. Install validation prerequisites before running validation tasks. Registry jobs only download and publish those artifacts; they must not install workspace dependencies or rebuild packages. Keep per-package Python environments and publish dependency ordering.
- Release task flags may select publication targets, documentation, optional validation, local registry publication, local dependency installation, optional example-app deploy, and optional skip of release notes. Preserve unflagged defaults. Store CI selections in the annotated release tag, not a mutable repository setting; version and immutable-source verification remain mandatory. `--example-deploy` is off by default, runs locally after tagging, and is not stored in the tag. After bump, `docs/releases/vX.Y.Z.md` is written with `dbx genie exec` (`--sandbox read-only --ephemeral`); on failure the step writes a short git-log summary instead. Pass `--no-release-notes` to skip. Notes are not stored in the tag.
- There is no release PR, GitHub Release, manual stage recovery, Cargo/native publication, or alternate release entrypoint.
- Preserve local application/deployment flows and local npm/Python publication helpers.

## Validation

- Start with focused tests for changed packages, then broaden to relevant workspace tests and builds.
- Run `bunx projen` twice and ensure the second synthesis produces no additional diff when changing generated configuration.
- Run `bun run version:check` after version or workspace changes.
- Do not fix unrelated failures; report them clearly.

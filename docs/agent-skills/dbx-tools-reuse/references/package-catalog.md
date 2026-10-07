# dbx-tools package catalog

Generated from repository manifests and package READMEs for dbx-tools 0.9.58.
Inspect the installed manifest, README, exports, and source before relying on a capability.

## CLI Tools

- `@dbx-tools/cli` - Use one CLI to authenticate with Databricks, connect local PostgreSQL tools to Lakebase, serve Databricks models to coding agents, run graph memory, and share applications through a gated public URL. Source: `packages/js/cli/dbx-tools`.
- `@dbx-tools/cli-appkit-env` - Export the environment that AppKit resolves so another process can use the same Lakebase connection and application configuration. Choose shell, JSON, or Windows output without repeating AppKit discovery in your startup scripts. Source: `packages/js/cli/appkit-env`.
- `@dbx-tools/cli-args` - Bind Zod object fields to Commander flags, environment bindings, layered local config, help defaults, and service arguments. Source: `packages/js/cli/args`.
- `@dbx-tools/cli-auth` - Sign in to Databricks, inspect a profile, and obtain access tokens for scripts and local tools. The commands support user OAuth, service-principal credentials, and personal access token profiles through dbx auth. Source: `packages/js/cli/auth`.
- `@dbx-tools/cli-graphiti` - Run Graphiti graph memory against Databricks-hosted chat and embedding models. The CLI layers foreground execution and desktop-service commands on the @dbx-tools/graphiti Node runtime, which maps options and supervises the unified Python Graphiti process. Source: `packages/js/cli/graphiti`.
- `@dbx-tools/cli-lakebase-proxy` - Connect PostgreSQL tools and local applications to Databricks Lakebase through a stable loopback address. The proxy discovers the requested Lakebase resource, uses your selected Databricks profile, and creates short-lived database credentials without putting a Lakebase password in local configuration. Source: `packages/js/cli/lakebase-proxy`.
- `@dbx-tools/cli-model-gateway` - Expose Databricks-hosted models on a local OpenAI-compatible endpoint for Codex, SDKs, and development tools. The CLI discovers models from the selected workspace and can run temporarily in a terminal or continuously as a current-user service. Source: `packages/js/cli/model-gateway`.
- `@dbx-tools/cli-service` - Add desktop-service installation, lifecycle commands, optional uv-managed Python dependencies, and a tray menu to a Commander CLI. Users can keep your command running after their terminal closes and manage it through the same service commands on macOS, Linux, and Windows. Source: `packages/js/cli/service`.
- `@dbx-tools/cli-tunnel` - Share an existing local process through a public Portr or FRP URL protected by email one-time codes and passkeys. Approved users can reach your app without adding authentication or tunnel handling to the wrapped process. Source: `packages/js/cli/tunnel`.

## Node and AppKit

- `@dbx-tools/appkit` - Node-side helpers for Databricks AppKit apps. Source: `packages/js/node/appkit`.
- `@dbx-tools/appkit-graphiti` - Run Graphiti beside an AppKit server, publish direct user-scoped memory tools, and reuse the same unified Python runtime as the standalone CLI. Source: `packages/js/node/appkit-graphiti`.
- `@dbx-tools/appkit-mastra` - AppKit plugin and server-side toolkit for hosting Mastra agents inside a Databricks App. Source: `packages/js/node/appkit-mastra`.
- `@dbx-tools/appkit-model-gateway` - Give OpenAI-, Anthropic-, and Codex-compatible clients one endpoint for the models available in a Databricks workspace. The AppKit plugin discovers the workspace catalogue, exposes familiar model APIs, and chooses a compatible Databricks route for each request. Source: `packages/js/node/appkit-model-gateway`.
- `@dbx-tools/appkit-web-search` - Server-side web-search runtime, Mastra tools, and AppKit plugin. Source: `packages/js/node/appkit-web-search`.
- `@dbx-tools/auth` - Databricks profile resolution and token or authentication-header production for Node.js and Bun. Source: `packages/js/node/auth`.
- `@dbx-tools/auth-gate` - Passwordless authentication runtime built on Better Auth, email OTP, passkeys, and caller-provided identity policy and delivery. Source: `packages/js/node/auth-gate`.
- `@dbx-tools/core` - Node-only core helpers for layered configuration, binary installation, process execution, locking, and project discovery. Source: `packages/js/node/core`.
- `@dbx-tools/databricks` - Databricks workspace, filesystem, cloud, and network utilities. Source: `packages/js/node/databricks`.
- `@dbx-tools/databricks-zerobus` - Region-aware Zerobus ingest helpers for Databricks workspaces. Source: `packages/js/node/databricks-zerobus`.
- `@dbx-tools/email` - Server-side email runtime, agent tools, and AppKit plugin. Source: `packages/js/node/email`.
- `@dbx-tools/fs` - Node local-disk FileSystem implementation of the @dbx-tools/shared-fs contract. Built on BaseFileSystem, so this package only owns host separator conversion (toBackendPath), Node I/O, symlink containment (preparePath), and errno mapping. Source: `packages/js/node/fs`.
- `@dbx-tools/genie` - Server-side Databricks Genie chat drivers. Source: `packages/js/node/genie`.
- `@dbx-tools/graphiti` - Run Graphiti from Node without coupling lifecycle control to a CLI or AppKit plugin. Callers provide the shared typed Graphiti options and receive one runtime handle for completion and shutdown. Source: `packages/js/node/graphiti`.
- `@dbx-tools/lakebase` - Resolve a Databricks Lakebase target into the host, database, and user a PostgreSQL client needs, then request a short-lived database credential. The package gives Node and Bun applications one profile-aware path from a project name or resource URL to connection-ready values. Source: `packages/js/node/lakebase`.
- `@dbx-tools/model` - Workspace-aware Databricks Model Serving selection. Source: `packages/js/node/model`.
- `@dbx-tools/path` - Node filesystem path toolkit for discovery, matching, ignoring, scanning, and watching. Source: `packages/js/node/path`.
- `@dbx-tools/postgres` - Connection-correct PostgreSQL primitives for Node.js: advisory locks that hold the connection they lock, and a structured topic bus over LISTEN/NOTIFY. Source: `packages/js/node/postgres`.
- `@dbx-tools/search` - Extensions for AppKit's beta AI Search plugin: agent tools, federated search, index lifecycle helpers, and an AppKit-compatible Lakebase full-text provider. Source: `packages/js/node/search`.
- `@dbx-tools/teams` - Server-side Microsoft Teams Adaptive Card runtime, agent tool, and AppKit plugin. Source: `packages/js/node/teams`.
- `@dbx-tools/tunnel` - Front an app with a public Portr and/or FRP tunnel and the passwordless @dbx-tools/auth-gate gate, in-process. Source: `packages/js/node/tunnel`.

## Python

- `dbx-tools-graphiti` - Run Graphiti REST, MCP, model routing, and PostgreSQL-backed graph memory from one Python runtime. The build synchronizes the upstream REST and MCP source plus the pinned PostGraph driver from Graphiti PR 1777 into the generated package tree, so the published wheel has no direct Git dependencies. Source: `packages/py/graphiti`.
- `dbx-tools-node-runtime` - Run PythonMonkey-based packages in managed Python environments that do not provide system Node.js or npm. Source: `packages/py/node-runtime`.

## Shared Contracts

- `@dbx-tools/shared-auth` - Keep passwordless sign-in, passkey controls, and Databricks profile selectors consistent across browser and server packages. The package provides shared schemas for validating responses at the network boundary plus browser helpers that work with @dbx-tools/auth-gate. Source: `packages/js/shared/auth`.
- `@dbx-tools/shared-core` - Browser-safe utility base for @dbx-tools/* packages. Source: `packages/js/shared/core`.
- `@dbx-tools/shared-email` - Browser-safe email sending schemas and inferred types. Source: `packages/js/shared/email`.
- `@dbx-tools/shared-email-template` - Universal React Email presentation shared by dbx-tools server and browser email surfaces. Source: `packages/js/shared/email-template`.
- `@dbx-tools/shared-fs` - Browser-safe filesystem contract and abstract base for rooted storage backends. Source: `packages/js/shared/fs`.
- `@dbx-tools/shared-genie` - Browser-safe Genie schemas, event vocabulary, and snapshot diff helpers. Source: `packages/js/shared/genie`.
- `@dbx-tools/shared-graphiti` - Use the browser-safe Graphiti option contract from Node, AppKit, browser tools, or other JavaScript callers. This package owns defaults, validation, and environment parsing so every Node runtime accepts the same configuration. Source: `packages/js/shared/graphiti`.
- `@dbx-tools/shared-mastra` - Browser-safe contract for the AppKit Mastra plugin. Source: `packages/js/shared/mastra`.
- `@dbx-tools/shared-model` - Browser-safe model-selection contracts generated from the canonical model owner. Source: `packages/js/shared/model`.
- `@dbx-tools/shared-model-gateway` - Discover the models exposed by a dbx-tools model gateway from browser, edge, or shared application code. The package validates successful and error responses at the network boundary and provides the protocol contracts needed to build model pickers without importing Node or AppKit runtime code. Source: `packages/js/shared/model-gateway`.
- `@dbx-tools/shared-search` - Browser-safe schemas and extension types for AppKit-compatible AI Search providers. Source: `packages/js/shared/search`.
- `@dbx-tools/shared-teams` - Browser-safe Adaptive Card and Bot Framework activity schemas (plus inferred types) for the Teams add-on. Source: `packages/js/shared/teams`.

## React UI

- `@dbx-tools/ui-appkit` - Shared React and Tailwind foundation for AppKit-oriented UI packages. Source: `packages/js/ui/appkit`.
- `@dbx-tools/ui-auth` - React passwordless authentication surfaces for @dbx-tools/auth-gate. Source: `packages/js/ui/auth`.
- `@dbx-tools/ui-branding` - Portable dbx tools brand assets and React/browser bindings for a validated BrandContext from @dbx-tools/shared-core. Source: `packages/js/ui/branding`.
- `@dbx-tools/ui-email` - React email surfaces for AppKit chat and admin workflows. Source: `packages/js/ui/email`.
- `@dbx-tools/ui-mastra` - React chat UI for the AppKit-Mastra plugin. Source: `packages/js/ui/mastra`.
- `@dbx-tools/ui-search` - React search box and results for Databricks AI Search. Source: `packages/js/ui/search`.
- `@dbx-tools/ui-teams` - React surface for the Teams add-on: render Microsoft Teams Adaptive Cards in the browser with the adaptivecards JavaScript renderer. Source: `packages/js/ui/teams`.

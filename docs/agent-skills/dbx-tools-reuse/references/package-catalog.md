# dbx-tools package catalog

Generated from repository manifests and package READMEs for dbx-tools 0.9.78.
Inspect the installed manifest, README, exports, and source before relying on a capability.

## CLI Tools

- `@dbx-tools/cli` - Use one CLI to authenticate with Databricks, connect local PostgreSQL tools to Lakebase, serve Databricks models to coding agents, run graph memory, and share applications through a gated public URL. Source: `packages/js/cli/dbx-tools`.
- `@dbx-tools/cli-args` - Generate Commander flags from a Zod object schema so any CLI can share one argument, help, and layered-config path without installing the full dbx package. Source: `packages/js/cli/args`.
- `@dbx-tools/cli-service` - Add desktop-service installation, lifecycle commands, optional uv-managed Python dependencies, and a tray menu to a Commander CLI. Users can keep your command running after their terminal closes and manage it through the same service commands on macOS, Linux, and Windows. Source: `packages/js/cli/service`.

## Node and AppKit

- `@dbx-tools/appkit` - Node-side helpers for Databricks AppKit apps. Source: `packages/js/node/appkit`.
- `@dbx-tools/appkit-graphiti` - Run Graphiti as an AppKit plugin or supervise the same Python runtime directly from Node. The package root exposes the plugin; the runtime and options subpaths expose the underlying lifecycle and configuration contracts. Source: `packages/js/node/appkit-graphiti`.
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
- `@dbx-tools/lakebase` - Resolve a Databricks Lakebase target into the host, database, and user a PostgreSQL client needs, then request a short-lived database credential. The package gives Node and Bun applications one profile-aware path from a project name or resource URL to connection-ready values. When the target is a Lakebase path or URL without a chosen database, discovery picks the branch default (status.default, then Lakebase's provisioned databricks_postgres) instead of PostgreSQL's generic postgres database. Source: `packages/js/node/lakebase`.
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
- `@dbx-tools/shared-genie-code` - Browser-safe configuration for the managed Genie Code CLI and its local model-gateway sidecar. Source: `packages/js/shared/genie-code`.
- `@dbx-tools/shared-graphiti` - Use the browser-safe Graphiti option contract from Node, AppKit, browser tools, or other JavaScript callers. This package owns defaults, validation, and environment parsing so every Node runtime accepts the same configuration. Source: `packages/js/shared/graphiti`.
- `@dbx-tools/shared-mastra` - Browser-safe contract for the AppKit Mastra plugin. Source: `packages/js/shared/mastra`.
- `@dbx-tools/shared-model` - Browser-safe model-selection contracts generated from the canonical model owner. Source: `packages/js/shared/model`.
- `@dbx-tools/shared-model-gateway` - Discover the models exposed by a dbx-tools model gateway from browser, edge, or shared application code. The package validates successful and error responses at the network boundary and provides the protocol contracts needed to build model pickers without importing Node or AppKit runtime code. Source: `packages/js/shared/model-gateway`.
- `@dbx-tools/shared-search` - Browser-safe schemas and extension types for AppKit-compatible AI Search providers. Source: `packages/js/shared/search`.
- `@dbx-tools/shared-teams` - Browser-safe Adaptive Card and Bot Framework activity schemas (plus inferred types) for the Teams add-on. Source: `packages/js/shared/teams`.

## React UI

- `@dbx-tools/ui` - Use one tree-shakeable React package for the shared AppKit UI foundation, branding, passwordless authentication, email surfaces, and AI Search controls. Mastra chat and Teams Adaptive Cards remain separate packages because they have larger optional dependency families. Source: `packages/js/ui/appkit`.
- `@dbx-tools/ui-mastra` - React chat UI for the AppKit-Mastra plugin. Source: `packages/js/ui/mastra`.
- `@dbx-tools/ui-teams` - React surface for the Teams add-on: render Microsoft Teams Adaptive Cards in the browser with the adaptivecards JavaScript renderer. Source: `packages/js/ui/teams`.

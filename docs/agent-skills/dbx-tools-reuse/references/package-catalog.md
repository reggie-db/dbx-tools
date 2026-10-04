# dbx-tools package catalog

Generated from repository manifests and package READMEs for dbx-tools 0.9.21.
Inspect the installed manifest, README, exports, and source before relying on a capability.

## CLI Tools

- `@dbx-tools/cli` - The dbx CLI for workspace lifecycle, AppKit env, Databricks OAuth, and a gated public tunnel. Source: `packages/js/cli/dbx-tools`.
- `@dbx-tools/cli-appkit-env` - CLI and formatting helpers for exporting AppKit auto-configuration results. Source: `packages/js/cli/appkit-env`.
- `@dbx-tools/cli-auth` - Databricks OAuth commands mounted under dbx auth. Source: `packages/js/cli/auth`.
- `@dbx-tools/cli-model-proxy` - Lazy dbx model-proxy command group for direct proxy execution and per-user service management. Source: `packages/js/cli/model-proxy`.
- `@dbx-tools/cli-tunnel` - Wrap any command in a public Portr, FRP, or combined tunnel fronted by @dbx-tools/auth-gate email OTP and passkeys. Source: `packages/js/cli/tunnel`.

## Node and AppKit

- `@dbx-tools/appkit` - Node-side helpers for Databricks AppKit apps. Source: `packages/js/node/appkit`.
- `@dbx-tools/appkit-graphiti` - AppKit process plugin for the Python dbx-tools-graphiti MCP runtime. Source: `packages/js/node/appkit-graphiti`.
- `@dbx-tools/appkit-mastra` - AppKit plugin and server-side toolkit for hosting Mastra agents inside a Databricks App. Source: `packages/js/node/appkit-mastra`.
- `@dbx-tools/appkit-web-search` - Server-side web-search runtime, Mastra tools, and AppKit plugin. Source: `packages/js/node/appkit-web-search`.
- `@dbx-tools/auth` - Persistent Databricks authentication for Node.js and Bun without a native binding requirement. Source: `packages/js/node/auth`.
- `@dbx-tools/auth-gate` - Passwordless authentication runtime built on Better Auth, email OTP, passkeys, and caller-provided identity policy and delivery. Source: `packages/js/node/auth-gate`.
- `@dbx-tools/core` - Node-only core helpers for layered configuration, binary installation, process execution, locking, and project discovery. Source: `packages/js/node/core`.
- `@dbx-tools/core-rs` - Generated Node bindings for Databricks authentication, runtime utilities, and Lakebase address parsing from the dbx-tools-core Rust crate. Source: `packages/js/node/core-rs`.
- `@dbx-tools/databricks` - Databricks workspace, filesystem, cloud, and network utilities. Source: `packages/js/node/databricks`.
- `@dbx-tools/databricks-zerobus` - Region-aware Zerobus ingest helpers for Databricks workspaces. Source: `packages/js/node/databricks-zerobus`.
- `@dbx-tools/email` - Server-side email runtime, agent tools, and AppKit plugin. Source: `packages/js/node/email`.
- `@dbx-tools/fs` - Node local-disk FileSystem implementation of the @dbx-tools/shared-fs contract. Built on BaseFileSystem, so this package only owns host separator conversion (toBackendPath), Node I/O, symlink containment (preparePath), and errno mapping. Source: `packages/js/node/fs`.
- `@dbx-tools/genie` - Server-side Databricks Genie chat drivers. Source: `packages/js/node/genie`.
- `@dbx-tools/google-rs` - Google integrations backed by native Rust libraries. The current surface is Google Application Default Credentials. Source: `packages/js/node/google-rs`.
- `@dbx-tools/model` - Workspace-aware Databricks Model Serving selection. Source: `packages/js/node/model`.
- `@dbx-tools/model-rs` - Generated Node bindings for the catalogue-ranking, model-routing, and capability policy owned by the dbx-tools-model Rust crate. Source: `packages/js/node/model-rs`.
- `@dbx-tools/path` - Node filesystem path toolkit for discovery, matching, ignoring, scanning, and watching. Source: `packages/js/node/path`.
- `@dbx-tools/postgres` - Connection-correct PostgreSQL primitives for Node.js: advisory locks that hold the connection they lock, and a structured topic bus over LISTEN/NOTIFY. Source: `packages/js/node/postgres`.
- `@dbx-tools/rust-binary` - Release registry and runtime installer for native dbx-tools commands. Source: `packages/js/node/rust-binary`.
- `@dbx-tools/search` - Extensions for AppKit's beta AI Search plugin: agent tools, federated search, index lifecycle helpers, and an AppKit-compatible Lakebase full-text provider. Source: `packages/js/node/search`.
- `@dbx-tools/teams` - Server-side Microsoft Teams Adaptive Card runtime, agent tool, and AppKit plugin. Source: `packages/js/node/teams`.
- `@dbx-tools/tunnel` - Front an app with a public Portr and/or FRP tunnel and the passwordless @dbx-tools/auth-gate gate, in-process. Source: `packages/js/node/tunnel`.

## Openapi

- `@dbx-tools/openapi-model-proxy` - Generated OpenAPI 3.1 schema and openapi-fetch client for dbx-tools-model-proxy. Source: `packages/js/openapi/model-proxy`.

## Python

- `dbx-tools-auth` - Python access to the provider-neutral authentication lifecycle owned by @dbx-tools/auth. The package embeds a CommonJS bundle and executes it through PythonMonkey's SpiderMonkey runtime. Token refresh, check-lock-recheck coordination, login policy, and rejected-token handling stay in the JavaScript implementation instead of being copied into Python. Source: `packages/py/auth`.
- `dbx-tools-core` - Dependency-free Python configuration, identity, and mise-backed executable helpers shared by dbx-tools packages. Source: `packages/py/core`.
- `dbx-tools-core-rs` - Generated Python bindings for Databricks authentication, runtime utilities, and Lakebase address parsing from the dbx-tools-core Rust crate. Source: `packages/py/core-rs`.
- `dbx-tools-google-rs` - Generated Python bindings for Google Application Default Credentials from the dbx-tools-google Rust crate. Source: `packages/py/google-rs`.
- `dbx-tools-graphiti` - Native launcher for Graphiti with local Neo4j and dbx-model-proxy processes configured for Databricks Model Serving. It runs directly on the host without Docker, Podman, or another container runtime. Source: `packages/py/graphiti`.
- `dbx-tools-postgres` - Python Lakebase/Postgres connection setup, advisory locks, and topic fan-out for services that already hold a Databricks WorkspaceClient. This package is the Python counterpart to @dbx-tools/postgres. Lakebase address parsing comes directly from the generated dbx-tools-core-rs Rust bindings. Source: `packages/py/postgres`.

## Rust

- `dbx-tools-core` - Databricks authentication, flexible API requests, Lakebase parsing, caching, and filesystem primitives. Source: `packages/rs/core`.
- `dbx-tools-google` - Google integrations backed by native Rust libraries. The current surface is Google Application Default Credentials. Source: `packages/rs/google`.
- `dbx-tools-model` - Rust Model Serving discovery, capability policy, and endpoint resolution for Databricks. Source: `packages/rs/model`.
- `dbx-tools-model-proxy` - Rust proxy between OpenAI or Anthropic clients and Databricks Model Serving protocols. Source: `packages/rs/model-proxy`.
- `dbx-tools-service` - Reusable Rust lifecycle and persistence support for per-user dbx-tools background services. Source: `packages/rs/service`.

## Shared Contracts

- `@dbx-tools/shared-auth` - Browser-safe schemas and types for the dbx-tools passwordless authentication gate. Source: `packages/js/shared/auth`.
- `@dbx-tools/shared-core` - Browser-safe utility base for @dbx-tools/* packages. Source: `packages/js/shared/core`.
- `@dbx-tools/shared-email` - Browser-safe email sending schemas and inferred types. Source: `packages/js/shared/email`.
- `@dbx-tools/shared-email-template` - Universal React Email presentation shared by dbx-tools server and browser email surfaces. Source: `packages/js/shared/email-template`.
- `@dbx-tools/shared-fs` - Browser-safe filesystem contract and abstract base for rooted storage backends. Source: `packages/js/shared/fs`.
- `@dbx-tools/shared-genie` - Browser-safe Genie schemas, event vocabulary, and snapshot diff helpers. Source: `packages/js/shared/genie`.
- `@dbx-tools/shared-mastra` - Browser-safe contract for the AppKit Mastra plugin. Source: `packages/js/shared/mastra`.
- `@dbx-tools/shared-model` - Browser-safe model-selection contracts generated from the canonical model owner. Source: `packages/js/shared/model`.
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

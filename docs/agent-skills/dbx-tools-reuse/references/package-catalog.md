# dbx-tools package catalog

Generated from repository manifests and package READMEs for dbx-tools 0.9.33.
Inspect the installed manifest, README, exports, and source before relying on a capability.

## CLI Tools

- `@dbx-tools/cli` - The dbx CLI for workspace lifecycle, AppKit env, Databricks OAuth, and a gated public tunnel. Source: `packages/js/cli/dbx-tools`.
- `@dbx-tools/cli-appkit-env` - CLI and formatting helpers for exporting AppKit auto-configuration results. Source: `packages/js/cli/appkit-env`.
- `@dbx-tools/cli-auth` - Databricks OAuth commands mounted under dbx auth. Source: `packages/js/cli/auth`.
- `@dbx-tools/cli-lakebase-proxy` - Pure Node loopback PostgreSQL proxy for Databricks Lakebase. It uses @dbx-tools/lakebase for Node-owned address parsing, profile-aware resource discovery, and per-connection database credentials. The upstream connection is authenticated by pg over certificate-verified TLS, then tunneled opaquely. Source: `packages/js/cli/lakebase-proxy`.
- `@dbx-tools/cli-model-gateway` - Foreground and system-tray service commands for @dbx-tools/appkit-model-gateway. Source: `packages/js/cli/model-gateway`.
- `@dbx-tools/cli-service` - Product-agnostic system-tray service lifecycle for Node and Bun CLIs. A consuming Commander program gets service install, start, stop, restart, status, and uninstall commands from one typed definition. Source: `packages/js/cli/service`.
- `@dbx-tools/cli-tunnel` - Wrap any command in a public Portr, FRP, or combined tunnel fronted by @dbx-tools/auth-gate email OTP and passkeys. Source: `packages/js/cli/tunnel`.

## Node and AppKit

- `@dbx-tools/appkit` - Node-side helpers for Databricks AppKit apps. Source: `packages/js/node/appkit`.
- `@dbx-tools/appkit-graphiti` - AppKit process plugin for the Python dbx-tools-graphiti MCP runtime. Source: `packages/js/node/appkit-graphiti`.
- `@dbx-tools/appkit-mastra` - AppKit plugin and server-side toolkit for hosting Mastra agents inside a Databricks App. Source: `packages/js/node/appkit-mastra`.
- `@dbx-tools/appkit-model-gateway` - AppKit plugin and standalone Bun server for OpenAI, Anthropic, Codex, and Databricks AI Gateway model traffic. Source: `packages/js/node/appkit-model-gateway`.
- `@dbx-tools/appkit-web-search` - Server-side web-search runtime, Mastra tools, and AppKit plugin. Source: `packages/js/node/appkit-web-search`.
- `@dbx-tools/auth` - Databricks profile resolution and token or authentication-header production for Node.js and Bun. Source: `packages/js/node/auth`.
- `@dbx-tools/auth-gate` - Passwordless authentication runtime built on Better Auth, email OTP, passkeys, and caller-provided identity policy and delivery. Source: `packages/js/node/auth-gate`.
- `@dbx-tools/core` - Node-only core helpers for layered configuration, binary installation, process execution, locking, and project discovery. Source: `packages/js/node/core`.
- `@dbx-tools/databricks` - Databricks workspace, filesystem, cloud, and network utilities. Source: `packages/js/node/databricks`.
- `@dbx-tools/databricks-zerobus` - Region-aware Zerobus ingest helpers for Databricks workspaces. Source: `packages/js/node/databricks-zerobus`.
- `@dbx-tools/email` - Server-side email runtime, agent tools, and AppKit plugin. Source: `packages/js/node/email`.
- `@dbx-tools/fs` - Node local-disk FileSystem implementation of the @dbx-tools/shared-fs contract. Built on BaseFileSystem, so this package only owns host separator conversion (toBackendPath), Node I/O, symlink containment (preparePath), and errno mapping. Source: `packages/js/node/fs`.
- `@dbx-tools/genie` - Server-side Databricks Genie chat drivers. Source: `packages/js/node/genie`.
- `@dbx-tools/lakebase` - Node-native Lakebase connection primitives shared by AppKit and the local PostgreSQL proxy. Source: `packages/js/node/lakebase`.
- `@dbx-tools/model` - Workspace-aware Databricks Model Serving selection. Source: `packages/js/node/model`.
- `@dbx-tools/path` - Node filesystem path toolkit for discovery, matching, ignoring, scanning, and watching. Source: `packages/js/node/path`.
- `@dbx-tools/postgres` - Connection-correct PostgreSQL primitives for Node.js: advisory locks that hold the connection they lock, and a structured topic bus over LISTEN/NOTIFY. Source: `packages/js/node/postgres`.
- `@dbx-tools/search` - Extensions for AppKit's beta AI Search plugin: agent tools, federated search, index lifecycle helpers, and an AppKit-compatible Lakebase full-text provider. Source: `packages/js/node/search`.
- `@dbx-tools/teams` - Server-side Microsoft Teams Adaptive Card runtime, agent tool, and AppKit plugin. Source: `packages/js/node/teams`.
- `@dbx-tools/tunnel` - Front an app with a public Portr and/or FRP tunnel and the passwordless @dbx-tools/auth-gate gate, in-process. Source: `packages/js/node/tunnel`.

## Python

- `dbx-tools-core` - Dependency-free Python configuration, identity, and mise-backed executable helpers shared by dbx-tools packages. Source: `packages/py/core`.
- `dbx-tools-graphiti` - Native launcher for Graphiti with local Neo4j and dbx-model-gateway processes configured for Databricks Model Serving. It runs directly on the host without Docker, Podman, or another container runtime. Source: `packages/py/graphiti`.
- `dbx-tools-postgres` - Python Lakebase/Postgres connection setup, advisory locks, and topic fan-out for services that already hold a Databricks WorkspaceClient. This package is the Python counterpart to @dbx-tools/postgres. Shared address parsing and identity rules are generated from the public Node package modules. Source: `packages/py/postgres`.

## Shared Contracts

- `@dbx-tools/shared-auth` - Browser-safe schemas and types for passwordless authentication and Databricks profile selection. Source: `packages/js/shared/auth`.
- `@dbx-tools/shared-core` - Browser-safe utility base for @dbx-tools/* packages. Source: `packages/js/shared/core`.
- `@dbx-tools/shared-email` - Browser-safe email sending schemas and inferred types. Source: `packages/js/shared/email`.
- `@dbx-tools/shared-email-template` - Universal React Email presentation shared by dbx-tools server and browser email surfaces. Source: `packages/js/shared/email-template`.
- `@dbx-tools/shared-fs` - Browser-safe filesystem contract and abstract base for rooted storage backends. Source: `packages/js/shared/fs`.
- `@dbx-tools/shared-genie` - Browser-safe Genie schemas, event vocabulary, and snapshot diff helpers. Source: `packages/js/shared/genie`.
- `@dbx-tools/shared-mastra` - Browser-safe contract for the AppKit Mastra plugin. Source: `packages/js/shared/mastra`.
- `@dbx-tools/shared-model` - Browser-safe model-selection contracts generated from the canonical model owner. Source: `packages/js/shared/model`.
- `@dbx-tools/shared-model-gateway` - Browser-safe Zod contracts and model-discovery client for @dbx-tools/appkit-model-gateway. Source: `packages/js/shared/model-gateway`.
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

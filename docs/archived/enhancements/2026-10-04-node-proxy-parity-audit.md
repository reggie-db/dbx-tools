# Node proxy parity audit

Status: active

## Runtime ownership

The active model-proxy and Lakebase runtime paths no longer depend on the Rust
bindings or Rust release-binary installer. The generated Rust workspace,
release metadata, bindings, and synchronization tasks remain available as
build-time artifacts only.

`packages/js/cli/dbx-tools/test/runtime-dependencies.test.ts` enforces that the
umbrella CLI, Node model package, Python model-proxy launcher, AppKit Graphiti,
AppKit, Postgres helpers, Node Lakebase package, and Node Lakebase proxy cannot
reach `@dbx-tools/core-rs`, `@dbx-tools/model-rs`, or
`@dbx-tools/rust-binary`. It also rejects those dependencies from the generated
Python model and model-proxy manifests.

## Lakebase parity

The Node Lakebase path covers the Rust proxy's active behavior:

- PostgreSQL URL, canonical resource path, endpoint host, and project parsing.
- Profile-aware discovery with pagination, default selection, and unusable
  resource filtering.
- Per-connection database credential creation and certificate-verified upstream
  TLS.
- Startup parameter preservation with resolved user and database replacement.
- Synthetic local cancellation keys and verified-TLS upstream cancellation.
- Rust-compatible SQLSTATE categories and aggregate connection statistics.
- Loopback-only binding, startup timeout, URL formatting, package version, and
  PostgreSQL TCP port validation.

The Node implementation intentionally uses `pg` for the authenticated upstream
handshake and then forwards the PostgreSQL stream without protocol-specific
pooling or multiplexing, matching the Rust process model.

## Model-proxy parity

The Python LiteLLM host and Node model client cover the primary public runtime:

- OpenAI Chat, Responses, embeddings, Anthropic compatibility, and streaming
  through LiteLLM.
- Node-owned authentication, profile switching, endpoint discovery, catalogue
  caching, fuzzy ranking, protocol selection, and capability metadata.
- Dynamic OpenAI and Codex model catalogues, lookup parameters, web-search
  capability metadata, originator handling, and OpenAPI injection.
- Loopback defaults, service installation, systray lifecycle, health, and auth
  profile APIs.

The replacement is not yet behaviorally identical to the advanced Rust-only
subsystems. Remaining gaps are process-local adaptive token admission,
same-family congestion fallback, the typed GraphQL metrics/event system,
request image resizing, and the model-proxy-specific retry/cooldown control
API. LiteLLM continues to own general retries, protocol translation, streaming,
and provider transport. These gaps do not introduce a Rust runtime dependency;
implement any required replacement in Node-owned model policy or the thin
Python host rather than restoring the Rust service.

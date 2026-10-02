# dbx-tools-service

Reusable Rust lifecycle and persistence support for per-user dbx-tools
background services.

## Key Features

- derives `~/.dbx-tools/<service>` from a service name and exposes it as
  `config_dir` / `--config-dir`;
- registers launchd and systemd services through `service-manager` at
  `ServiceLevel::User`;
- registers Windows startup through `auto-launcher` and supervises the stored
  exact executable with `sysinfo`;
- persists non-secret launch arguments, settings, and bounded consumer
  aggregates in one service-owned SQLite database;
- copies the selected executable into `<config-dir>/bin` before registration;
- supplies typed install, start, stop, restart, status, and uninstall commands;
- treats `remove` as an uninstall alias and retains configuration unless
  `--purge` is explicit;
- starts an optional native tray companion at login when
  `--systray auto|always` and capability probing permit it;
- keeps the service headless for `--systray never` or an unsupported `auto`
  session;
- optionally supplies a generic no-WebView tray event loop, GraphQL query and
  subscription routing, demand-aware retained topics, and aide OpenAPI
  finalization behind Cargo features;
- rejects every lifecycle operation in a consumer-defined invalid runtime such
  as a Databricks App.

## Use

```rust
use dbx_tools_service::{ServiceConfig, ServiceLifecycle};

let service = ServiceLifecycle::new(ServiceConfig::new("example", 4000)?);
```

Consumers provide the service executable, optional tray companion,
default port, non-secret server argument resolver, and invalid-runtime
detector. A tray capability probe runs the companion with `--probe`.
`always` fails when the probe fails, while `auto` omits an unsupported
companion. The service remains the registered process in every mode.

Direct `auto` runtimes use memory. Installed services receive their stable
configuration directory and service marker, so `auto` resolves to SQLite.
Runtime selections and aggregates survive restart without persisting tokens,
client secrets, or environment mutations.

The `tray` feature owns only native menu and event-loop plumbing. Consumers own
their icon, menu, actions, and any user interface. The `graphql` feature owns
query, mutation, configurable GraphiQL samples, and WebSocket subscription
routing on a consumer-selected path. The `topics` feature provides typed live-only, latest,
and bounded replay feeds; one `stored` flag enables SQLite durability when the
runtime has storage. Live-only topics with no subscribers do no publication
work. The `openapi` feature owns aide finalization, JSON and YAML documents,
Scalar routing, and free-form JSON/event-stream documentation adapters.
`graphql::validate_samples` type-checks configured examples without running
resolvers, so consumers can fail startup or tests on stale examples.

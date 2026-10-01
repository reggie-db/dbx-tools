# dbx-tools-service

Reusable Rust lifecycle support for per-user dbx-tools background services.

## Key Features

- derives `~/.dbx-tools/<service>` from a service name and exposes it as
  `config_dir` / `--config-dir`;
- registers launchd and systemd services through `service-manager` at
  `ServiceLevel::User`;
- registers Windows startup through `auto-launcher` in the current-user
  registry and supervises the stored exact executable with `sysinfo` for
  functional start, stop, and restart;
- opens and migrates a service-owned SQLite database through `rusqlite` and
  `rusqlite_migration`;
- persists non-secret executable arguments and companion configuration;
- copies service and companion executables into `<config-dir>/bin` before
  registration so Cargo builds and versioned download caches can change without
  mutating a launching executable;
- supplies reusable `--config-dir`, `--persistence auto|memory|sqlite`, and
  installed-service runtime options;
- supplies `SettingsStore` with process-local memory and shared service-owned
  SQLite implementations for non-secret runtime selection;
- stores bounded aggregate consumer data through the same `ServiceStorage`
  connection without exposing a second database;
- manages companion autostart with `auto`, `always`, and `never` policy;
- starts an enabled companion immediately, records its process identity, and
  writes its stdout/stderr under `<config-dir>/logs`;
- exposes typed Clap commands for install, start, stop, restart, status, and
  uninstall, with `remove` as an uninstall alias;
- exposes a hidden machine-readable requirements preflight that parses the
  original install argv, evaluates companion policy and capability, and returns
  the resolved argv to release-binary orchestrators;
- provides an optional `desktop` feature with the shared tray-icon runtime,
  native Wry window on macOS and Windows, Linux browser fallback, lifecycle
  menu actions, health status, and callback-based health/open overrides;
- reports registration, local health, metrics URL, systray autostart
  registration, and current systray process status.

## Use

```rust
use dbx_tools_service::{ServiceConfig, ServiceLifecycle};

let service = ServiceLifecycle::new(ServiceConfig::new("example", 4000)?);
```

Consumers supply their executable, default port, non-secret server argument
resolver, and invalid-runtime detector. `auto` is the default systray policy
and registers the companion only when its tray-icon capability probe succeeds.
`always` fails when the probe fails, while `never` disables companion startup.
Uninstall retains the configuration directory unless purge is explicit.

Direct `auto` runtimes use memory. Installed services inject their stable
configuration directory and service marker into launched argv, so `auto` uses
the shared `ServiceStorage` SQLite connection. A successful non-secret runtime
selection and consumer-owned aggregates can survive restart without persisting
a token, client secret, or environment mutation. Explicit `memory` and `sqlite`
values override auto selection.

Every lifecycle operation checks the configured invalid-runtime detector before
touching service or SQLite state. Model proxy supplies
`dbx_tools_core::is_databricks_app`, so service management fails immediately
inside Databricks Apps.

Windows startup remains a per-user login registration rather than a Windows
Service. `auto-launcher` owns that registration. Start, stop, and restart use
the exact persisted executable and argv plus `sysinfo` process inspection,
without shell parsing or handwritten Task Scheduler definitions.

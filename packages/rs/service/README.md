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
- selects a desktop executable as the one primary service process when
  `--systray auto|always` and capability probing permit it;
- falls back to the headless executable for `--systray never` or an unsupported
  `auto` session;
- rejects every lifecycle operation in a consumer-defined invalid runtime such
  as a Databricks App.

## Use

```rust
use dbx_tools_service::{ServiceConfig, ServiceLifecycle};

let service = ServiceLifecycle::new(ServiceConfig::new("example", 4000)?);
```

Consumers provide the headless executable, optional desktop executable,
default port, non-secret server argument resolver, and invalid-runtime
detector. A desktop capability probe runs the candidate with `--probe`.
`always` fails when the probe fails, while `auto` chooses the headless process.
Only the selected executable is registered and started.

Direct `auto` runtimes use memory. Installed services receive their stable
configuration directory and service marker, so `auto` resolves to SQLite.
Runtime selections and aggregates survive restart without persisting tokens,
client secrets, or environment mutations.

Desktop tray, window, and WebView behavior belongs to
[`dbx-tools-service-desktop`](../service-desktop/README.md). This crate remains
focused on service registration, process lifecycle, and persistence.

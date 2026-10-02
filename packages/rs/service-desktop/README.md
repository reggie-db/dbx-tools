# dbx-tools-service-desktop

Reusable Tauri shell behavior for dbx-tools background services.

## Key features

- Native system tray with service-owned icon and title.
- Lazy window presentation and close-to-tray behavior.
- Graceful quit event for consumer-managed runtime shutdown.
- Capability probe mode for automatic service installation.
- Debug-only localhost MCP bridge support.

Consumers own their commands, IPC contracts, frontend, and service runtime.
`dbx-tools-service-desktop` owns only reusable desktop lifecycle behavior.

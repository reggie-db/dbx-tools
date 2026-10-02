# `@dbx-tools/cli-model-proxy`

Lazy `dbx model-proxy` command group for direct proxy execution and per-user
service management.

Direct execution preserves native argument forwarding:

```sh
dbx model-proxy --profile PROFILE
```

Install the service with its optional native tray companion:

```sh
dbx model-proxy service install -- --profile PROFILE
```

The service configuration defaults to `~/.dbx-tools/model-proxy`. Override it
with `--config-dir`. Systray startup defaults to `auto`, which runs the
tray executable's native capability probe before registration. Select
`always` to require a supported tray session or `never` to install only the
headless service. The service and companion use separate processes.
Persistence also defaults to `auto`: direct execution uses memory and an
installed service uses the shared `service.sqlite3`. Pass
`--persistence memory|sqlite` to the native command for an explicit choice.
`--show-sensitive` opts into unredacted authorization, cookie, token, and
API-key header values in live GraphQL events. It defaults off.

This package does not define the lifecycle command tree or its options. It
forwards argv to the Rust command. Before installation, it calls the Rust
service requirements preflight with the original argv, restores a `--`
that Commander stripped so server flags stay after that delimiter, installs
the hidden tray executable only when requested, and forwards the preflight's
resolved argv.

Lifecycle commands:

```sh
dbx model-proxy service start
dbx model-proxy service stop
dbx model-proxy service restart
dbx model-proxy service status
dbx model-proxy service uninstall
dbx model-proxy service remove
```

Uninstall retains the configuration directory and SQLite state. Pass
`--purge` to remove them.

On macOS and Linux, lifecycle operations use a user-level launchd or systemd
service. On Windows, install uses current-user login startup and the native
service runtime supervises the stored exact executable path for start, stop,
and restart.

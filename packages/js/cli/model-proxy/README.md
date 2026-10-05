# `@dbx-tools/cli-model-proxy`

Lazy `dbx model-proxy` command group for the Python LiteLLM proxy and its
per-user service lifecycle.

Direct execution preserves argument forwarding:

```sh
dbx model-proxy --profile PROFILE
```

Install the service with its optional native tray companion and dbx-tools icon:

```sh
dbx model-proxy service install -- --profile PROFILE
```

The CLI first accepts an already installed `dbx-model-proxy` only when its
runtime metadata identifies the Python LiteLLM implementation at the same
version as this npm package. Otherwise it uses `uv tool install` to install the
matching `dbx-tools-model-proxy` release, then forwards argv to that stable tool
environment. Set `DBX_TOOLS_MODEL_PROXY_COMMAND` to an explicit executable or
`DBX_TOOLS_MODEL_PROXY_PACKAGE` to a local path or alternate Python requirement.

The service configuration defaults to `~/.dbx-tools/model-proxy`. Override it
with `--config-dir`. Systray startup defaults to `auto`, which probes the native
backend before registration. Select `always` to require a supported desktop
session or `never` for a headless service. Service and tray logs live beside the
configuration as `service.log` and `tray.log`.

Use `service install --concurrent` to install an isolated test instance. It uses
port `4001`, a separate `~/.dbx-tools/model-proxy-python` directory, and
independent service and tray registrations.

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

macOS uses launchd, Linux uses systemd user units, and Windows uses current-user
scheduled tasks. The tray opens local proxy pages, switches Databricks profiles,
and can stop the service. Host service management is rejected inside Databricks
Apps.

# @dbx-tools/cli-graphiti

Run the Python Graphiti stack from Bun, or install it as a current-user desktop
service using the shared dbx-tools service lifecycle.

This package owns the matching Python runtime bootstrap and foreground model
gateway command resolution. AppKit integrations reuse these modules rather than
maintaining their own installers. Python owns Graphiti, Neo4j, persistence, and
backend supervision; `@dbx-tools/cli-service` owns compilation, startup entries,
tray hosting, control channels, and install/start/stop/restart/status/uninstall.

## Start Graphiti

Install `@dbx-tools/cli-graphiti` with Bun and provide a Python environment with
pip and access to your configured Python package registry:

```sh
bun add @dbx-tools/cli-graphiti
bunx dbx-graphiti --python python3 --profile MY-PROFILE
```

The umbrella CLI exposes the same command as `dbx graphiti`. The launcher checks
the installed `dbx-tools-graphiti` version and installs the matching version when
needed. Missing pip fails explicitly; it never downloads a bootstrap script or
bypasses your configured registry.

Python start options are forwarded unchanged:

```sh
bunx dbx-graphiti --profile MY-PROFILE --model databricks-gpt-5
```

## Manage the desktop service

```sh
dbx graphiti service install --python python3 --profile MY-PROFILE
dbx graphiti service status
dbx graphiti service restart
dbx graphiti service stop
dbx graphiti service uninstall
```

Install bootstraps the matching Python version and persists the Python executable,
profile, and resolved foreground model-gateway command. The shared service host
launches Python directly through its existing executable contract; it does not
bundle Graphiti or introduce another supervisor. Use an absolute Python path
when the login environment does not include your Python installation on `PATH`.
Restart relaunches that runtime; reinstall after changing local source or versions.
Other Python settings use their existing environment variables. AppKit apps keep
their app-scoped sidecar supervision and do not install a desktop service.

## Reuse runtime bootstrap

```ts
import { ensureGraphitiPython, ensureGraphitiModelGateway } from "@dbx-tools/cli-graphiti/runtime";

await ensureGraphitiPython("python3");
const command = ensureGraphitiModelGateway();
```

`runtime` owns bootstrap and foreground execution. `cli` owns Commander mounting
and the Graphiti service definition. Import those owners instead of copying
Python installation or package-bin resolution into another package.

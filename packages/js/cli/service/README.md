# @dbx-tools/cli-service

Add desktop-service installation, lifecycle commands, and a tray menu to a
Commander CLI. Users can keep your command running after their terminal closes
and manage it through the same `service` commands on macOS, Linux, and Windows.

## Add Service Commands

```ts
import { buildServiceCommand } from "@dbx-tools/cli-service/cli";
import { defineService } from "@dbx-tools/cli-service/definition";
import { Command } from "commander";

const program = new Command("example");
program.addCommand(
  buildServiceCommand(
    defineService(import.meta.url, {
      command: { arguments: ["serve"] },
      menu: [{ type: "url", label: "Open App", url: "http://127.0.0.1:4400" }],
    }),
  ),
);
await program.parseAsync(process.argv);
```

`defineService` uses the owning package's name, version, and default executable.
Use `command.binName` when the package has multiple executable entries. Set
`command.executable` to run an existing external program instead of compiling a
package entrypoint.

## Install And Manage The Service

For the example program above:

```sh
example service install
example service status
example service stop
example service start
example service restart
example service uninstall
```

Installation starts the service by default. Pass `--no-start` to install without
launching it. `status` reports installation and process state as JSON.

The service belongs to the current user. Login startup uses a LaunchAgent on
macOS, an XDG autostart entry on Linux, and a Startup command on Windows. Package
entrypoints are compiled with Bun into `~/.dbx-tools/bin`.

`restart` stops and starts the installed executable; it does not rebuild it.
Re-run `install` after upgrading a consuming package to replace compiled
executables and update the saved configuration.

## Customize The Tray Menu

The default tray menu shows the program name and version and offers `Quit`.
Add URL, command, or separator items through the service definition. Custom
command items can select a package binary or an external executable just like
the main service command.

Use this package when adding service support to another CLI so users get the
same installation, lifecycle commands, and tray behavior. The generated
reference uses `<cli>` as a placeholder for the consuming program's name.

<!-- cli-reference:start -->

## Command Reference

### `<cli> service`

```text
Usage: <cli> service [command]

Install and manage the desktop service

Commands:
  install [options]  Install the service for the current user and start it
  start              Start the installed service
  stop               Stop the running service
  restart            Restart the installed service
  status             Print service installation and process state as JSON
  uninstall          Stop and remove the service for the current user
```

### `<cli> service install`

```text
Usage: <cli> service install [options]

Install the service for the current user and start it

Options:
  --no-start  install without starting the service
```

### `<cli> service start`

```text
Usage: <cli> service start

Start the installed service
```

### `<cli> service stop`

```text
Usage: <cli> service stop

Stop the running service
```

### `<cli> service restart`

```text
Usage: <cli> service restart

Restart the installed service
```

### `<cli> service status`

```text
Usage: <cli> service status

Print service installation and process state as JSON
```

### `<cli> service uninstall`

```text
Usage: <cli> service uninstall

Stop and remove the service for the current user
```

<!-- cli-reference:end -->

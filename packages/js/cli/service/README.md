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
package entrypoint. Managed commands default `NODE_ENV` to `production`; an
explicit `command.environment.NODE_ENV` overrides it.

`command.options` accepts either a concrete option object or a Zod object
schema. Objects serialize their current values. Schemas parse `{}` and serialize
their defaults. Boolean values become positive or negated flags, arrays become
repeated flags, and `undefined` values are omitted:

```ts
defineService(import.meta.url, {
  command: {
    arguments: ["serve"],
    options: {
      host: "127.0.0.1",
      port: 4400,
      telemetry: false,
    },
  },
});
```

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

Install and manage the desktop service

```sh
<cli> service [command]
```

#### Commands

| Command             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `install [options]` | Install the service for the current user and start it |
| `start`             | Start the installed service                           |
| `stop`              | Stop the running service                              |
| `restart`           | Restart the installed service                         |
| `status`            | Print service installation and process state as JSON  |
| `uninstall`         | Stop and remove the service for the current user      |

### `<cli> service install`

Install the service for the current user and start it

```sh
<cli> service install [options]
```

#### Options

| Option       | Description                                                       |
| ------------ | ----------------------------------------------------------------- |
| `--start`    | Start the service after installation. (default: true, env: START) |
| `--no-start` | Disable start the service after installation.                     |

### `<cli> service start`

Start the installed service

```sh
<cli> service start
```

### `<cli> service stop`

Stop the running service

```sh
<cli> service stop
```

### `<cli> service restart`

Restart the installed service

```sh
<cli> service restart
```

### `<cli> service status`

Print service installation and process state as JSON

```sh
<cli> service status
```

### `<cli> service uninstall`

Stop and remove the service for the current user

```sh
<cli> service uninstall
```

<!-- cli-reference:end -->

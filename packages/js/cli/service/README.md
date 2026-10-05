# @dbx-tools/cli-service

Product-agnostic system-tray service lifecycle for Node and Bun CLIs. A
consuming Commander program gets `service install`, `start`, `stop`, `restart`,
`status`, and `uninstall` commands from one typed definition.

The resident `systray2` host can manage a foreground command and display a
system tray icon. Its default menu contains:

- `<program name> - <version>`
- `Quit`

Custom menu items can open an external URL, run a command, or add a separator.

## Usage

```ts
import { fileURLToPath } from "node:url";

import { buildServiceCommand } from "@dbx-tools/cli-service/cli";
import { Command } from "commander";

const program = new Command("example");
program.addCommand(
  buildServiceCommand({
    id: "com.example.gateway",
    name: "Example Gateway",
    version: "1.0.0",
    icon: fileURLToPath(new URL("../assets/icon.png", import.meta.url)),
    command: {
      entrypoint: fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      arguments: ["serve"],
    },
    menu: [
      {
        type: "url",
        label: "Models",
        url: "http://127.0.0.1:4400/v1/models",
      },
    ],
  }),
);
```

The service definition is serialized at install time. Use absolute paths for
file-based tray images, managed executables, and working directories so login
startup does not depend on a shell or its `PATH`. `systray2` also accepts
base64-encoded icon content.

`service install` uses the package's Bun dependency to compile the tray host and
every command with an `entrypoint`. Standalone executables are installed under
`~/.dbx-tools/bin` through `@dbx-tools/core/bin`, and systray2's native helper is
installed under `~/.dbx-tools/bin/traybin`. Startup therefore does not require a
globally installed Node or Bun runtime. Set `command.executable` only for an
already-built external program that should not be compiled.

macOS installs a per-user LaunchAgent, Linux installs an XDG autostart desktop
entry, and Windows installs a current-user Startup command. Start, stop, and
status use a local socket or named pipe rather than process-name matching.

## Publication

This package is public because generated package output is compiled with `tsc`,
not bundled into consuming CLIs. A private workspace package would leave a
published CLI with an unavailable runtime dependency.

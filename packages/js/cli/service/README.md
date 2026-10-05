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
import { defineService } from "@dbx-tools/cli-service/definition";
import { Command } from "commander";

const program = new Command("example");
program.addCommand(
  buildServiceCommand(
    defineService(import.meta.url, {
      icon: fileURLToPath(new URL("../assets/icon.png", import.meta.url)),
      command: {
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
  ),
);
```

`defineService()` accepts an owning module's `import.meta.url` or a package name.
It derives package name, version, service ID, display name, and a single default
bin from the package manifest. Package names resolve from installed packages
first and then from current monorepo workspace manifests. Override `version`,
`id`, `name`, or `command.binName` only when those defaults are not appropriate.

`service install` uses the package's Bun dependency to compile the tray host and
each package bin or explicit command entrypoint. Standalone executables are
installed under `~/.dbx-tools/bin` through `@dbx-tools/core/bin`. Direct
third-party package dependencies are derived from the owner manifest and
installed under `~/.dbx-tools/node_modules`; callers do not maintain an external
package list. systray2's native helper is installed under
`~/.dbx-tools/bin/traybin`. Startup therefore does not require a globally
installed Node or Bun runtime. Set `command.executable` only for an already-built
external program that should not be compiled.

macOS installs a per-user LaunchAgent, Linux installs an XDG autostart desktop
entry, and Windows installs a current-user Startup command. Start, stop, and
status use a local socket or named pipe rather than process-name matching.

## Publication

This package is public because generated package output is compiled with `tsc`,
not bundled into consuming CLIs. A private workspace package would leave a
published CLI with an unavailable runtime dependency.

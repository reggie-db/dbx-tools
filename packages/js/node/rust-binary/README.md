# `@dbx-tools/rust-binary`

Release registry and runtime installer for native dbx-tools commands.

## Key features

- exposes the generated Rust command and platform-asset registry;
- selects the current OS and architecture without downloading during discovery;
- installs exact-version release archives atomically through `@dbx-tools/core`;
- forwards arguments, inherited I/O, signals, and native exit status;
- keeps binary download policy out of the dependency-light core package.

## Use

```ts
import { ensureRustReleaseBinary, rustReleaseBinaryCommand } from "@dbx-tools/rust-binary";

const command = rustReleaseBinaryCommand("model-proxy");
const installed = await ensureRustReleaseBinary(command);
```

`@dbx-tools/cli/rust-binary` remains a compatibility re-export. New server-side
consumers should import this package directly so they do not install unrelated
CLI commands and their dependencies.

## Modules

- `rust-binary` - generated command lookup, platform selection, exact-version
  installation, and process forwarding.

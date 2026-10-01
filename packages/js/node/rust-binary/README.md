# `@dbx-tools/rust-binary`

Release registry and runtime installer for native dbx-tools commands.

## Key features

- exposes the generated command and platform-asset registry;
- selects the current OS and architecture without downloading during discovery;
- installs exact-version release archives atomically through `@dbx-tools/core`;
- forwards arguments, inherited I/O, signals, and native exit status;
- keeps binary download policy out of the dependency-light core package.

## Use

```ts
import { ensureReleaseBinary, releaseBinaryCommand } from "@dbx-tools/rust-binary";

const command = releaseBinaryCommand("model-proxy");
const installed = await ensureReleaseBinary(command);
```

## Modules

- `release-binary` - generated command lookup, platform selection, exact-version
  installation, and process forwarding.

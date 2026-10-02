# `@dbx-tools/rust-binary`

Release registry and runtime installer for native dbx-tools commands.

## Key features

- exposes the generated command and platform-asset registry (`crateName` and
  `cargoFeatures` included);
- selects the current OS and architecture without downloading during discovery;
- installs exact-version GitHub archives atomically through `@dbx-tools/core`;
- falls back to `cargo install --version` into a private temp `--root` when the
  GitHub archive is missing, then copies the resulting `file://` binary;
- forwards arguments, inherited I/O, signals, and native exit status;
- keeps binary download policy out of the dependency-light core package.

## Use

```ts
import { ensureReleaseBinary, releaseBinaryCommand } from "@dbx-tools/rust-binary";

const command = releaseBinaryCommand("model-proxy");
const installed = await ensureReleaseBinary(command);
```

## Modules

- `release-binary` - generated command lookup, platform selection, GitHub or
  cargo exact-version installation, and process forwarding.

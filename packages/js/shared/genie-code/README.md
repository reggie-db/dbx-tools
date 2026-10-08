# `@dbx-tools/shared-genie-code`

Browser-safe configuration for the managed Genie Code CLI and its local
model-gateway sidecar.

## Resolve Runtime Options

Use `resolveGenieCodeOptions()` to apply the shared defaults. Use
`genieCodeHomeName()` with the first twelve hexadecimal characters of a
SHA-256 over the exact profile value to derive a stable profile home. Models
use invocation overlays within that home.

```ts
import { resolveGenieCodeOptions } from "@dbx-tools/shared-genie-code/options";

const options = resolveGenieCodeOptions({
  profile: "MY-PROFILE",
  model: "gpt",
});
```

## Validate Generated Configuration

Use `GenieCodeConfigSchema` at the TOML serialization boundary. It validates the
selected model, local Responses provider, static process bearer header, trusted
projects, and terminal model-availability settings.

The package contains no filesystem, process, download, or credential logic.
Those concerns belong to the Node CLI and authentication packages.

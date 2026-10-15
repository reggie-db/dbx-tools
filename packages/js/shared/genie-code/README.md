# @dbx-tools/shared-genie-code

Resolve and validate configuration shared by the managed Genie Code CLI and its
local model gateway sidecar without loading either runtime. Use these schemas
for option defaults, profile homes, and generated TOML.

## Resolve runtime options

Use `resolveGenieCodeOptions()` to apply the shared defaults.

```ts
import { genieCodeHomeName, resolveGenieCodeOptions } from "@dbx-tools/shared-genie-code/options";

const options = resolveGenieCodeOptions({
  profile: "MY-PROFILE",
  model: "gpt",
});

const homeName = genieCodeHomeName({
  profile: "MY-PROFILE",
  digest: "0123456789ab",
});
```

`genieCodeHomeName()` accepts the exact profile and the first 12 lowercase
hexadecimal characters of its SHA-256 digest. The CLI owns digest calculation
and uses invocation overlays within that profile home.

## Validate generated configuration

Use `GenieCodeConfigSchema` at the TOML serialization boundary. It validates the
selected model, local Responses provider, static process bearer header, trusted
projects, and terminal model-availability settings.

## Runtime boundary

The package contains no filesystem, process, download, hashing, or credential
logic. The [dbx CLI](../../cli/dbx-tools) owns installation, profile-home
derivation, process startup, and credentials. Gateway protocol and model
discovery contracts live in
[@dbx-tools/shared-model-gateway](../model-gateway).

# Run per-user Lakebox workloads

Use the AppKit Lakebox plugin to give each authenticated application user a
persistent Linux home, terminal, desktop, OCI image services, and machine
metrics in one app-managed Databricks Lakebox.

## Install the Lakebox packages

```bash
bun add @databricks/appkit @dbx-tools/appkit @dbx-tools/appkit-lakebox
```

Add `@dbx-tools/appkit-mastra` when an agent needs the Lakebox workspace
sandbox. Add `@dbx-tools/ui-lakebox` when the browser needs Lakebox controls.

## Share one runtime

Create one `LakeboxRuntime` and pass it to each integration:

```ts
import { lakebase, server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import { lakebox, LakeboxRuntime } from "@dbx-tools/appkit-lakebox";
import { resolveLakeboxPluginConfig } from "@dbx-tools/appkit-lakebox/config";
import { lakeboxSkillMounts } from "@dbx-tools/appkit-lakebox/skills";
import { lakeboxWorkspaceSandbox } from "@dbx-tools/appkit-lakebox/workspace";
import { agents, mastra } from "@dbx-tools/appkit-mastra";

const runtime = new LakeboxRuntime(resolveLakeboxPluginConfig());
const analyst = agents.createAgent({
  instructions: "Use the workspace when the task requires files or commands.",
});

await appkit.createApp({
  plugins: [
    server(),
    lakebase(),
    lakebox({ runtime }),
    mastra({
      agents: { analyst },
      sandbox: lakeboxWorkspaceSandbox(runtime),
      localSkillMounts: lakeboxSkillMounts(),
    }),
  ],
});
```

Lakebase stores the Databricks-assigned Lakebox ID, serializes creation across
app replicas, and retains the last observed service definitions. The first
command or service operation starts the Lakebox when automatic startup is
enabled.

## Render Lakebox controls

```tsx
import { LakeboxIndicator, LakeboxPanel } from "@dbx-tools/ui-lakebox/react";

export function LakeboxPage() {
  return (
    <>
      <LakeboxIndicator />
      <LakeboxPanel />
    </>
  );
}
```

Import `@dbx-tools/ui-lakebox/styles.css` after the AppKit UI theme. The browser
reads the route prefix from the plugin's client configuration.

## Create an image service

Agents use `create_lakebox_service`. REST clients send the same request to the
plugin service route:

```json
{
  "name": "hello",
  "image": "docker.io/library/python:3.12-alpine",
  "command": ["sh", "-c", "python -m http.server \"$SERVICE_PORT\" --bind 127.0.0.1"],
  "mounts": [{ "source": "data", "target": "/data" }]
}
```

The service must listen on `127.0.0.1:$SERVICE_PORT`. Lakebox injects
`SERVICE_NAME`, `SERVICE_PATH`, `SERVICE_PORT`, and `PORT`. Mount sources are
relative to the user's persistent home.

This API runs OCI images without a Docker daemon. It does not expose privileged
mode, device access, bridge networks, port publishing, or arbitrary host
mounts.

## Understand identity and lifecycle

The app service principal creates, starts, stops, and deletes the shared
Databricks Lakebox. An on-behalf-of-user identity selects a locked Linux
account and authorizes that user's routes.

Each user gets a persistent home and private service ports. A platform idle
timeout stops the Lakebox. A later command or routed request starts it and
restores saved service definitions. Files persist. Process memory does not.

Stopping or deleting the shared Lakebox affects every user. Normal AppKit
shutdown closes SSH sessions and forwarding bridges but leaves idle shutdown to
the Databricks platform.

## Review security limits

- Commands and services do not receive Databricks credentials, cookies, or SSH
  agent access.
- Non-loopback routes fail closed without an authenticated identity.
- Image services use private PID, IPC, mount, and user namespaces.
- Metrics report machine CPU, memory, storage, and network counters. They do
  not expose process data.
- Lakebase is required for resource identity, replica convergence, and
  last-known service definitions.

## <a id="additional-resources"></a> Additional resources

- [@dbx-tools/appkit-lakebox](../packages/js/node/appkit-lakebox/README.md)
- [@dbx-tools/lakebox](../packages/js/node/lakebox/README.md)
- [@dbx-tools/shared-lakebox](../packages/js/shared/lakebox/README.md)
- [@dbx-tools/ui-lakebox](../packages/js/ui/lakebox/README.md)

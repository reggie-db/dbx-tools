# @dbx-tools/shared-databricks-sandbox

Browser-safe Zod contracts shared by the AppKit SSH server and React controls.

## Parse machine discovery

```ts
import { sshMachinesResponseSchema } from "@dbx-tools/shared-databricks-sandbox";

const response = sshMachinesResponseSchema.parse(
  await fetch("/api/databricks-sandbox/machines").then((res) => res.json()),
);
for (const machine of response.machines) {
  console.log(machine.id, machine.status);
}
```

## Validate a route request

```ts
import { addSshRouteRequestSchema } from "@dbx-tools/shared-databricks-sandbox";

const route = addSshRouteRequestSchema.parse({
  machineId: "sandbox-id",
  remotePort: 3000,
  path: "/my-service",
  stripPrefix: true,
});
```

`stripPrefix` follows the tunnel/Caddy routing default when omitted: non-root
route paths are removed before forwarding, while `/` is preserved.
Requested suffixes are automatically scoped beneath the configured route prefix
and the authenticated user's short FNV hash. With the default prefix,
`/my-service` becomes `/sandbox/<user-hash>/my-service`. The hash prevents route
name collisions; authenticated owner checks remain the security boundary.

Use these schemas for browser/server boundaries. Server-only REST clients,
private keys, SSH sessions, and proxy transports belong to
`@dbx-tools/appkit-databricks-sandbox`.

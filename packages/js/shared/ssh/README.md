# @dbx-tools/shared-ssh

Browser-safe Zod contracts shared by the AppKit SSH server and React controls.

## Parse machine discovery

```ts
import { sshMachinesResponseSchema } from "@dbx-tools/shared-ssh";

const response = sshMachinesResponseSchema.parse(
  await fetch("/api/ssh/machines").then((res) => res.json()),
);
for (const machine of response.machines) {
  console.log(machine.id, machine.status);
}
```

## Validate a route request

```ts
import { addSshRouteRequestSchema } from "@dbx-tools/shared-ssh";

const route = addSshRouteRequestSchema.parse({
  machineId: "sandbox-id",
  remotePort: 3000,
  path: "/sandbox/my-service",
  stripPrefix: true,
});
```

`stripPrefix` follows the tunnel/Caddy routing default when omitted: non-root
route paths are removed before forwarding, while `/` is preserved.
Paths outside the configured route prefix are automatically scoped beneath it;
with the default prefix, `/my-service` becomes `/sandbox/my-service`.

Use these schemas for browser/server boundaries. Server-only REST clients,
private keys, SSH sessions, and proxy transports belong to
`@dbx-tools/appkit-ssh`.

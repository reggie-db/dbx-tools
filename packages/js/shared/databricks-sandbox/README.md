# @dbx-tools/shared-databricks-sandbox

Browser-safe Zod contracts for Databricks Sandbox machines, services, commands,
and persisted Projects.

## Parse machines

```ts
import { sshMachinesResponseSchema } from "@dbx-tools/shared-databricks-sandbox";

const response = sshMachinesResponseSchema.parse(
  await fetch("/api/databricks-sandbox/machines").then((result) => result.json()),
);
```

Each machine includes its lifecycle state, expiration, built-in services, and
persisted Projects.

## Validate a Project request

```ts
import { addSshProjectRequestSchema } from "@dbx-tools/shared-databricks-sandbox";

const request = addSshProjectRequestSchema.parse({
  machineId: "sandbox-id",
  name: "demo",
  openPath: "index.html",
  config: {
    tools: { node: "lts" },
  },
});
```

The server generates omitted names, paths, and ports. Project paths are scoped
beneath the authenticated user's route prefix. `config` is serialized to
`mise.toml`. The server injects the reserved Project environment values.

Use these schemas at browser and server boundaries. SSH sessions, private keys,
Lakebase persistence, and proxy transports remain in
`@dbx-tools/appkit-sandbox`.

See the
[`addSshProjectRequestSchema` API](https://docs.dbx.tools/api/shared-databricks-sandbox/src-schemas-variable-addsshprojectrequestschema/)
and
[`sshProjectSchema` API](https://docs.dbx.tools/api/shared-databricks-sandbox/src-schemas-variable-sshprojectschema/)
for field-level descriptions.

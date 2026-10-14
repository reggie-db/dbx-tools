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
  name: "desktop-tool",
  route: false,
  serviceDependencies: ["desktop"],
  tools: { python: "3.12" },
  install: "printf 'print(\"hello\")\\n' > app.py",
  start: "nohup python app.py > app.log 2>&1 < /dev/null & echo $! > app.pid",
});
```

The server generates omitted names, paths, and ports. Project paths are scoped
beneath the authenticated user's route prefix. `config` is serialized to
`mise.toml`. The server injects the reserved Project environment values.
`route: false` keeps lifecycle-only projects out of the HTTP proxy.
`serviceDependencies` starts typed built-in services outside project mise
configuration. `install`, `start`, and `uninstall` map to hidden runtime-owned
tasks. Install is marker-gated; start runs after installation and once per
machine boot. Other tasks remain user-invoked.

Use these schemas at browser and server boundaries. SSH sessions, private keys,
Lakebase persistence, and proxy transports remain in
`@dbx-tools/appkit-sandbox`.

See the
[`addSshProjectRequestSchema` API](https://docs.dbx.tools/api/shared-databricks-sandbox/src-schemas-variable-addsshprojectrequestschema/)
and
[`sshProjectSchema` API](https://docs.dbx.tools/api/shared-databricks-sandbox/src-schemas-variable-sshprojectschema/)
for field-level descriptions.

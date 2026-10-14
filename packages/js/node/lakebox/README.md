# @dbx-tools/lakebox

Connect to, provision, and run commands on Databricks Lakeboxes.

The package provides the Lakebox REST client and lifecycle convergence, managed
name discovery, and a verified SSH session with pooled native OpenSSH or ssh2
command and forwarding transport. It has no AppKit, React, or Lakebase
dependency. User accounts and services belong to `@dbx-tools/appkit-lakebox`.

## Provision a Lakebox

```ts
import { LakeboxClient } from "@dbx-tools/lakebox/rest";
import { ensureLakeboxRunning } from "@dbx-tools/lakebox/lifecycle";
import { lakeboxManagedName, selectManagedLakebox } from "@dbx-tools/lakebox/managed-name";

const api = new LakeboxClient(workspaceClient.config);
const name = lakeboxManagedName("my-app");
const entry = selectManagedLakebox(await api.list(), name) ?? (await api.create(name));
await api.setIdleTimeout(entry.sandboxId, 3_600);
const running = await ensureLakeboxRunning(api, entry);
```

`LakeboxClient` accepts any credential object with `host` and
`authenticate(headers)`, such as an AppKit or Databricks SDK
`WorkspaceClient.config`. Use the app service principal for lifecycle calls.

## Run a command

```ts
import { SshSession } from "@dbx-tools/lakebox/session";

const command = session.execute("sh", ["-lc", "uname -a"], {
  user: { name: "lakebox-abc1234", home: "/home/lakebox-abc1234" },
  timeoutMs: 30_000,
});
for await (const chunk of command.stdout) process.stdout.write(chunk);
const result = await command.result;
```

Every command clears inherited Databricks credentials and SSH agent variables
before running. `forwardOut(host, port)` opens a forwarded TCP stream through a
separate pool, so long-lived WebSockets never consume the warm command
connection.

## Configuration

| Field | Values | Default |
| --- | --- | --- |
| `sshTransport` | `auto`, `openssh`, `ssh2` | `auto` prefers native OpenSSH with SOCKS5 |
| `ssh2Patch` | `auto`, `true`, `false` | `auto` patches only in development |

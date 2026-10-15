# @dbx-tools/lakebox

Connect to, provision, and run commands on Databricks Lakeboxes.

## Provision a Lakebox

```ts
import { client as authClient } from "@dbx-tools/auth";
import { LakeboxClient } from "@dbx-tools/lakebox/rest";
import { ensureLakeboxRunning } from "@dbx-tools/lakebox/lifecycle";

const auth = await authClient.createAuthClient({ profile: "MY-PROFILE" });
const api = new LakeboxClient({
  host: auth.host,
  ...(auth.workspaceId ? { workspaceId: auth.workspaceId } : {}),
  authenticate: async (headers) => {
    for (const [name, value] of Object.entries(await auth.headers())) {
      headers.set(name, value);
    }
  },
});
const entry = await api.create();
await api.setIdleTimeout(entry.sandboxId, 3_600);
const running = await ensureLakeboxRunning(api, entry);
```

`LakeboxClient` accepts any credential object with `host` and
`authenticate(headers)`. AppKit and the Databricks SDK
`WorkspaceClient.config` satisfy this contract directly. The example adapts
`@dbx-tools/auth` for an explicit local profile. Use the app service principal
for lifecycle calls in a Databricks App.

## Connect and run a command

Create or load an SSH key, register it with the workspace, verify the gateway
host key, and close the session when work finishes:

```ts
import { SshKeyStore } from "@dbx-tools/lakebox/key-store";
import type { LakeboxClient, LakeboxEntry } from "@dbx-tools/lakebox/rest";
import { SshSession } from "@dbx-tools/lakebox/session";

export async function runCommand(
  api: LakeboxClient,
  running: LakeboxEntry,
  user: { name: string; home: string },
): Promise<void> {
  const owner = "my-service";
  const keys = new SshKeyStore();
  const key = await keys.ensureRegistered(api, owner);
  const gatewayHost = running.gatewayHost ?? key.gatewayHost;
  if (!gatewayHost) {
    throw new Error("The Lakebox API did not return an SSH gateway host");
  }

  const gatewayPort = 2_222;
  const scope = await api.workspaceScope();
  const knownHost = await keys.knownHost(scope, owner, gatewayHost, gatewayPort);
  const session = new SshSession({
    host: gatewayHost,
    port: gatewayPort,
    username: running.sandboxId,
    privateKey: key.privateKey,
    privateKeyPath: key.privateKeyPath,
    knownHostsPath: keys.knownHostsPath(scope, owner, gatewayHost, gatewayPort),
    connectTimeoutMs: 30_000,
    sshTransport: "auto",
    ssh2Patch: "auto",
    ...(knownHost ? { knownHost } : {}),
    rememberHost: (fingerprint, hostKey) =>
      keys.rememberHost(scope, owner, gatewayHost, gatewayPort, fingerprint, hostKey),
  });

  try {
    await session.connect();
    const command = session.execute("sh", ["-lc", "uname -a"], {
      user,
      timeoutMs: 30_000,
    });
    const result = await command.result;
    if (!result.success) {
      throw new Error(result.stderr || `Command exited with ${result.exitCode}`);
    }
  } finally {
    await session.close();
  }
}
```

Every command clears inherited Databricks credentials and SSH agent variables
before it runs. `execute()` returns a live `SshCommand`. Its `stdout` and
`stderr` fields are async iterables, awaiting the command returns its numeric
exit code, and `result` returns captured output and timing metadata.

The low-level package doesn't create Linux users. Pass an account that already
exists on the Lakebox. `@dbx-tools/appkit-lakebox` creates and isolates
application user accounts before it runs their commands.

`forwardOut(host, port)` opens a forwarded TCP stream through a separate pool.
Long-lived HTTP and WebSocket streams don't consume the warm command
connection.

## Stop or delete a Lakebox

Use lifecycle convergence when you need to wait for a terminal state:

```ts
import { ensureLakeboxStopped } from "@dbx-tools/lakebox/lifecycle";
import type { LakeboxClient, LakeboxEntry } from "@dbx-tools/lakebox/rest";

export async function stopAndDelete(api: LakeboxClient, running: LakeboxEntry): Promise<void> {
  const stopped = await ensureLakeboxStopped(api, running);
  await api.delete(stopped.sandboxId);
}
```

`stop()` preserves the persistent Lakebox filesystem. `delete()` permanently
removes the Lakebox and its data.

## Configuration

| Field          | Values                    | Default                                   |
| -------------- | ------------------------- | ----------------------------------------- |
| `sshTransport` | `auto`, `openssh`, `ssh2` | `auto` prefers native OpenSSH with SOCKS5 |
| `ssh2Patch`    | `auto`, `true`, `false`   | `auto` patches only in development        |

`SshSessionOptions` also requires the gateway host and port, Lakebox ID as the
SSH username, private key material, key and known-host paths, and a connection
timeout. `SshKeyStore` stores keys and gateway fingerprints under
`~/.dbx-tools/lakebox` unless you pass another root.

## Understand lifecycle and transport limits

- `ensureLakeboxRunning()` and `ensureLakeboxStopped()` poll for up to five
  minutes.
- The REST client doesn't map users, persist app resource identity, or manage
  services. Use [@dbx-tools/appkit-lakebox](../appkit-lakebox/README.md) for
  those application-level capabilities.
- The command pool keeps one tested connection warm and grows to 10
  connections. Forwarding uses a separate pool with no minimum.
- Each borrowed SSH resource handles one operation and is destroyed after that
  command or forwarded stream. A failed forwarding open retries once with a new
  resource. Established streams and commands aren't replayed.
- `auto` selects native OpenSSH when it is available and selects ssh2
  otherwise. It doesn't switch transports after a runtime failure.
- `close()` cancels active commands, closes transport pools, and waits for an
  in-progress connection attempt to settle.

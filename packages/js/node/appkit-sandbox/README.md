# @dbx-tools/appkit-sandbox

AppKit plugin for Databricks Sandboxes. It provides user-scoped machine
management, SSH command execution, Mastra tools, Mastra workspace transport,
and authenticated routes to HTTP services running in a Sandbox.

The plugin uses the Databricks Lakebox REST API. It does not invoke the
Databricks CLI.

## Install

```bash
bun add @dbx-tools/appkit-sandbox
```

## Configure AppKit

Create one
[`SshRuntime`](https://docs.dbx.tools/api/appkit-sandbox/src-runtime-class-sshruntime/)
and share it between the AppKit plugin and the Mastra workspace resolver:

```ts
import { resolveSshPluginConfig } from "@dbx-tools/appkit-sandbox/config";
import { databricksSandbox } from "@dbx-tools/appkit-sandbox/plugin";
import { SshRuntime } from "@dbx-tools/appkit-sandbox/runtime";
import { databricksSandboxSkillMounts } from "@dbx-tools/appkit-sandbox/skills";
import { sshWorkspaceSandbox } from "@dbx-tools/appkit-sandbox/workspace";
import { mastra } from "@dbx-tools/appkit-mastra";
import { lakebase } from "@databricks/appkit";

const sshRuntime = new SshRuntime(
  resolveSshPluginConfig({
    auto: true,
    routePrefix: "/sandbox",
    defaultRemotePort: 3000,
    sandboxLifetimeSeconds: 86_400,
    reaperIntervalSeconds: 300,
  }),
);

const plugins = [
  lakebase(),
  databricksSandbox({ runtime: sshRuntime }),
  mastra({
    codeMode: true,
    sandbox: sshWorkspaceSandbox(sshRuntime),
    localSkillMounts: databricksSandboxSkillMounts(),
  }),
];
```

Register `lakebase()` before `databricksSandbox()`. Lakebase stores machine
ownership and expiration records that every app instance uses for
authorization and cleanup.

The SSH workspace is an execution target only when an agent or tool requests
an SSH-backed operation. Automatic Mastra Code Mode continues to use its native
isolated runtime for other work.

## Requirements

- The workspace exposes the Databricks Sandbox REST API.
- The AppKit server identity can list and manage the user's Sandboxes and SSH
  keys.
- The AppKit server host provides `ssh` on `PATH`.
- The app registers `lakebase()` before this plugin.

Command sessions use the system OpenSSH client. Direct TCP forwarding uses
`ssh2`.

## Configure machine behavior

Pass options through
[`resolveSshPluginConfig()`](https://docs.dbx.tools/api/appkit-sandbox/src-config-function-resolvesshpluginconfig/).
The complete schema and field descriptions are in the
[`SshPluginConfig` API reference](https://docs.dbx.tools/api/appkit-sandbox/src-config-typealias-sshpluginconfig/).

| Option | Default | Behavior |
| --- | --- | --- |
| `auto` | `true` | Starts a stopped machine before a command, service, or route uses it. Creation remains explicit. |
| `fallbackToServicePrincipal` | `false` | Retries a failed request-scoped OBO REST operation with the app service principal. |
| `sandboxLifetimeSeconds` | `86400` | Sets the absolute lifetime recorded in Lakebase and the managed Sandbox name. |
| `reaperIntervalSeconds` | `300` | Sets the cleanup scan interval. Set it to `0` to disable scheduled scans. |
| `routePrefix` | `/sandbox` | Sets the AppKit root path for proxied Sandbox services. |
| `defaultRemotePort` | `3000` | Sets the default port used by route requests. |
| `gatewayPort` | `2222` | Sets the Databricks Sandbox SSH gateway port. |
| `connectTimeoutMs` | `30000` | Sets the SSH connection timeout. |
| `commandTimeoutMs` | `120000` | Sets the default remote command timeout. |
| `keyDirectory` | `~/.dbx-tools/appkit-databricks-sandbox` | Overrides the server-side SSH key and known-host directory. |

### Authentication fallback

The plugin performs workspace REST requests with the current user's OBO
credentials. Set `fallbackToServicePrincipal: true` only when the app must retry
failed user-scoped requests with its shared service-principal identity.

Fallback applies to REST operations. Machine assignment checks still apply to
discovery, lifecycle operations, commands, routes, Mastra tools, and Code Mode.
Logs include sanitized status and request metadata. They exclude credentials
and headers.

### Machine lifetime and cleanup

The Lakebox API supports idle auto-stop but does not provide an absolute
wall-clock lifetime. This package records an expiration in Lakebase and in the
managed Sandbox name. The
[`SshRuntime` reaper](https://docs.dbx.tools/api/appkit-sandbox/src-runtime-class-sshruntime/)
runs at startup and at `reaperIntervalSeconds`.

Managed names use this format:

```text
dbx-<adjective>-<animal>-<nonce>_uid_<sha256-user-id>_exp_<epoch-ms>
```

The name supports reconciliation. It is not an authorization boundary. The
reaper applies these rules:

- Delete an expired managed Sandbox.
- Delete a managed Sandbox with no valid Lakebase assignment.
- Delete an assigned Sandbox when its stored and API names differ.
- Remove a Lakebase assignment when its Sandbox no longer exists.
- Leave an unrelated, unassigned workspace Sandbox unchanged.

See the
[`LakebaseMachineOwnershipStore` reference](https://docs.dbx.tools/api/appkit-sandbox/src-ownership-class-lakebasemachineownershipstore/)
for the storage operations and the
[`managed-name` reference](https://docs.dbx.tools/api/appkit-sandbox/src-managed-name/)
for name parsing and generation.

## Publish a Sandbox web service

Use the `add_ssh_route` tool to forward an HTTP port through the AppKit server.
The following request publishes port `3000` at a user-scoped `/my-service`
path:

```json
{
  "machineId": "sandbox-id",
  "remoteHost": "127.0.0.1",
  "remotePort": 3000,
  "path": "/my-service",
  "stripPrefix": true
}
```

The plugin registers user routes beneath `routePrefix` and a stable user hash.
For example, `/my-service` becomes `/sandbox/<user-hash>/my-service`. The hash
prevents path collisions. Assignment checks provide authorization.

`stripPrefix` defaults to `true` for non-root paths and `false` for `/`:

- Use `stripPrefix: true` when the remote app serves relative asset and API
  URLs.
- Use `stripPrefix: false` when the remote app is configured with the complete
  AppKit route as its base path.

The remote process can bind to Sandbox loopback. Browser clients must use the
registered AppKit path, not `localhost`, `127.0.0.1`, `0.0.0.0`, or a direct
Sandbox URL.

The lower-level
[`SshRouteRegistry` API](https://docs.dbx.tools/api/appkit-sandbox/src-routes-class-sshrouteregistry/)
documents route registration, removal, HTTP middleware, and WebSocket upgrade
handling.

### WebSocket routes

Derive `ws://` or `wss://` from the public page origin and connect through the
registered AppKit path. The bridge forwards standard HTTP Upgrade requests and
applies the same prefix-stripping rule.

The bridge does not expose arbitrary TCP or UDP services. A remote application
that requires a fixed root WebSocket path must support the registered prefix or
use `stripPrefix: true`.

## Use built-in browser services

Each assigned machine exposes two owner-scoped paths:

- `/sandbox/terminal/<machine-id>` forwards the DinoTTY web terminal.
- `/sandbox/metrics/<machine-id>` forwards the Glances web interface.

Starting a machine provisions these services under `~/.dbx-tools/runtime`,
binds them to loopback, and registers their proxy routes. Opening a viewer
rechecks the remote service and route first.

[`databricksSandboxSkillMounts()`](https://docs.dbx.tools/api/appkit-sandbox/src-skills-function-databrickssandboxskillmounts/)
mounts packaged Sandbox recipes at `/.dbx-tools/skills`. The recipes include
DinoTTY, Glances, noVNC, a browser speed test, Freedoom, JupyterLab, a
collaborative whiteboard, a fractal explorer, a particle simulation, and a Web
Audio synth.

Example prompts:

- "Start Doom."
- "Launch a speed test."
- "Open a browser desktop."
- "Start JupyterLab."
- "Make a collaborative whiteboard."
- "Show me an interactive fractal."
- "Launch the particle physics demo."
- "Open the browser synth."

## Use Mastra tools and Code Mode

The plugin registers these AppKit tool-provider entries:

- `databricks-sandbox.list_ssh_machines`
- `databricks-sandbox.create_ssh_machine`
- `databricks-sandbox.start_ssh_machine`
- `databricks-sandbox.stop_ssh_machine`
- `databricks-sandbox.delete_ssh_machine`
- `databricks-sandbox.execute_ssh_command`
- `databricks-sandbox.start_ssh_machine_service`
- `databricks-sandbox.add_ssh_route`
- `databricks-sandbox.remove_ssh_route`

[`sshWorkspaceSandbox()`](https://docs.dbx.tools/api/appkit-sandbox/src-workspace-function-sshworkspacesandbox/)
implements a request-scoped Mastra `WorkspaceSandbox` resolver. It uses the
same machine selection, assignment, lifecycle, SSH key, and host-verification
behavior as the AppKit tools and REST routes.

The resolver selects a running assigned machine first, then another assigned
machine. Set `machineId` when an agent must use a specific Sandbox. The resolver
does not create a machine when none exists.

## Security model

### Machine authorization

A machine is available only when an unexpired Lakebase assignment matches all
of these values:

- The Databricks workspace scope.
- The AppKit user ID.
- The Sandbox ID.
- The managed Sandbox name.

Creation writes the assignment immediately after the Lakebox API returns. If
the Lakebase write fails, the plugin deletes the new Sandbox.

The Sandbox API used by this package does not provide native per-user Sandbox
scopes. The assignment store limits which machines the application reveals and
operates. It does not replace Databricks workspace authorization.

### SSH key storage

[`SshKeyStore`](https://docs.dbx.tools/api/appkit-sandbox/src-key-store-class-sshkeystore/)
creates one Ed25519 key pair for each workspace and AppKit user. The plugin
registers only the public key. The private key remains on the AppKit server with
restricted file permissions.

The default storage root is:

```text
~/.dbx-tools/appkit-databricks-sandbox
```

Set `keyDirectory` to use another server-side location.

### SSH host verification

The first successful connection stores the Sandbox gateway host-key
fingerprint and an OpenSSH known-host entry. Later connections reject a changed
key.

[`SshSession`](https://docs.dbx.tools/api/appkit-sandbox/src-session-class-sshsession/)
passes the stored file through OpenSSH `UserKnownHostsFile`. It does not disable
host verification.

# @dbx-tools/appkit-databricks-sandbox

AppKit plugin for Databricks Sandboxes. It provides user-scoped creation,
discovery, lifecycle controls, deletion, SSH command execution, Mastra tools,
Mastra workspace sandbox transport, and dynamic routes to HTTP servers running
in a Sandbox.

The plugin uses the Databricks Lakebox REST API for creation, discovery,
lifecycle controls, deletion, and SSH-key registration. It does not invoke the
Databricks CLI.

## AppKit setup

Create one runtime and share it between the Sandbox plugin and Mastra sandbox
resolver:

```ts
import { resolveSshPluginConfig } from "@dbx-tools/appkit-databricks-sandbox/config";
import { databricksSandbox } from "@dbx-tools/appkit-databricks-sandbox/plugin";
import { SshRuntime } from "@dbx-tools/appkit-databricks-sandbox/runtime";
import { sshWorkspaceSandbox } from "@dbx-tools/appkit-databricks-sandbox/workspace";
import { databricksSandboxSkillMounts } from "@dbx-tools/appkit-databricks-sandbox/skills";
import { mastra } from "@dbx-tools/appkit-mastra";

const sshRuntime = new SshRuntime(
  resolveSshPluginConfig({
    auto: true,
    routePrefix: "/sandbox",
    defaultRemotePort: 3000,
    machineAssignments: [{ userId: "user-id", machineId: "sandbox-id" }],
  }),
);

const plugins = [
  databricksSandbox({ runtime: sshRuntime }),
  mastra({
    codeMode: true,
    sandbox: sshWorkspaceSandbox(sshRuntime),
    localSkillMounts: databricksSandboxSkillMounts(),
  }),
];
```

The SSH workspace is an execution target only when a workspace or Sandbox tool
needs it. Automatic Mastra Code Mode continues to use isolated-vm or QuickJS,
including concurrent external tool calls, and does not require an SSH machine.
An SSH connection is opened only when Code Mode or the agent calls an exposed
SSH-backed tool.

## Requirements

- The workspace must expose the Databricks Sandbox REST API.
- The AppKit server identity must be able to list and manage the current user's
  Sandboxes and SSH keys.
- The AppKit server host must provide `ssh` on `PATH`. Command sessions use the
  system OpenSSH client because the Databricks Sandbox gateway does not send the
  exec request acknowledgement required by `ssh2`.
- `ssh2` remains the transport for direct TCP forwarding to remote web servers.

`auto: true` starts a stopped Sandbox when a command or route needs it.
`auto: false` requires an explicit start operation. Creation remains an
explicit user or tool action in either mode.

The Lakebox API supports idle auto-stop configuration but does not expose a
maximum wall-clock runtime. This package does not emulate a maximum runtime
with process-local timers because that would not survive app restarts.

`fallbackToServicePrincipal: true` keeps HTTP requests OBO-first, then retries a
failed workspace call with the app service principal. The default is `false` so
applications must opt into the broader shared identity. Both attempts emit
sanitized warning logs with status, Databricks error codes, request ids, and
bounded response bodies; credentials and headers are redacted.

## Remote web routes

`add_ssh_route` forwards an HTTP port from a Sandbox into the AppKit server. A
request for port `3000` can ask for the `/my-service` suffix:

```json
{
  "machineId": "sandbox-id",
  "remoteHost": "127.0.0.1",
  "remotePort": 3000,
  "path": "/my-service",
  "stripPrefix": true
}
```

User routes are registered beneath `routePrefix` and a stable six-character FNV
hash of the authenticated user. For example, `/my-service` becomes
`/sandbox/<user-hash>/my-service`. A caller may reuse its full assigned prefix,
but another prefix is rejected. The hash is only a collision-avoidance
namespace, not a security measure; authenticated owner checks continue to
control access and deletion. The dynamic dispatcher is mounted after plugin API
routes and before the static SPA fallback. Longer route paths take precedence
over shorter paths.

`stripPrefix` defaults to `true` for non-root paths and `false` for `/`, matching
the existing tunnel/Caddy reverse-proxy behavior. Set it to `false` when the
remote server expects the full registered AppKit path.

The remote process may bind to Sandbox loopback, but agents and browser clients
must never use or return `localhost`, `127.0.0.1`, `0.0.0.0`, or a direct
Sandbox URL. The registered AppKit path is the only browser-facing address.
Services must use relative asset/API URLs with `stripPrefix: true`, or be
configured with the full registered base path when `stripPrefix: false`.

WebSocket clients must derive `ws://` or `wss://` from the public page origin
and connect through the same registered route. The bridge forwards standard
HTTP Upgrade requests and applies `stripPrefix` to WebSocket paths too. It does
not expose arbitrary TCP/UDP services, and applications that require a fixed
root WebSocket path must be configured for the route prefix or use stripping.

The forwarding bridge uses a Unix socket for HTTP on Unix systems and an
ephemeral loopback TCP port on Windows. WebSocket upgrades use a separate
loopback bridge when the HTTP bridge is a Unix socket. `http-proxy-3` owns both
proxy paths.

## Built-in browser services

Every assigned machine advertises two stable reserved paths outside the
user-route namespace:

- `/terminal/<machine-id>` forwards the DinoTTY mobile web terminal.
- `/metrics/<machine-id>` forwards the full Glances Web UI.

Starting a machine provisions both services over SSH under
`~/.dbx-tools/runtime`, binds them to loopback, and registers owner-scoped proxy
routes. Opening either viewer rechecks the service and route before opening a
new browser tab.

`databricksSandboxSkillMounts()` exposes the packaged DinoTTY, Glances, and
reverse-proxy-aware noVNC recipes at `/.dbx-tools/skills` through Mastra's
native local-skill mount contract.

## Mastra tools

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

`sshWorkspaceSandbox()` implements Mastra `WorkspaceSandbox`, so Code Mode uses
the same machine selection, lifecycle, command, key, and host-verification
behavior as the tools and REST routes.

## Security and storage

Every machine is hidden and unusable until it is assigned to the current AppKit
user. User-created Sandboxes are assigned immediately after creation. This
protects service-principal fallback from exposing all workspace Sandboxes to
every caller. Configure bootstrap assignments with `machineAssignments`, or
use the plugin export's `assignMachine(userId, machineId)` and
`unassignMachine(userId, machineId)` operations from trusted server code.
Assignment is enforced for discovery, lifecycle, deletion, commands, routes,
Mastra tools, and Code Mode.

Assignment storage uses the registered AppKit `lakebase()` pool when available.
If Lakebase initialization fails in `auto` mode, it falls back to an atomic
locked JSON file in the operating system's application-data directory. Set
`ownershipStorage` to `lakebase` or `disk` to require one backend, and use
`ownershipPath` to override the disk location. Multiple user identities may be
assigned to the same machine when an app has both platform and external-gate
identity forms.

SSH keys are generated per workspace and AppKit user under
`~/.dbx-tools/appkit-databricks-sandbox` by default. The plugin registers only the public key.
Private keys and OpenSSH known-host files remain on the AppKit server with
restricted file permissions.

The first successful connection stores the gateway host-key fingerprint.
Later connections reject a changed key. Native OpenSSH command sessions use the
stored key through a dedicated `UserKnownHostsFile`; they do not disable host
verification.

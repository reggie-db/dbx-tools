# @dbx-tools/appkit-sandbox

AppKit integration for Databricks Sandboxes. It manages assigned machines,
executes SSH commands, provisions browser services, and persists isolated
Projects in Lakebase.

## Install

```bash
bun add @dbx-tools/appkit-sandbox
```

## Configure AppKit

Register AppKit `lakebase()` before
[`databricksSandbox()`](https://docs.dbx.tools/api/appkit-sandbox/src-plugin-variable-databrickssandbox/).
The Sandbox plugin reuses that service-principal pool after plugins initialize.
It does not create another pool or request user-scoped Postgres credentials.

Create one
[`SshRuntime`](https://docs.dbx.tools/api/appkit-sandbox/src-runtime-class-sshruntime/)
and share it with the AppKit plugin and Mastra workspace:

```ts
import { lakebase } from "@databricks/appkit";
import { mastra } from "@dbx-tools/appkit-mastra";
import { resolveSshPluginConfig } from "@dbx-tools/appkit-sandbox/config";
import { databricksSandbox } from "@dbx-tools/appkit-sandbox/plugin";
import { SshRuntime } from "@dbx-tools/appkit-sandbox/runtime";
import { databricksSandboxSkillMounts } from "@dbx-tools/appkit-sandbox/skills";
import { sshWorkspaceSandbox } from "@dbx-tools/appkit-sandbox/workspace";

const runtime = new SshRuntime(
  resolveSshPluginConfig({
    auto: true,
    routePrefix: "/sandbox",
    sandboxLifetimeSeconds: 86_400,
    reaperIntervalSeconds: 300,
  }),
);

export const plugins = [
  lakebase(),
  databricksSandbox({ runtime }),
  mastra({
    codeMode: true,
    sandbox: sshWorkspaceSandbox(runtime),
    localSkillMounts: databricksSandboxSkillMounts(),
  }),
];
```

The Mastra resolver uses a Sandbox only for an explicit SSH-backed operation.
Other Code Mode work continues to use Mastra's normal isolated runtime.

## Create a Project

Use the `add_ssh_project` tool instead of creating a proxy route directly:

```json
{
  "machineId": "sandbox-id",
  "name": "demo",
  "openPath": "index.html",
  "config": {
    "tools": {
      "node": "lts"
    },
    "tasks": {
      "start": {
        "run": "[ -f server.mjs ] || exit 0\nif [ -f server.pid ] && kill -0 \"$(cat server.pid)\" 2>/dev/null; then exit 0; fi\nnohup node server.mjs > server.log 2>&1 < /dev/null &\necho $! > server.pid\n"
      },
      "stop": {
        "run": "[ -f server.pid ] && kill \"$(cat server.pid)\" 2>/dev/null || true\n"
      }
    }
  }
}
```

`name`, `path`, and `port` are optional. The runtime generates values that are
unique for the machine, creates `~/projects/<path>`, writes `mise.toml`, runs
`mise trust` and `mise install`, and returns the project `directory`, public
`path`, loopback `port`, and `openUrl`.

Keep `hooks.postinstall` limited to installation or preparation that belongs
to `mise install`. Put runtime lifecycle behavior in `tasks.start` and
`tasks.stop`; use a visible `tasks.uninstall` only when the project has
additional teardown beyond stopping its workload. Before invoking any task,
call `execute_ssh_command` from the returned directory with `command: "sh"`
and
`args: ["-lc", "\"$HOME/.local/bin/mise\" tasks ls --name-only --hidden"]`.
Evaluate the available tasks and invoke only the task defined for the requested
lifecycle action, using the same command and directory with
`args: ["-lc", "\"$HOME/.local/bin/mise\" run <task>"]`. Never concatenate
the executable and arguments into `command`. Start detached servers with
`nohup` and redirected standard streams. The packaged skills under `skills/`
specify when and where to invoke each task.

The runtime injects these values into `[env]`:

- `PROJECT_NAME`
- `PROJECT_PATH`
- `PROJECT_PORT`

A matching caller-supplied value is accepted. A conflicting value fails before
the route or Lakebase record changes. Run commands from the returned directory
with `mise exec` and bind HTTP services to `127.0.0.1:$PROJECT_PORT`.

Pass the returned `projectId` to update the name, path, open path, port, config,
or prefix behavior. An explicit duplicate path or port fails. Omitting a field
during an update retains its stored value.

`remove_ssh_project` runs `mise run stop` and then `mise run uninstall` when
each task exists. Discovery includes hidden tasks for compatibility, but new
`uninstall` tasks should remain visible. Failures are logged and ignored before
the proxy route, Lakebase record, and project directory are removed. Stopping a
Sandbox preserves Projects. Deleting or expiring a Sandbox removes its Project
records without starting the machine for remote cleanup.

The browser-safe request and response fields are defined by
[`addSshProjectRequestSchema`](https://docs.dbx.tools/api/shared-databricks-sandbox/src-schemas-variable-addsshprojectrequestschema/)
and
[`sshProjectSchema`](https://docs.dbx.tools/api/shared-databricks-sandbox/src-schemas-variable-sshprojectschema/).

## Provision machine software

The default `machineSoftware` configuration installs mise in
`~/.local/bin`. The installer adds mise activation to the Sandbox user's Bash
and Zsh startup files, so entering a trusted Project directory activates its
environment.

Add other idempotent setup steps through
[`SshPluginConfig`](https://docs.dbx.tools/api/appkit-sandbox/src-config-typealias-sshpluginconfig/):

```ts
resolveSshPluginConfig({
  machineSoftware: [
    {
      name: "mise",
      checkCommand: 'test -x "$HOME/.local/bin/mise"',
      installCommand: "...",
    },
    {
      name: "custom-tool",
      checkCommand: "command -v custom-tool >/dev/null 2>&1",
      installCommand: "...",
    },
  ],
});
```

Pass an empty array to disable automatic machine setup.

## Machine lifecycle

The AppKit server identity must be able to use the Sandbox REST API and manage
SSH keys. The AppKit host must provide OpenSSH on `PATH`. Direct HTTP and
WebSocket forwarding uses `ssh2`.

The runtime records an absolute expiration in Lakebase and the managed Sandbox
name. The
[`SshRuntime` reaper](https://docs.dbx.tools/api/appkit-sandbox/src-runtime-class-sshruntime/)
runs at startup and on the configured interval. It deletes expired or invalid
managed Sandboxes, removes records for missing Sandboxes, and leaves unrelated
workspace Sandboxes unchanged.

Stopping a machine closes local SSH sessions and forwarding bridges. Persisted
Projects are restored when the app restarts or the machine starts again.

## Authentication and storage

Workspace REST calls use the current AppKit user's OBO credentials when
available. `fallbackToServicePrincipal` can retry a failed REST operation with
the app identity. Machine assignment checks still apply to discovery,
lifecycle, commands, Projects, Mastra tools, and Code Mode.

Assignments and Projects use the AppKit Lakebase service-principal pool through
[`LakebaseMachineOwnershipStore`](https://docs.dbx.tools/api/appkit-sandbox/src-ownership-class-lakebasemachineownershipstore/).
The pool remains owned by the Lakebase plugin. Closing the Sandbox plugin does
not close it.

This assignment layer limits what the application reveals and operates because
the Sandbox API does not expose native per-user Sandbox scopes. It
does not replace Databricks workspace authorization.

## SSH trust

[`SshKeyStore`](https://docs.dbx.tools/api/appkit-sandbox/src-key-store-class-sshkeystore/)
creates one Ed25519 key pair for each workspace and AppKit user. Only the public
key is registered. Private keys and known-host files remain on the AppKit server
under `~/.dbx-tools/appkit-databricks-sandbox` by default.

The first successful connection records the gateway host key. Later connections
reject a changed key.
[`SshSession`](https://docs.dbx.tools/api/appkit-sandbox/src-session-class-sshsession/)
passes the stored file through OpenSSH `UserKnownHostsFile`. Host verification
is never disabled.

## Agent integration

[`sshWorkspaceSandbox()`](https://docs.dbx.tools/api/appkit-sandbox/src-workspace-function-sshworkspacesandbox/)
provides the request-scoped Mastra workspace. The plugin also registers machine,
command, service, and Project tools. Packaged showcase recipes are available
through
[`databricksSandboxSkillMounts()`](https://docs.dbx.tools/api/appkit-sandbox/src-skills-function-databrickssandboxskillmounts/).

[See the complete package API reference.](https://docs.dbx.tools/api/appkit-sandbox/)

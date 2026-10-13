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

## Run commands

`SshRuntime.execute()` and `SshSession.execute()` return an `SshCommand`
immediately, including while machine, session, and project setup continues. Read
`stdout` and `stderr` as live async iterables, await the command for its numeric
exit code, or await `result` for the complete serialized command result:

```ts
const command = runtime.execute(client, userId, {
  machineId,
  command: "sh",
  args: ["-lc", "mise tasks ls --name-only --hidden"],
});

for await (const chunk of command.stdout) {
  consume(chunk);
}

const exitCode = await command;
const result = await command.result;
```

`cancel()` stops an active command and resolves it with exit code 130. A timeout
resolves with exit code 124 and sets `result.timedOut`. REST, AppKit plugin, and
agent-tool boundaries continue to return only the completed serialized result.
The Mastra workspace adapter forwards live chunks through `onStdout` and
`onStderr`.

## Create a Project

Use the `add_ssh_project` tool instead of creating a proxy route directly:

```json
{
  "machineId": "sandbox-id",
  "name": "demo",
  "openPath": "index.html",
  "tools": {
    "node": "lts"
  },
  "postinstall": "[ -f server.mjs ] || exit 0\nif [ -f server.pid ] && kill -0 \"$(cat server.pid)\" 2>/dev/null; then exit 0; fi\nnohup node server.mjs > server.log 2>&1 < /dev/null &\necho $! > server.pid\n",
  "uninstall": "[ -f server.pid ] && kill \"$(cat server.pid)\" 2>/dev/null || true\n",
  "config": {
    "settings": {
      "experimental": true
    }
  }
}
```

`name`, `path`, and `port` are optional. The runtime generates values that are
unique for the machine, creates `/home/sandbox-user/projects/<path>`, writes `mise.toml`, runs
`mise trust` and `mise install`, and returns the project `directory`, public
`path`, loopback `port`, and `openUrl`.

Set `route: false` for a project that does not serve HTTP. Route-less projects
still receive a directory, mise environment, and lifecycle tasks, but they do
not register an AppKit proxy route or return an `openUrl`. Declare required
built-in services with `serviceDependencies`, for example
`serviceDependencies: ["desktop"]`. The runtime starts each dependency before
project setup without writing dependency tasks into the project's `mise.toml`.

`config` accepts a JSON object, a JSON object string, or a complete TOML
string. String input is checked as JSON first and otherwise parsed as TOML
before remote setup. First-class `tools`, `env`, `postinstall`, and `uninstall`
values override conflicts in `config.tools`, `config.env`,
`config.hooks.postinstall`, and `config.tasks.uninstall`. Reserved
`PROJECT_NAME`, `PROJECT_PATH`, and `PROJECT_PORT` may be repeated only with
the injected values. Put generated payloads such as `HTML_CONTENT` in `env`.

Put application file creation, installation,
preparation, initial workload launch, and readiness checks in `postinstall` so
setup progress and completion appear in the project lifecycle log. Do not add
start, stop, or hidden tasks unless the project needs a later explicit operator
action that cannot belong to setup or uninstall. Use check-lock-check plus a
completion marker for expensive setup. Project install is idempotent and uses
one home-owned lifecycle lock and bounded operation log. Concurrent callers
attach to that log, and a failed attempt may retry once before returning an
error.

Before invoking any additional task, call `execute_ssh_command` from the returned directory with `command: "sh"`
and
`args: ["-lc", "\"$HOME/.local/bin/mise\" tasks ls --name-only --hidden"]`.
Evaluate the available tasks and invoke only the task defined for the requested
lifecycle action, using the same command and directory with
`args: ["-lc", "\"$HOME/.local/bin/mise\" run <task>"]`. Never concatenate
the executable and arguments into `command`. Start detached servers with
`nohup` and redirected standard streams. The showcase project recipes under
`skills/` specify when and where to invoke each task. Built-in terminal,
desktop, and stats controls are product capabilities and are not packaged as
skills.

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

`remove_ssh_project` may run only `mise run uninstall` when that task exists.
Uninstall is idempotent and does not wait for an active install: it terminates
the lock owner, removes the lock, and continues teardown. Failures are logged and ignored before
the proxy route, Lakebase record, and project directory are removed. Stopping a
Sandbox preserves Projects. Deleting or expiring a Sandbox removes its Project
records without starting the machine for remote cleanup.

Remote commands do not inherit authentication from the Sandbox image. The SSH
transport clears Databricks environment variables, disables SSH agent
forwarding, and ignores the default Databricks config file before project,
service, or user commands run. Generic `execute_ssh_command.env` overlays cannot
restore Databricks credentials. Sandbox Databricks access requires a dedicated
app callback that obtains short-lived authorization for the current user through
OBO; the app service principal is never exposed to the machine.

Agent, plugin, and browser service starts share an async iterator that yields
`starting`, the current shared home-owned operation `log`,
and then `ready` or `error`; the browser route transports it with SSE. List
polling reconnects to owned running machines after an app restart and recovers
progress plus logs from remote lock, status, and log files. Each machine's
`services` array is the source of truth for enabled built-ins. The Sandbox view
groups enabled services into horizontal tabs and displays the same live logs.
Project rows include a log control before reset so a saved install log can be opened without reinstalling.
Opening a terminal for a project activates
that project's interactive mise shell without enabling global directory
activation.

The browser-safe request and response fields are defined by
[`addSshProjectRequestSchema`](https://docs.dbx.tools/api/shared-databricks-sandbox/src-schemas-variable-addsshprojectrequestschema/)
and
[`sshProjectSchema`](https://docs.dbx.tools/api/shared-databricks-sandbox/src-schemas-variable-sshprojectschema/).

## Provision machine software

The runtime first creates a locked `sandbox-user` account with home
`/home/sandbox-user` and no sudo-group membership. Public commands, projects,
terminals, mise hooks, and service lifecycle run as that user. Privileged
execution is package-private and limited to fixed account and operating-system
prerequisite scripts; REST, agent tools, and Mastra cannot request sudo.

The default `machineSoftware` configuration prepends `~/.local/bin` on PATH,
then installs mise, Homebrew, and pkgx. mise and pkgx live in `~/.local/bin`.
Homebrew installs into `/home/linuxbrew/.linuxbrew` without sudo. The account
bootstrap installs the required operating-system packages (`build-essential`,
`procps`, `curl`, `file`, and `git`) and creates the prefix owned by
`sandbox-user`. The `brew` step adds `brew shellenv` to the Bash, Zsh, and login
profiles. The PATH step is independent of the others. Omit a step or replace
the array to change setup.

Agents install software without sudo or apt, preferring mise, then Homebrew,
then pkgx.

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

## Built-in services

Terminal, desktop, and stats are hidden, machine-owned mise projects under
`/home/sandbox-user/projects/.sandbox-services`. Their packaged `mise.toml` files own
installation and `start`/`stop` lifecycle tasks. Lakebase stores their
definitions separately from user projects, so they do not appear in project
lists or counts.

Service setup uses a workspace-, machine-, and service-scoped Lakebase advisory
lock. Concurrent in-process calls share one operation; after acquiring the
distributed lock, the runtime rechecks the persisted definition and skips
installation when it is current. Packaged lifecycle tasks use home-owned
check-lock-check state, truncate one shared log only while holding the lock,
emit attempt/result records, and bound failed retries. Callers that arrive
during an attempt follow the same log rather than starting parallel work. A service returned as `ready` has
completed its process and endpoint readiness check and has a usable
authenticated route. List polling also runs each packaged hidden `status` task
before accepting a persisted `ready` marker and changes dead services to
`stopped`.

Terminal and stats start with an explicitly started machine. Desktop remains
on demand unless machine creation passes `desktop: true` or a project declares
the desktop service dependency. KasmVNC is downloaded only from its pinned,
checksummed official GitHub release.

## Machine lifecycle

The AppKit server identity must be able to use the Sandbox REST API and manage
SSH keys. When native OpenSSH is available and supports dynamic forwarding,
commands use pooled ControlMaster connections and forwarding uses their SOCKS5
listeners. The ssh2 transport pools verified clients and uses direct TCP
forwarding. Both transports keep one tested command connection warm, expand to
ten connections under command concurrency, and use a separate zero-minimum
forwarding pool so long-lived browser connections do not consume the warm
command connection. A borrowed connection is destroyed after its command or
forwarded stream because the Databricks Russh gateway may allow only one
operation during a connection's lifetime. Dead idle resources fail validation
before use and are replaced.

`DBX_TOOLS_SANDBOX_SSH_TRANSPORT` accepts `auto`, `openssh`, or `ssh2`; `auto`
prefers OpenSSH and otherwise selects ssh2 without later fallback.
`DBX_TOOLS_SANDBOX_SSH_SSH2_PATCH` accepts `auto`, `true`, or `false`. Patch
mode `auto` attempts the Databricks exec-reply workaround only in development,
`true` requires it, and `false` leaves ssh2 unchanged.

Direct localhost navigation does not pass through a front door that injects the
Databricks user headers. In non-production mode, a loopback request to a
single-owner route uses that sole owner. Every non-loopback request still
requires an explicit authenticated identity.

The runtime records one owner and an absolute expiration for each workspace
Sandbox in Lakebase. Assignment migration retains the earliest owner when old
data contains duplicate owners, removes the losing owners' project records,
and enforces uniqueness by workspace and machine. The
[`SshRuntime` reaper](https://docs.dbx.tools/api/appkit-sandbox/src-runtime-class-sshruntime/)
runs at startup and on the configured interval. It deletes expired assigned
Sandboxes, removes records for missing Sandboxes, and leaves unrelated
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
key is registered. Private keys and trusted host fingerprints remain on the
AppKit server under `~/.dbx-tools/appkit-databricks-sandbox` by default.

The first successful connection records the gateway host key. Later connections
reject a changed key.
[`SshSession`](https://docs.dbx.tools/api/appkit-sandbox/src-session-class-sshsession/)
checks that fingerprint during every verified handshake and writes the matching
OpenSSH known-host entry. Host verification
is never disabled.

## Agent integration

[`sshWorkspaceSandbox()`](https://docs.dbx.tools/api/appkit-sandbox/src-workspace-function-sshworkspacesandbox/)
provides the request-scoped Mastra workspace. The plugin also registers machine,
command, service, and Project tools. Packaged showcase recipes are available
through
[`databricksSandboxSkillMounts()`](https://docs.dbx.tools/api/appkit-sandbox/src-skills-function-databrickssandboxskillmounts/).

[See the complete package API reference.](https://docs.dbx.tools/api/appkit-sandbox/)

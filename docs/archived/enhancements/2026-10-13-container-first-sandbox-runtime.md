# Replace Sandbox projects with agent-facing containers

## Status

Superseded on October 13, 2026 by
[`2026-10-13-lakebox-single-app-runtime.md`](../enhancements/2026-10-13-lakebox-single-app-runtime.md).

## Goal

Replace the current mise-based Sandbox project model with a container-first
model that agents can use without generating package-manager configuration or
lifecycle shell.

The public surface should let an agent create, list, inspect, start, and remove
long-running container workloads with typed fields for the subset of Docker-like
behavior that the Databricks Sandbox can actually support. dbx-tools should own
machine startup, background processes, logs, readiness, routes, conflicts, and
cleanup.

## Required outcome

- Keep the locked, non-sudo `sandbox-user` as the identity for every public SSH,
  container, route, terminal, and built-in service operation.
- Remove mise from machine setup, project setup, built-in services, skills,
  documentation, schemas, tests, and runtime state.
- Remove Homebrew and pkgx from default and configurable machine setup.
- Replace configurable `machineSoftware` with one fixed, package-owned,
  idempotent bootstrap for `sandbox-user` and the selected container runtime.
  The runtime may include a root-owned daemon, but public tools and workload
  processes remain non-root.
- Replace Sandbox projects with persisted container definitions.
- Start every saved container after a machine reaches the Databricks `running`
  state. Keep the dbx-tools machine state at `starting` until all saved
  containers reach `ready` or `error`.
- Do not fail machine startup because one container fails. Preserve the failure
  on that container through its state, error, and bounded log.
- Preserve dormant-route wake-up. An HTTP request for a stopped machine starts
  the machine and its saved containers, returns the existing HTML loading page
  to browsers, and returns the existing JSON loading response to other clients.
- Inject `PROJECT_NAME`, `PROJECT_PATH`, and `PROJECT_PORT` into every container.
  Reject user configuration that attempts to define those reserved variables.
- Reject machine-local conflicts for container name, AppKit route path, assigned
  port, and persisted container identifier before remote mutation begins.
- Add explicit agent tools to create, list, and remove containers.
- Describe every request field with Zod text that states the actual runtime
  semantics and unsupported Docker behavior.

## Platform findings

### Databricks Sandbox startup

The current FEVM AWS image has no `~/init.d`, `~/.init.d`, user systemd unit
directory, or other documented home startup hook. PID 1 is
`/usr/bin/sandbox-daemon`, not systemd, and `systemctl` reports the system as
offline. Databricks documentation also states that Sandbox startup
customization is not supported.

Do not depend on an operating-system boot hook. Persist one generated,
idempotent script at:

```text
/home/sandbox-user/.dbx-tools/containers/start-all
```

Call it explicitly from the dbx-tools machine-start convergence path after SSH
and fixed bootstrap readiness. The script is the single remote owner of
starting saved containers. It must use a lock, write one bounded operation log,
continue after individual failures, and exit successfully after recording all
container results.

Live stop/start validation established that the Sandbox preserves only the
platform-created `/home/sandbox-agent` mount. A separately created
`/home/sandbox-user` directory, its passwd entry, system packages, and `/tmp`
are absent after the machine starts again. Persist the `sandbox-user` home in a
package-owned directory beneath `/home/sandbox-agent`, then recreate the locked
account and `/home/sandbox-user` symlink during every fixed bootstrap. The
symlink keeps the public home path stable without storing container state on
the reset root filesystem.

A home-owned completion marker is insufficient. Every machine-start
convergence must recreate the account and symlink, then verify the runtime
binary and its fixed dependencies before trusting persisted runtime state.

### Buildah

Buildah does not provide Docker-style detached execution. `buildah run` waits
for the process and is primarily intended for image construction and debugging.
Therefore dbx-tools must background the runtime command itself and own the PID,
process tree, log, readiness check, and stop behavior.

Live FEVM AWS validation established one working rootless mode:

- Buildah with `crun`.
- An outer `unshare -Ur -m` user and mount namespace.
- `vfs` storage with `ignore_chown_errors=true`.
- Host PID namespace because a private PID namespace cannot mount a new `/proc`.
- `host` or `none` networking.
- No `/dev/fuse` dependency.

This mode can run OCI images, but it does not provide Docker bridge networking
or Docker-style `-p host:container` translation. Routed workloads must use host
networking and listen on the injected `PROJECT_PORT`, which is the same port in
the container and on the Sandbox.

#### Home-owned Buildah and crun bundle

An October 13, 2026 follow-up probe proved that Buildah and crun do not need to
be installed into the reset system image. The probe downloaded the Ubuntu 24.04
package closure with apt in download-only mode, extracted the packages beneath
the persistent `sandbox-user` backing directory, and invoked the binaries
through a wrapper that sets `PATH`, `LD_LIBRARY_PATH`, containers-common
configuration, storage configuration, `HOME`, and `XDG_RUNTIME_DIR`. The probe
never installed Buildah or crun with dpkg or apt.

The extracted bundle was 36,850,755 bytes and contained these packages:

```text
aardvark-dns=1.4.0-5
buildah=1.33.7+ds1-1ubuntu0.24.04.3+esm3
crun=1.14.1-1
fuse3=3.14.0-5build1
fuse-overlayfs=1.13-1
golang-github-containers-common=0.57.4+ds1-2ubuntu0.2
golang-github-containers-image=5.29.2-2
libfuse3-3=3.14.0-5build1
libsubid4=1:4.13+dfsg1-4ubuntu3.2
netavark=1.4.0-4
uidmap=1:4.13+dfsg1-4ubuntu3.2
```

The full dependency closure is acceptable for the proof, but the final bundle
should remove helpers that the selected host-or-none direct-crun mode does not
use only after a live test proves the reduced closure.

The home bundle pulled `python:3.12-alpine`, prepared a `vfs` root filesystem,
created and started a detached OCI container with direct crun, served HTTP on
host networking, survived SSH disconnect, and supported `state`, `kill`, and
`delete` from later SSH sessions. System `buildah` and `crun` commands remained
absent throughout the test.

After a full Sandbox stop/start, dbx-tools recreated the locked account and
home symlink. The same extracted binaries reported their versions, Buildah
listed the saved Python image without repulling it, and direct crun restarted
the saved OCI bundle in approximately six seconds. A later SSH session again
used `state`, `kill`, and `delete` successfully. The fixed bootstrap can
therefore install a versioned home-owned bundle instead of reinstalling apt
packages on every machine start.

### uDocker

uDocker is a candidate because it exposes familiar image and container commands,
including `pull`, `create`, `run`, `ps`, and `rm`, and its PRoot modes document
bind mounts and port publishing. It still does not provide detached execution.
Its `ps` command lists extracted container definitions; it is not authoritative
running-process state.

Do not select uDocker solely because the command names resemble Docker. Complete
the live acceptance matrix below first. dbx-tools remains the owner of running
state, PIDs, logs, readiness, routes, and restart regardless of the selected
engine.

### Root-owned lifecycle engines

A package-owned root daemon is allowed when it materially improves detached
execution, state inspection, mounts, networking, and recovery. Root access is
an implementation capability, not a public Sandbox feature.

The FEVM SSH identity has passwordless sudo, but its root capability bounding
set excludes `CAP_SYS_ADMIN`. Root cannot create a mount namespace:
`sudo unshare -m` fails with `Operation not permitted`. The unprivileged
identity can create a single-map user and mount namespace with
`unshare -Ur -m`.

This boundary prevents the tested root-owned engines from unpacking an OCI
image. Docker Engine 29.1.3 starts with a root-only socket, but both overlayfs
and `vfs` image extraction fail on forbidden bind-mount or unshare operations.
Containerd 2.2.1 starts, but its overlayfs and native snapshotters fail on the
same bind-mount operation. RootlessKit cannot create subordinate UID/GID maps,
and a direct single-map rootless Docker daemon fails during initialization.

Do not select Docker Engine or containerd for the current FEVM AWS image. Keep
the root-daemon branch in the plan only as a future platform capability probe.
If it becomes viable, do not add `sandbox-user` to the `docker` group or expose
the daemon socket because either grants root-equivalent host control.

Direct Buildah plus `crun` remains the minimal non-daemon fallback. Buildah can
prepare the root filesystem and OCI bundle, while `crun create`, `start`,
`state`, `list`, `kill`, and `delete` provide a real detached lifecycle. This
is preferable to backgrounding `buildah run`, but dbx-tools still owns process
restart after a Sandbox stop/start cycle.

Do not describe any candidate as preserving a running process across a Sandbox
stop. Normal restart means recreating the process from its saved definition.
Docker live restore covers daemon disruption, not machine shutdown. Memory
checkpoint and restore through CRIU is a separate optional capability and must
not be part of the initial contract unless it passes a dedicated live test.

### Live runtime matrix

The October 13, 2026 FEVM AWS probe produced these results:

| Runtime | Detached control | Mounts | Networking | Sandbox restart | Result |
| --- | --- | --- | --- | --- | --- |
| Docker Engine 29.1.3 | Daemon starts | Not reached | Not reached | System package resets | Reject: image extraction requires a forbidden mount namespace. |
| containerd 2.2.1 | Daemon starts | Not reached | Not reached | System package resets | Reject: overlayfs and native snapshotters cannot unpack layers. |
| Rootless Docker | Not reached | Not reached | Not reached | Not reached | Reject: RootlessKit UID maps fail; direct single-map dockerd crashes. |
| Podman 4.9.3 with crun | `run -d` survives SSH reconnect | Read-write and read-only bind mounts work | Host networking works; published ports fail without `/dev/net/tun` | Home storage persists | Reject as primary: stop fails across a later user-namespace invocation, private PID `/proc` fails, and non-root container UID mapping fails. |
| Buildah 1.33.7 plus direct crun 1.14.1 | `create`, `start`, `state`, `kill`, and `delete` work across SSH reconnects | Read-write and read-only bind mounts work | Host and none work; no port translation | A 36.9 MB home-owned runtime bundle, image store, and definitions persist; bootstrap recreates the account and home symlink | Preferred OCI lifecycle candidate. The container sees UID 0, mapped to the unprivileged host user. |
| uDocker 1.3.17 PRoot | dbx-tools must background and own the process group | Read-write bind mounts work; read-only bind mounts are unavailable | PRoot port translation works without exposing the container port; no network namespace | Home image and definition stores restore without repull | Preferred compatibility candidate when a non-root container-visible UID or translated port is required. `ps` is not running state. |

The direct-crun and uDocker processes ran concurrently on separate ports. Both
survived SSH disconnects. After a Sandbox stop/start, neither process remained,
but both home-owned image stores remained usable. The initial Buildah probe
reinstalled packages in approximately 11 seconds. The follow-up home-bundle
probe required no package installation and restarted the saved direct-crun
definition in approximately six seconds after the account and home symlink were
recreated. uDocker restarted its saved definition without repulling after its
home-owned executable was restored.

The current platform cannot provide every requested property through one
engine. Direct crun has the stronger detached lifecycle and read-only mounts.
uDocker has container-visible non-root user emulation and port translation but
requires dbx-tools-owned process supervision and has weaker isolation. Record a
product decision between those tradeoffs before implementation.

## Runtime selection gate

Before changing public schemas, test the candidates in disposable FEVM AWS
Sandboxes through the Databricks CLI. Use an explicit configured profile and
delete every probe Sandbox afterward.

Use this candidate order for the remaining acceptance cases:

1. Buildah with direct `crun` lifecycle.
2. uDocker PRoot.

Docker Engine, containerd, rootless Docker, and Podman failed required live
cases on the current image. Re-run them only after a documented FEVM kernel,
capability, device, or base-image change.

The selected engine must pass all public operations without granting
`sandbox-user` sudo, daemon-socket access, or a root-equivalent group. A
package-owned privileged bootstrap and daemon controller may perform the fixed
root operations. The live matrix must include:

1. Pull Alpine and Python images from the intended image source.
2. Create a stable named container definition.
3. Run a Python HTTP server for at least ten minutes.
4. Restart the same saved definition without pulling or recreating it.
5. Stop it through a recorded PID and verify no child process remains.
6. Bind-mount a user-owned host directory read-write at a different container
   path, write from the container, and read the result from the host.
7. Bind-mount the same directory read-only and prove writes fail.
8. Run with no network.
9. Run a routed service on host networking and the assigned high port.
10. Preserve image and container storage across a Sandbox stop/start cycle.
11. Run two containers concurrently with different ports and mounts.
12. Remove one container without damaging the other container or shared image.
13. Report useful exit status and logs for an invalid command and failed image
    pull.
14. Reject unsupported privilege, device, namespace, and port-publish options
    before executing them.
15. Start a container detached, disconnect every SSH session, reconnect, and
    prove the same container process is still running.
16. When the candidate has a daemon, restart it and prove the documented
    restart or live-restore behavior without losing saved definitions.
17. Stop and start the Sandbox, restore all saved definitions, and distinguish
    restarted processes from checkpoint restore.
18. When the candidate has a privileged control endpoint, prove it is
    inaccessible to `sandbox-user` and container processes.
19. Record both the container-visible UID:GID and the host UID:GID. Run
    read-write and read-only bind-mount tests and document any single-map user
    namespace or emulated-identity limitation.

Evaluate port publishing, bridge networking, named volumes, user namespace
mapping, and storage-driver support separately for each candidate. Expose only
the features that pass on the live Sandbox kernel and filesystem. The remaining
decision is direct crun for stronger lifecycle and read-only mounts versus
uDocker for container-visible non-root identity and translated ports.

Record the decision and tested versions in this document before implementation.
Install exactly one engine in the final bootstrap.

## Target architecture

### Fixed machine bootstrap

Replace `machineSoftware` with a package-owned privileged bootstrap that is not
configurable through REST, tools, project data, or environment overlays.

The bootstrap should:

1. Create or repair the persistent `sandbox-user` backing directory beneath
   `/home/sandbox-agent`, the locked account, the `/home/sandbox-user` symlink,
   its shell, and non-sudo group membership. The backing directory must not be
   readable by `sandbox-agent`; only parent traversal needed for the symlink is
   allowed.
2. Create `~/.dbx-tools/bin`, `~/.dbx-tools/containers`,
   `~/.dbx-tools/runtime`, and `~/.dbx-tools/operations` with user ownership.
3. Install or verify one versioned, home-owned engine bundle and required
   executor from a pinned, package-owned source. Do not install system packages
   during normal machine startup.
4. Configure storage, namespaces, and subordinate UID/GID ranges required by
   the selected engine.
5. When an engine uses a root daemon, install its package-owned root-only
   configuration, socket, state directory, and controller. Do not expose them
   to `sandbox-user`.
6. Install a package-owned `containerctl` client into `~/.dbx-tools/bin`.
7. Install the generated `start-all` entrypoint and shared lifecycle shell.
8. Verify the engine with an offline version, socket-permission, and storage
   check.

Do not install mise, Homebrew, pkgx, or a general-purpose package manager for
agents. Install only the selected container engine and its fixed dependencies.

The public runtime must never expose the privileged bootstrap capability.

### `containerctl`

One package-owned wrapper should hide engine-specific requirements from TypeScript
and generated startup scripts. It should provide a small stable command surface:

```text
containerctl prepare <container-id> <definition-json>
containerctl start <container-id>
containerctl stop <container-id>
containerctl status <container-id>
containerctl logs <container-id>
containerctl remove <container-id>
containerctl start-all
```

The wrapper should:

- Enter the selected engine's required namespace and storage configuration or
  call the package-owned privileged controller.
- Never connect directly to a privileged daemon socket from an agent command,
  project shell, or container process.
- Use argument arrays derived from validated JSON, never `eval` or shell command
  strings.
- Keep one directory per container beneath
  `~/.dbx-tools/containers/<container-id>`.
- Store normalized definition JSON, PID, status, bounded log, and readiness
  result in that directory.
- Make `prepare`, `start`, `stop`, `remove`, and `start-all` idempotent.
- Use authoritative engine task state when available. Otherwise stop the
  recorded process and its descendants before engine cleanup and treat stale
  PID files as stopped after checking process identity.
- Never expose or restore Databricks credentials inside the container.

### Built-in services

Terminal, desktop, and stats remain machine-owned host services, not agent
containers and not skills. They require host integration that should not be
hidden inside the project container model.

Replace the three packaged `mise.toml` files with one simple executable script
per service:

```text
src/service-definitions/terminal.sh
src/service-definitions/desktop.sh
src/service-definitions/stats.sh
```

Each script accepts `install`, `start`, `stop`, and `status`. Every action is
idempotent. The existing TypeScript service runner remains responsible for
Lakebase advisory locking, operation logs, state streaming, routes, and owner
authorization. Shell scripts own only the service-specific install and process
commands.

Extract only lifecycle behavior that is genuinely identical across all three
services into one package-owned shell library. Do not duplicate lock, PID,
bounded-log, or readiness loops in each service definition.

## Public container contract

Replace project schemas with container schemas in
`@dbx-tools/shared-databricks-sandbox`. Use Zod for every request, response,
persistence, and client configuration shape.

### Create request

Add `createSshContainerRequestSchema` and the `create_ssh_container` agent tool.
The tool does not return until image preparation, process start, and configured
readiness complete or the container reaches `error`.

The initial schema should expose these fields explicitly:

| Field | Type | Required behavior and description |
| --- | --- | --- |
| `machineId` | string | Existing assigned Sandbox identifier. Starts the machine when automatic startup is enabled. |
| `containerId` | string optional | Stable identifier when replacing an existing definition. Omit only when creating a new container. |
| `name` | string | Unique lowercase machine-local workload name. dbx-tools derives any engine-specific name and prevents direct daemon access. |
| `image` | string | OCI image reference. State which registries and authentication modes are supported. |
| `pullPolicy` | `always`, `missing`, or `never` | Image pull policy implemented by dbx-tools, not Docker. |
| `command` | string optional | Executable inside the image. Omit to use the image command when the selected engine supports it. |
| `args` | string array | Literal argument tokens passed to the executable. No shell parsing. |
| `entrypoint` | string array optional | Explicit image entrypoint override when supported by the selected engine. |
| `env` | string record | Container environment. Reject `PROJECT_NAME`, `PROJECT_PATH`, `PROJECT_PORT`, `DATABRICKS_*`, and `SSH_AUTH_SOCK`. |
| `workingDirectory` | absolute container path optional | Working directory inside the container. It does not select a host directory. |
| `user` | string optional | Non-root container UID, UID:GID, or image user. Defaults to the selected runtime's unprivileged workload identity and rejects UID 0. |
| `mounts` | structured array | Bind mounts with `source`, `target`, `readOnly`, and explicit source creation. Add managed named volumes only if the selected engine passes ownership and cleanup tests. |
| `network` | supported enum | Only live-tested modes such as `host`, `none`, or an isolated bridge. The description states whether port publishing is available. |
| `publishedPorts` | structured array | Explicit host address, host port, container port, and protocol mappings. Available only when the selected engine passes port-publish tests. |
| `hostname` | string optional | Container-visible hostname when the selected engine supports it. |
| `labels` | string record | Persisted metadata passed to the engine when supported. Reserved dbx-tools labels cannot be overridden. |
| `readOnlyRootFilesystem` | boolean | Makes the image root filesystem read-only when supported. Writable paths must use a bind mount, managed volume, or typed tmpfs field. |
| `tmpfs` | structured array | Validated temporary writable mounts with container path and bounded size. Host paths and arbitrary mount options are not accepted. |
| `resources` | structured object optional | Live-tested memory, CPU, and PID limits. Omitted fields use runtime defaults; unsupported cgroup controls fail validation. |
| `stopTimeoutSeconds` | bounded integer | Grace period before the runtime force-stops the container. |
| `route` | boolean | Whether AppKit exposes an HTTP route. Defaults to true. |
| `path` | string optional | Unique AppKit route slug. The resolved owner-prefixed route is injected as `PROJECT_PATH`. |
| `port` | integer optional | Unique high Sandbox port. It is injected as `PROJECT_PORT`; there is no Docker port translation in host-network mode. |
| `openPath` | string optional | Container-relative browser entry path appended to the AppKit route. |
| `stripPrefix` | boolean | Whether AppKit strips the route prefix before forwarding. |
| `serviceDependencies` | service array | Built-in host services that must be ready before the container starts. |
| `readiness` | structured object optional | TCP or HTTP readiness probe with bounded timeout, interval, path, and expected status. Defaults to TCP on `PROJECT_PORT` for routed workloads. |
| `additionalRunArgs` | string array | Literal engine-specific option tokens for validated, non-reserved features. This is not a shell fragment and not a promise of Docker CLI compatibility. |

Do not expose fields that the selected engine cannot pass in the live matrix.
In particular, do not expose `privileged`, devices, host PID selection, arbitrary
namespace modes, Docker sockets, seccomp profile paths, or low ports.

Validate `additionalRunArgs` token by token. Reject any token that can override
runtime-owned image, name, command, environment, mount, network, PID, isolation,
storage, route, or privilege policy. Prefer adding a typed field over expanding
the escape hatch when an option becomes common.

### Injected environment

The runtime always injects:

```text
PROJECT_NAME=<normalized container name>
PROJECT_PATH=<resolved owner-prefixed AppKit route or empty when route=false>
PROJECT_PORT=<reserved machine-local port>
```

The user request must not contain those keys. The schema should fail before any
machine start or remote write rather than accepting an equal duplicate.

### Mount contract

Use a structured `sshContainerMountSchema` instead of Docker `-v` strings.

- `source` is an absolute Sandbox host path or a path beneath the container's
  user-owned data root.
- `target` is an absolute container path such as `/example`.
- `readOnly` defaults to false.
- `createSource` may create a missing directory only beneath approved
  `sandbox-user` roots. It must not create arbitrary root-owned paths.
- The schema description states that host filesystem permissions still apply
  and container UID mapping does not bypass them.
- Symlink resolution must remain within an allowed user-owned root when
  `createSource` or managed cleanup is requested.
- Removal never deletes an externally supplied mount source.

### Network and ports

For the proven Buildah mode:

- Routed containers use host networking.
- The workload listens directly on `127.0.0.1:$PROJECT_PORT` or on the exact
  loopback-compatible address required by the selected engine.
- Container port and Sandbox port are the same.
- Docker-style `publish`, `expose`, `-p`, and `-P` are rejected.
- Ports below 1024 are rejected.

Enable the typed `publishedPorts` array only if uDocker PRoot is selected. The
live probe passed explicit loopback host-to-container TCP translation and did
not expose the original container port. Do not model it as a generic Docker
option and do not allow `additionalRunArgs` to bypass typed validation.

### Responses and tools

Add these agent tools and matching REST/client methods:

- `create_ssh_container`: create or replace a saved definition, start it, wait
  for readiness, and return its state.
- `list_ssh_containers`: return saved definitions with authoritative dbx-tools
  running state, route, image, command summary, mounts, PID status, error, and
  bounded log metadata. Do not forward uDocker `ps` or Buildah container output
  directly.
- `remove_ssh_container`: stop the recorded process tree, remove the engine
  container definition, remove the route and wake route, delete only
  dbx-tools-owned container state, and preserve external mount sources.

Also add explicit `start_ssh_container`, `stop_ssh_container`, and
`get_ssh_container_logs` methods to REST and UI even if the initial agent tool
set remains limited to create, list, and remove. Agents need predictable recovery
without reissuing a complete create request.

Remove the following obsolete tools and routes in the same lockstep change:

- `add_ssh_project`
- `list_ssh_projects`
- `remove_ssh_project`
- `reset_ssh_project`
- `open_ssh_project_terminal`

Do not keep aliases or compatibility schemas.

## Persistence and lifecycle

Replace `SandboxProjectRecordSchema` and the Lakebase `projects` table with a
container-owned record containing:

- Stable container ID, owner, workspace, and machine.
- Normalized name, image, pull policy, command, args, entrypoint, environment,
  mounts, network, published ports, working directory, user, labels, root
  filesystem policy, temporary filesystems, resource limits, stop timeout, and
  validated additional arguments.
- Route, port, readiness, open path, prefix behavior, and service dependencies.
- Definition digest, engine name, engine version, created time, and updated time.

Runtime-only engine task ID, PID, state, log, error, and readiness snapshots
remain remote and in memory. List polling recovers them through `containerctl`
from authoritative engine state and the container state directories.

Container lifecycle:

1. Validate the complete request and all local conflicts.
2. Persist the desired definition so a stopped machine can be woken by its
   route.
3. Start the machine if necessary.
4. Run the fixed bootstrap if its version marker is absent.
5. Start or reconnect to the package-owned runtime controller. When selected,
   start the root daemon before any container operation.
6. Wait for declared built-in service dependencies.
7. Call `containerctl prepare` for a changed definition digest.
8. Call `containerctl start` and wait for readiness.
9. Register the active route.
10. Return `ready`, or persist and return `error` without losing the desired
   definition.

Machine startup starts or reconnects to the selected runtime controller, then
calls `containerctl start-all`. It restores definitions sequentially first;
parallelism may be added only after image-store and port contention tests prove
it safe. One failed container does not stop later containers from starting.

## Cutover

Legacy mise project definitions cannot be translated reliably into image,
command, mount, and runtime fields. Do not create a compatibility interpreter.

The release that introduces containers should:

1. Stop and remove active legacy project routes.
2. Run the existing project cleanup path once for persisted legacy rows so
   recorded PIDs and project-directory processes are terminated.
3. Preserve user files under the former project directories unless the user
   explicitly removes them.
4. Delete legacy project rows after cleanup is recorded.
5. Create the new container table and runtime directories.
6. Remove legacy mise scripts, markers, operation logs, generated tasks, and
   service definitions from the package.

Document the change as intentionally breaking. The monorepo updates in
lockstep, so all REST clients, UI, skills, examples, tests, and generated API
documentation must move to container terminology in the same release.

## Agent instructions

Rewrite the mounted showcase skills around `create_ssh_container`. Built-in
terminal, desktop, and stats controls remain product capabilities and must not
be reintroduced as skills.

Every skill should include one complete request object. The baseline example
should be a Python image whose process reads the injected variables and serves
the project name on the assigned port:

```json
{
  "machineId": "<returned machine id>",
  "name": "hello-container",
  "image": "docker.io/library/python:3.12-alpine",
  "command": "python",
  "args": [
    "-u",
    "-c",
    "import http.server, os; name=os.environ['PROJECT_NAME']; port=int(os.environ['PROJECT_PORT']); H=type('H',(http.server.BaseHTTPRequestHandler,),{'do_GET':lambda s:(s.send_response(200),s.send_header('Content-Type','text/plain; charset=utf-8'),s.end_headers(),s.wfile.write(f'Hello from {name}\\n'.encode())),'log_message':lambda *a:None}); http.server.ThreadingHTTPServer(('127.0.0.1',port),H).serve_forever()"
  ],
  "network": "host",
  "route": true
}
```

The example returns `Hello from hello-container` and requires no generated
files, lifecycle task, or follow-up SSH command.

Instructions must state:

- This is a constrained dbx-tools container API, not access to the full Docker
  CLI or privileged engine socket.
- `list_ssh_containers` reports normalized dbx-tools state rather than promising
  engine-specific `ps` output.
- Containers run detached under the selected engine or dbx-tools supervisor.
  Agents do not set a detached flag.
- A Sandbox stop/start restarts a container from its saved definition; it does
  not resume process memory.
- Bind mounts are supported through structured fields.
- Managed named volumes and port publishing are available only when enabled by
  the selected engine's tested capability matrix.
- Port translation remains unsupported in Buildah host-network mode.
- Container processes never receive Databricks credentials automatically.
- The returned owner-prefixed AppKit URL is the supported browser entrypoint.

## UI

Replace project terminology in `@dbx-tools/ui-databricks-sandbox` with
containers.

- Show image, command summary, mounts, port, route, and lifecycle state.
- Keep machine state `starting` while any saved container is `starting`.
- Show container errors without changing a successfully started Databricks
  machine to `error`.
- Keep loading responses and loading indicators active until the requested
  container is ready or failed.
- Provide start, stop, logs, open, and remove actions from shared metadata
  rather than engine-specific controls.
- Do not render raw `additionalRunArgs` as trusted prose; show them as literal
  argument tokens.

## Implementation phases

### Phase 0: Runtime proof

- Complete the remaining direct-crun and uDocker acceptance cases after the
  failed Docker Engine, containerd, rootless Docker, and Podman probes.
- Select and record one engine and version.
- Resolve the documented lifecycle, read-only mount, network isolation,
  translated-port, and container-visible UID tradeoffs.
- Confirm invalid-command, failed-pull, concurrent-container, and remove-one
  behavior for the selected runtime.
- Convert the proven Ubuntu package closure into a pinned package-owned bundle,
  then verify its checksum, reduced dependency closure if applicable, and
  installation without Homebrew, pkgx, or system package mutation.

### Phase 1: Fixed bootstrap and service scripts

- Replace `machineSoftware` with fixed bootstrap versioning.
- Install the selected engine and `containerctl`.
- Replace built-in service `mise.toml` files with idempotent scripts.
- Preserve advisory locks, bounded logs, state streaming, and readiness.

### Phase 2: Contracts and persistence

- Add container Zod schemas with complete `.describe()` text.
- Add mount, readiness, network, and additional-argument validation.
- Add the Lakebase container table and ownership methods.
- Add local conflict checks for name, route, and port.

### Phase 3: Runtime and routes

- Implement prepare, start, stop, status, logs, remove, and `start-all`.
- Restore containers after every machine start.
- Preserve dormant wake routes and loading responses.
- Recover state after AppKit restarts from remote status and log files.

### Phase 4: Tools, REST, and UI

- Add create, list, remove, start, stop, and logs methods.
- Remove project methods and update all callers in one change.
- Replace project UI with container UI.
- Keep wire routes derived from shared exported route builders.

### Phase 5: Skills, documentation, and cutover

- Rewrite showcase skills with complete container requests.
- Remove mise, Homebrew, pkgx, project lifecycle, and built-in service mise
  documentation.
- Clean legacy rows and routes without deleting user files.
- Regenerate API docs and README-derived documentation.

## Validation

Focused automated coverage must include:

- Reserved environment rejection.
- Name, route, and port conflict rejection before remote commands.
- Mount source and target validation, including read-only behavior and managed
  source boundaries.
- Rejection of shell strings and reserved `additionalRunArgs`.
- Bootstrap and built-in service idempotency.
- Container create waiting through image preparation and readiness.
- Error containers returned as `error` without rejecting machine startup.
- Machine `starting` status until every container settles.
- `start-all` continuing after one failed container.
- Runtime restart state recovery.
- Dormant HTTP wake-up for HTML and JSON clients.
- Active-route connection failure returning loading and restarting the machine.
- Removal preserving external mount sources.
- Legacy project cleanup and row deletion.
- Agent tool descriptions containing the runtime, mount, network, port,
  detached-execution, restart, and checkpoint limitations.

Release validation should run focused package tests, affected UI tests,
TypeScript builds, `bun run docs:link-check`, repository-wide
`bun run slop:review`, and the live FEVM AWS acceptance suite through the
Databricks CLI.

## Acceptance criteria

- No repository-owned mise configuration, installer, task, hook, marker, or
  documentation remains in the Sandbox packages.
- No default or public machine setup field installs Homebrew or pkgx.
- Exactly one container engine is installed by fixed bootstrap. The current
  FEVM selection does not use a root daemon.
- Every host workload process runs as `sandbox-user`. The public contract states
  whether the selected runtime presents that identity as container UID 0 through
  a single user-namespace mapping or as a non-root UID through PRoot emulation.
- A new agent can create a routed Python container from one tool call without
  writing shell lifecycle code.
- `/home/sandbox-user/data` can be mounted at `/example`, written from the
  container, and observed on the host.
- Saved containers restart after a machine stop/start without recreating their
  definitions. Documentation does not claim process-memory resume.
- `list_ssh_containers` distinguishes saved, starting, ready, stopped, and error
  states without relying on uDocker `ps` or Buildah list output as process state.
- Removal stops the process tree, removes engine state and routes, and preserves
  external mount data.
- Built-in terminal, desktop, and stats services remain idempotent and expose
  no service-specific TypeScript lifecycle shell.
- Browser and JSON route requests show loading while a machine or container is
  starting.

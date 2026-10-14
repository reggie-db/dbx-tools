# Replace Databricks Sandbox projects with a single app Lakebox

## Status

In progress.

## Goal

Rename the Databricks-specific Sandbox product surface to Lakebox and replace
the current user-owned machine and mise-project architecture with one lazy,
app-owned Lakebox. Inside that Lakebox, create users and long-running services
on demand from authenticated request identity.

Mastra's framework-owned Sandbox abstractions remain named Sandbox. The
Databricks REST path and upstream response fields also retain their documented
names inside the low-level transport boundary. Product packages, routes,
schemas, tools, UI, logs, and documentation use Lakebox.

## Product contract

- One Databricks Lakebox exists per AppKit application at most.
- The app service principal owns every Databricks Lakebox lifecycle request.
- OBO identity never authenticates a Databricks Lakebox REST or SSH operation.
- An authenticated request lazily converges one locked non-sudo Linux user.
- User homes persist beneath `/home/sandbox-agent` and appear through stable
  `/home/<user>` symlinks recreated after every Lakebox start.
- Long-running workloads are called services, not projects.
- Terminal and desktop are user-scoped services backed by package-owned crun
  definitions when the live FEVM acceptance suite passes.
- User routing is deterministic. One FNV-1a hash implementation derives the
  Linux user suffix, route segment, and service-port namespace.
- No Lakebase machine assignment, owner, route, path, or port mapping remains.
- The only lifecycle duration option is idle timeout. There is no maximum
  lifetime configuration or synthetic expiration timestamp.
- Metrics stream only while the Lakebox is running and includes bounded CPU,
  memory, storage, and network-copy counters. It never includes process names,
  arguments, environment, or process trees.

## Package ownership

### `@dbx-tools/lakebox`

Create `packages/js/node/lakebox` as the low-level owner of:

- Databricks `/api/2.0/lakebox` REST transport and upstream response parsing.
- Managed Lakebox name derivation and app-scoped discovery.
- SSH host-key publication and verification.
- The live Promise-compatible command handle.
- Native OpenSSH ControlMaster and SOCKS5 pools.
- ssh2 command and forwarding pools plus the guarded exec patch.
- Session connection, direct forwarding, shutdown, and process cleanup.

The package has no dependency on AppKit plugin APIs, Mastra, React, or
Lakebase. Preserve the proven separate command and forwarding pools and their
exclusive-resource behavior.

### `@dbx-tools/shared-lakebox`

Create `packages/js/shared/lakebox` as the browser-safe owner of:

- Lakebox lifecycle summaries.
- User summaries.
- Service definitions, state, logs, and route metadata.
- Terminal, desktop, and metrics contracts.
- Plugin client configuration and route builders.
- Agent-tool request and response schemas.

Every wire shape uses documented strict Zod schemas. The provider literal is
`databricks-lakebox`; AppKit's base path defaults to `/api/lakebox`.

### `@dbx-tools/appkit-lakebox`

Create `packages/js/node/appkit-lakebox` as the high-level owner of:

- AppKit plugin registration and request identity resolution.
- FNV-1a user hashing plus deterministic UID and port derivation. The
  low-level `@dbx-tools/lakebox` package only connects, provisions, and
  executes; it contains no user mapping.
- One lazy managed Lakebox runtime per application process.
- App service-principal lifecycle operations.
- Fixed privileged bootstrap and persistent user-home convergence.
- Direct-crun image, bundle, service, log, readiness, and cleanup lifecycle.
- User-scoped terminal and desktop service definitions.
- HTTP and WebSocket route authorization and forwarding.
- Running-only metrics collection and event emission.
- Mastra tools and the `WorkspaceSandbox` adapter.
- Packaged service recipes and read-only skills.

The package must not recreate low-level SSH, pool, or REST logic.

### `@dbx-tools/ui-lakebox`

Create `packages/js/ui/lakebox` as the React owner of:

- Compact Lakebox status and start/stop controls.
- Current-user terminal and desktop launch controls.
- Service state, bounded logs, retry, and error presentation.
- CPU, memory, storage, and copy-throughput metrics components.

The returning-user view leads with current state and available actions. It does
not present machine creation, machine selection, ownership, or project forms.

## Runtime model

### App-scoped Lakebox

Derive one managed name from the application identity already available to the
AppKit server. Discovery lists the service-principal-visible Sandboxes and
selects only the exact managed name. Concurrent first use is serialized in the
application and rechecks after acquiring the lock.

Creation is lazy. Listing plugin state does not create compute unless the
configured auto behavior explicitly requests convergence. Starting a service,
opening a terminal or desktop, or executing a command may create and start the
Lakebox.

Deleting the managed Lakebox is an administrative operation. Normal users may
start and stop it but cannot create parallel machines.

### User identity

Normalize the first available authenticated identity in this order:

1. AppKit user ID.
2. AppKit user email.
3. Explicit development-only test user supplied by the interactive CLI.

Reject non-loopback requests without identity. Local development may use the
configured test identity but never infer an owner from persisted state.

Hash normalized identity with one exported FNV-1a 64-bit implementation. Use
the lower stable hexadecimal segment for:

- Linux username `lakebox-<hash>`.
- Persistent home `~sandbox-agent/.dbx-tools/users/<hash>`.
- Route prefix `/lakebox/<hash>`.
- Deterministic port block.

Port derivation combines the user hash and service identifier inside a fixed
high-port range. Before binding, check the live listener. A collision is an
error with the derived values; do not persist an alternate mapping.

### Fixed bootstrap

Every Lakebox start convergence must:

1. Recreate the package-owned runtime root under the persistent platform home.
2. Restore the direct-crun and image tooling bundle when absent or invalid.
3. Recreate each known locked Linux account and `/home/<user>` symlink.
4. Verify crun, storage configuration, and the runtime policy.
5. Start saved services through one locked, bounded-log convergence command.

No public tool, service definition, environment overlay, or test CLI exposes
sudo, apt, the service principal, Databricks credentials, agent forwarding, or
the default Databricks CLI configuration.

### Services

A service definition contains:

- Stable service ID and user hash.
- Image reference and resolved image metadata.
- Command, arguments, environment, working directory, and mounts.
- Route behavior, service kind, deterministic port, and readiness probe.
- Idle activity metadata, state, bounded log, and latest error.

Remove mise configuration, tool maps, install/start/uninstall shell fields,
project directories, project task enumeration, service dependencies, and
machine software options. Package-owned terminal and desktop definitions are
ordinary internal service definitions built through the same lifecycle owner.

Terminal opens in the user's persistent home. Desktop uses one user-owned
display stack and never exposes display discovery or mutation to callers.

### Metrics emitter

Use an in-process typed event emitter owned by `appkit-lakebox`:

- Start polling after the Lakebox reaches running.
- Stop and clear timers before session and route shutdown.
- Emit a current snapshot and a bounded recent series.
- Collect total and used memory, CPU load, persistent-home storage, and bytes
  copied through dbx-tools forwarding when available.
- Exclude process lists, commands, environment, open files, and per-process
  resource usage.
- Publish snapshots through REST and an SSE route derived from shared route
  builders.

### Idle timeout

Keep one `idleTimeoutSeconds` option. Activity includes authenticated command
execution, terminal or desktop connections, forwarded HTTP/WebSocket traffic,
and service lifecycle operations. The reaper stops the Lakebox after the idle
window when no active forwarded stream or command exists.

Remove maximum lifetime, `expiresAt`, assignment TTL, and owner-lease logic.

## Migration stages

### Stage 1: package and vocabulary split

- [x] Add Projen projects for `lakebox`, `shared-lakebox`,
  `appkit-lakebox`, and `ui-lakebox`.
- [x] Move low-level transport files into `lakebox` without behavior changes.
- [x] Move browser schemas and UI to Lakebox package names.
- [x] Update the example app and every in-repo consumer.
- [x] Remove old package directories and compatibility exports.
- [x] Synthesize twice and verify the second run is clean.

### Stage 2: single app runtime

- [x] Replace machine assignments with a persistent generated-ID registry and
  one-time adoption of the deterministic legacy name.
- [x] Remove OBO workspace-client attempts and fallback policy.
- [x] Serialize lazy create/start and enforce one exact managed Lakebox.
- [x] Replace machine lists and selectors with one optional Lakebox summary.
- [x] Remove Lakebase ownership tables and migrations. AppKit's persistent
  cache stores only the generated Lakebox ID and last-known service definitions;
  the service-principal pool supplies the cross-replica advisory lock. Plugin
  startup deletes legacy per-user `dbx-<adjective>-<animal>-<nonce>` Lakeboxes
  that are not the managed app Lakebox and drops the legacy
  `dbx_tools_databricks_sandbox*` schemas.

### Stage 3: deterministic users and routes

- [x] Add shared FNV-1a identity hashing and port derivation.
- [x] Add package-owned persistent user-home bootstrap.
- [x] Route every authenticated request through its derived user namespace.
- [x] Remove persisted owner, path, and port mappings.
- [x] Preserve fail-closed HTTP and WebSocket authorization.

### Stage 4: crun services

- [x] Replace projects and mise lifecycle with persisted service definitions.
- [x] Add idempotent create/start/stop/remove and bounded logs.
- [x] Restore saved services after Lakebox start without failing the Lakebox
  when one service enters error.
- [x] Implement user terminal and desktop through internal crun services.
- [x] Update skills to create services and remove project/task instructions.

### Stage 5: metrics and UI

- [x] Add running-only metrics emitter, REST snapshot, and SSE stream.
- [x] Add compact status, service, terminal, desktop, and metrics components.
- [x] Cover loading, empty, running, stopped, and service-error states.
- [ ] Verify keyboard, narrow viewport, and WebSocket behavior.

### Stage 6: interactive validation

- [x] Add `test/cli.ts` with an explicit `--user` identity.
- [x] Support list, ensure, start, stop, exec, service, terminal, desktop,
  metrics, and cleanup commands without credential injection.
- [x] Resolve and pass the explicit `FEVM-REGGIE-PIERCE-AWS` profile for live
  validation.
- [x] Validate two arbitrary users concurrently in one Lakebox.
- [ ] Validate stop/start persistence, deterministic routes and ports, terminal,
  desktop, crun service recovery, idle stop, and metrics redaction.
- [x] Delete disposable Lakeboxes created by tests.

## Progress

### October 13, 2026: FEVM AWS runtime probe

Probe Lakebox `saucy-turbot-6927` (Ubuntu 24.04, kernel 6.18, cgroup v2,
4 vCPU, 8 GB) established the runtime contract below. Each item replaces an
open assumption from the earlier plan.

- The Lakebox REST surface is `/api/2.0/lakebox/sandboxes`. `PATCH
  /api/2.0/lakebox/sandboxes/<id>` with `idle_timeout` (for example `3600s`)
  configures the platform idle watchdog. The platform default is ten minutes
  and the accepted range is one minute to 24 hours. The single
  `idleTimeoutSeconds` option configures this native watchdog; dbx-tools does
  not run its own idle reaper.
- `/home/sandbox-agent` is an idmapped persistent ext4 mount that stores only
  UIDs 0 through 65535. Lakebox user UIDs are derived from the user hash into
  20000 through 59999. Persistent homes live beneath
  `/home/sandbox-agent/.dbx-tools/users/<hash>` and `/home/lakebox-<hash>` is
  a symlink recreated at bootstrap.
- `apt-get download` plus `dpkg-deb -x` of `buildah`, `crun`, and `uidmap`
  with `--no-install-recommends` produced a 33.8 MB bundle of seven packages in
  nine seconds without installing system packages.
- Rootless Buildah pulled `python:3.12-alpine` into per-user `vfs` storage in
  two seconds.
- Direct crun inside `unshare -Ur -m` runs with private PID, IPC, and mount
  namespaces when `/proc` and `/sys` are bind mounts. Killing the container
  init terminated its background children. `devpts` must omit `gid=5`, and
  container stdin must be `/dev/null` so the SSH session can exit.
- A nested crun user namespace mapping the user's UID to the outer namespace
  root makes processes run as the real Lakebox user (`id` and `whoami` match,
  created files keep the user's UID).
- Host-environment containers work from an empty rootfs with read-only binds
  of `/usr`, `/etc`, `/opt`, `/var`, and the shared runtime directory, a
  writable user home, a private `/tmp` tmpfs, and merged-`/usr` symlinks. A
  direct `/` root or `/` bind fails `pivot_root`. The UTS namespace and
  `hostname` must be removed so host name resolution keeps working.
- ttyd 1.7.7 and KasmVNC 1.5.0 with XFCE both run as user-scoped
  host-environment crun services on derived loopback ports. The X socket stays
  inside the container's private `/tmp`. Desktop prerequisites install in 44
  seconds after a Lakebox start because system packages reset.
- Root has `CAP_NET_ADMIN` but the legacy iptables owner match and nftables
  `reject` are unavailable. An nftables `inet lakebox` table using
  `meta skuid . tcp dport` set membership with `drop` restricts each derived
  service port to its owner UID, root, and `sandbox-agent` (SSH forwarding).
- Platform listeners occupy ports below 20000 and the kernel ephemeral range
  starts at 32768, so derived service ports use 20000 through 31999.

These results make terminal, desktop, and agent-defined services ordinary
crun services. Image services use Buildah-prepared root filesystems.
Terminal and desktop use the host-environment rootfs.

### October 13, 2026: end-to-end acceptance through `test/cli.ts`

Run against `dbx-lakebox-lakebox-cli` (`passionate-planthopper-5729`) with the
explicit `FEVM-REGGIE-PIERCE-AWS` profile:

- The first command lazily created, started, and bootstrapped the Lakebox and
  converged the user's account in 16 seconds.
- An image service pulled `python:3.12-alpine`, wrote through a home bind
  mount, and became ready in seven seconds.
- A second user received a separate account, could not list or read the first
  user's home, could not reach the first user's service port (nftables), and
  had no sudo.
- Through the deterministic route proxy, the terminal, the image service, the
  branded desktop page, and the desktop websockify upgrade all succeeded; a
  route for another user's hash returned 404. A routed ttyd WebSocket session
  ran as the owning account. Under Bun, `node:http` upgrade sockets do not carry
  proxied WebSocket traffic, so `serve` runs under Node like AppKit.
- After stop and start, both accounts returned with the same UIDs and
  symlinks, home files persisted, and the saved image service restored itself.
- With a 60-second idle timeout, the platform stopped the Lakebox about ten
  minutes after the last SSH session closed, so the watchdog acts on a coarser
  cadence than the configured value. A four-minute run with an idle session
  open was too short to show whether open sessions count as activity. The
  runtime releases its session after the idle window when nothing is active,
  so a held session cannot keep the Lakebox awake.

## Validation gates

Run focused package tests first, then:

1. `bunx projen` twice with no second-run diff.
2. Tests for `@dbx-tools/lakebox`.
3. Tests for `@dbx-tools/shared-lakebox`.
4. Tests for `@dbx-tools/appkit-lakebox`.
5. Tests for `@dbx-tools/ui-lakebox`.
6. Example server and app type checks/builds.
7. `bun run version:check`.
8. `bun run docs:link-check` after README or API-link changes.
9. `bun run slop:review` for the completed repository-wide change.
10. Live FEVM AWS acceptance through the explicit profile.

## Archive policy

The earlier container-first plan is archived as superseded because its live
runtime findings remain valid, while its one-project model and naming no longer
match this architecture. Keep those findings as implementation evidence; track
all remaining work only in this document.

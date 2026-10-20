# @dbx-tools/appkit-lakebox

Give each authenticated Databricks App user a persistent Linux home, terminal,
desktop, OCI image services, agent tools, and machine metrics in one shared
Databricks Lakebox.

## Register the plugin

```ts
import { createApp, lakebase, server } from "@databricks/appkit";
import { lakebox, LakeboxRuntime } from "@dbx-tools/appkit-lakebox";
import { resolveLakeboxPluginConfig } from "@dbx-tools/appkit-lakebox/config";

const runtime = new LakeboxRuntime(resolveLakeboxPluginConfig({ idleTimeoutSeconds: 1_800 }));

await createApp({
  plugins: [server(), lakebase(), lakebox({ runtime })],
});
```

Lakebase persists the Databricks-assigned Lakebox ID, serializes first creation
across app replicas, and retains the last observed service definitions while
the machine is stopped. Register AppKit's `lakebase()` plugin before users
access Lakebox routes.

## Connect Mastra to the same runtime

Pass the same `LakeboxRuntime` to the AppKit plugin and Mastra sandbox. This
keeps commands, services, routes, metrics, and user accounts on the same
Lakebox:

```ts
import { createApp, lakebase, server } from "@databricks/appkit";
import { lakebox, LakeboxRuntime } from "@dbx-tools/appkit-lakebox";
import { resolveLakeboxPluginConfig } from "@dbx-tools/appkit-lakebox/config";
import { lakeboxSkillMounts } from "@dbx-tools/appkit-lakebox/skills";
import { lakeboxWorkspaceSandbox } from "@dbx-tools/appkit-lakebox/workspace";
import { agents, mastra } from "@dbx-tools/appkit-mastra";

const runtime = new LakeboxRuntime(resolveLakeboxPluginConfig());
const analyst = agents.createAgent({
  name: "Analyst",
  instructions: "Use the workspace when the task requires files or commands.",
});

await createApp({
  plugins: [
    server(),
    lakebase(),
    lakebox({ runtime }),
    mastra({
      agents: { analyst },
      sandbox: lakeboxWorkspaceSandbox(runtime),
      localSkillMounts: lakeboxSkillMounts(),
    }),
  ],
});
```

The sandbox resolves the authenticated Mastra user for each request. It doesn't
create compute during agent registration. The first command or service starts
the Lakebox when `auto` is enabled.

## Render the Lakebox UI

Register the backend plugin, then render the React package in the same
application:

```tsx
import { LakeboxIndicator, LakeboxPanel } from "@dbx-tools/ui-lakebox/react";

export function LakeboxPage() {
  return (
    <>
      <LakeboxIndicator />
      <LakeboxPanel />
    </>
  );
}
```

Import the package stylesheet after your AppKit UI theme:

```css
@import "@dbx-tools/ui-lakebox/styles.css";
```

The components read the API base path from the plugin's published client
configuration. You don't need to copy route strings or pass Databricks
credentials to the browser.

## Create a service

Agents call `create_lakebox_service`. REST clients send
`POST /api/lakebox/services`:

```json
{
  "name": "hello",
  "image": "docker.io/library/python:3.12-alpine",
  "command": ["sh", "-lc", "python -m http.server \"$SERVICE_PORT\" --bind 127.0.0.1"],
  "mounts": [{ "source": "data", "target": "/data" }]
}
```

The call returns after the service listens. The runtime injects
`SERVICE_NAME`, `SERVICE_PATH`, `SERVICE_PORT`, and `PORT`. Routed services
must listen on `127.0.0.1:$SERVICE_PORT`. Mount sources are relative to the
user's home.

This is a constrained container API, not the Docker CLI. There is no daemon,
port publishing, privileged mode, device access, or bridge network. A Lakebox
stop and start restarts services from their saved definitions. Process memory
does not resume.

## Use the agent tools

| Tool                                            | Effect                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `get_lakebox`                                   | Returns status, the current user's account, and services without creating the Lakebox. |
| `execute_lakebox_command`                       | Run a command as the user's account.                                                   |
| `list_lakebox_services`                         | List the user's services.                                                              |
| `create_lakebox_service`                        | Create or replace an image service and wait until ready.                               |
| `start_lakebox_service`, `stop_lakebox_service` | Start or stop a saved service, `terminal`, or `desktop`.                               |
| `remove_lakebox_service`                        | Delete a saved service. Requires approval.                                             |
| `get_lakebox_service_logs`                      | Read a bounded service log.                                                            |

The plugin creates or starts the Lakebox for commands and service mutations
when `auto` is enabled. Listing and status operations don't create it.

## Understand the lifecycle

The app service principal owns Lakebox lifecycle calls. An on-behalf-of user
identity selects that user's Linux account and authorizes routes, but it never
creates, starts, stops, or deletes the Databricks resource.

Lifecycle behavior is:

1. The first explicit start, command, service mutation, or routed request
   creates the app's Lakebox when none exists.
2. The runtime starts the Lakebox and restores saved service definitions.
3. Each authenticated identity maps to a locked non-sudo account with a
   persistent home and private service ports.
4. The Databricks platform stops the Lakebox after the configured idle period.
5. A later request starts it again. User files and saved service definitions
   persist, but process memory doesn't.

`runtime.stop()` stops the shared Lakebox for every user. `runtime.delete()`
permanently deletes the Lakebox and every user's files. Normal AppKit shutdown
closes SSH sessions and forwarding bridges but leaves idle shutdown to the
platform.

## Configuration

| Option                   | Default                                                                          | Description                                                                         |
| ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `application`            | `DBX_TOOLS_LAKEBOX_APPLICATION`, `DATABRICKS_APP_NAME`, or the project directory | Stable key for the persisted Lakebox resource ID.                                   |
| `idleTimeoutSeconds`     | `3600`                                                                           | Platform idle timeout, 60 to 86400 seconds.                                         |
| `auto`                   | `true`                                                                           | Create or start the Lakebox on demand.                                              |
| `routePrefix`            | `/lakebox`                                                                       | AppKit root for service routes.                                                     |
| `metricsIntervalSeconds` | `5`                                                                              | Sample interval while a client watches metrics.                                     |
| `sshTransport`           | `auto`                                                                           | `auto`, `openssh`, or `ssh2`.                                                       |
| `ssh2Patch`              | `auto`                                                                           | Apply the ssh2 missing-exec-reply workaround only in development, always, or never. |
| `gatewayPort`            | `2222`                                                                           | Lakebox SSH gateway port.                                                           |
| `connectTimeoutMs`       | `30000`                                                                          | SSH connection timeout.                                                             |
| `destroyAfterStartupFailureSeconds` | `false`                                                              | Opt in to deleting and recreating an unreachable Lakebox after 5 to 600 seconds.    |
| `commandTimeoutMs`       | `120000`                                                                         | Default command timeout.                                                            |
| `keyDirectory`           | `~/.dbx-tools/lakebox`                                                           | Optional server-side SSH key and known-host storage root.                           |

## Interactive testing

`test/cli.ts` runs the real runtime against a workspace profile as any user:

```bash
bun packages/js/node/appkit-lakebox/test/cli.ts --profile <profile> --user a@example.com status
bun packages/js/node/appkit-lakebox/test/cli.ts --profile <profile> --user b@example.com exec id
bunx tsx packages/js/node/appkit-lakebox/test/cli.ts --profile <profile> --user a@example.com serve
```

`serve` starts that user's terminal and desktop and proxies their routes on
[http://127.0.0.1:8787](http://127.0.0.1:8787).

Pass a configured profile explicitly. In this harness, the profile identity
stands in for the app service principal.

## Understand security and runtime limits

- Each app has at most one managed Lakebox. Users share the machine but not
  Linux accounts, homes, or service ports.
- Commands and services don't receive Databricks environment variables,
  forwarded credentials, cookies, or SSH agent access.
- Service routes fail closed when a non-loopback request has no authenticated
  identity.
- Image services run with private PID, IPC, mount, and user namespaces. They
  share host networking and must bind only to the injected loopback port.
- Metrics cover machine CPU, memory, persistent storage, and network counters.
  They don't expose process data and are sampled only while a client watches.
- Lakebase is required for app resource identity, replica convergence, and
  last-known service definitions.

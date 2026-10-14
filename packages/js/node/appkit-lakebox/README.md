# @dbx-tools/appkit-lakebox

Give every user of a Databricks App a terminal, a desktop, and long-running
services in one shared, lazily created Databricks Lakebox.

- One Lakebox per app, created on first use by the app service principal and
  stopped by the platform after its idle timeout. Databricks assigns the
  machine name; users see only the Lakebox product label.
- Each signed-in user gets a locked, non-sudo Linux account with a persistent
  home. Other users cannot read the home or reach the user's service ports.
- Services run OCI images detached with direct crun. Terminal and desktop are
  built-in services. Saved services restart when the Lakebox starts.
- Every service is reachable at `/lakebox/<user hash>/<service>` behind the
  app's authentication.
- Agent tools, a Mastra workspace sandbox, and live machine metrics.

## Register the plugin

```ts
import { createApp, lakebase, server } from "@databricks/appkit";
import { lakebox } from "@dbx-tools/appkit-lakebox";

await createApp({ plugins: [server(), lakebase(), lakebox({ idleTimeoutSeconds: 1_800 })] });
```

Lakebase persists the Databricks-assigned Lakebox ID, serializes first creation
across app replicas, and retains last-known service definitions while the
machine is stopped. The registry adopts an existing
`dbx-lakebox-<application>` machine once, but new machines use the name
Databricks assigns. Startup also deletes legacy per-user
`dbx-<adjective>-<animal>-<nonce>` Lakeboxes and drops legacy Sandbox ownership
schemas; no user data is migrated between machines.

To share the runtime with Mastra, create it once:

```ts
import { lakebox, LakeboxRuntime } from "@dbx-tools/appkit-lakebox";
import { resolveLakeboxPluginConfig } from "@dbx-tools/appkit-lakebox/config";
import { lakeboxSkillMounts } from "@dbx-tools/appkit-lakebox/skills";
import { lakeboxWorkspaceSandbox } from "@dbx-tools/appkit-lakebox/workspace";

const runtime = new LakeboxRuntime(resolveLakeboxPluginConfig());

lakebox({ runtime });
mastra({ sandbox: lakeboxWorkspaceSandbox(runtime), localSkillMounts: lakeboxSkillMounts() });
```

## Create a service

Agents call `create_lakebox_service`; REST clients `POST /api/lakebox/services`:

```json
{
  "name": "hello",
  "image": "docker.io/library/python:3.12-alpine",
  "command": ["python", "-m", "http.server", "--bind", "127.0.0.1"],
  "mounts": [{ "source": "data", "target": "/data" }]
}
```

The call returns after the service listens. The runtime injects
`SERVICE_NAME`, `SERVICE_PATH`, `SERVICE_PORT`, and `PORT`; routed services must
listen on `127.0.0.1:$SERVICE_PORT`. Mount sources are relative to the user's
home.

This is a constrained container API, not the Docker CLI. There is no daemon,
port publishing, privileged mode, device access, or bridge network. A Lakebox
stop and start restarts services from their saved definitions; process memory
does not resume.

## Agent tools

| Tool | Effect |
| --- | --- |
| `get_lakebox` | Status, the current user's account, and services. Never creates the Lakebox. |
| `execute_lakebox_command` | Run a command as the user's account. |
| `list_lakebox_services` | List the user's services. |
| `create_lakebox_service` | Create or replace an image service and wait until ready. |
| `start_lakebox_service`, `stop_lakebox_service` | Start a saved service, `terminal`, or `desktop`; stop one. |
| `remove_lakebox_service` | Delete a saved service. Requires approval. |
| `get_lakebox_service_logs` | Read a bounded service log. |

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `application` | `DBX_TOOLS_LAKEBOX_APPLICATION`, `DATABRICKS_APP_NAME`, or the project directory | Stable key for the persisted Lakebox resource ID. |
| `idleTimeoutSeconds` | `3600` | Platform idle timeout, 60 to 86400 seconds. |
| `auto` | `true` | Create or start the Lakebox on demand. |
| `routePrefix` | `/lakebox` | AppKit root for service routes. |
| `metricsIntervalSeconds` | `5` | Sample interval while a client watches metrics. |
| `sshTransport` | `auto` | `auto`, `openssh`, or `ssh2`. |

## Interactive testing

`test/cli.ts` runs the real runtime against a workspace profile as any user:

```sh
bun packages/js/node/appkit-lakebox/test/cli.ts --profile <profile> --user a@example.com status
bun packages/js/node/appkit-lakebox/test/cli.ts --profile <profile> --user b@example.com exec id
bun packages/js/node/appkit-lakebox/test/cli.ts --profile <profile> --user a@example.com serve
```

`serve` starts that user's terminal and desktop and proxies their routes on
`http://127.0.0.1:8787`.

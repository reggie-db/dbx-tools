# Use the dbx CLI and local services

Use the `dbx` CLI for Databricks authentication, Lakebase proxying, Genie Code,
model gateways, Graphiti, gated tunnels, AppKit environment export, and
current-user services.

## Install the CLI

```bash
bun add --global @dbx-tools/cli
```

`dbx-tools` is an alias for `dbx`.

## Resolve a Databricks profile

Check the profile selected from project configuration:

```bash
dbx auth profile
```

Log in when the profile has no usable credentials:

```bash
dbx auth login --profile <profile>
dbx auth status --profile <profile>
```

Pass `--profile <profile>` to commands that access a workspace. The CLI can
resolve a project-configured profile automatically, but an explicit profile
keeps operational scripts deterministic.

## Connect PostgreSQL tools to Lakebase

Start a loopback PostgreSQL proxy:

```bash
dbx lakebase-proxy \
  --profile <profile> \
  --listen tcp://127.0.0.1:5432
```

Connect the local PostgreSQL client to the printed connection URL.

## Run Genie Code

Start Genie Code with dbx-tools authentication and model discovery:

```bash
dbx genie --profile <profile>
```

Select a model by capability or name:

```bash
dbx genie --profile <profile> --model-class chat-fast
dbx genie --profile <profile> --model claude
```

Unknown arguments and prompts pass through to Genie Code.

## Serve workspace models locally

```bash
dbx model-gateway \
  --profile <profile> \
  --listen tcp://127.0.0.1:4000
```

Point compatible clients at
[http://127.0.0.1:4000/v1](http://127.0.0.1:4000/v1).

## Share a local command

Run a command behind a Portr tunnel and passwordless access gate:

```bash
dbx tunnel --allow example.com -- bun src/server.ts
```

Use this command for processes that are not AppKit applications. AppKit
applications register the tunnel interceptor and auth-gate plugin in process.

## Install a current-user service

Commands that expose a `service` group can compile and install themselves under
`~/.dbx-tools`:

```bash
dbx model-gateway service install --profile <profile>
dbx model-gateway service status
dbx model-gateway service restart
dbx model-gateway service uninstall
```

Service installation stores the selected command options and uses the
package-local Bun compiler. Python-backed services use a service-owned `uv`
environment.

## Export AppKit configuration

Load resolved AppKit environment values into another process:

```bash
eval "$(dbx appkit env --quiet)"
```

Use JSON or Windows output modes when shell assignments are not appropriate.

## <a id="additional-resources"></a> Additional resources

- [@dbx-tools/cli](../packages/js/cli/dbx-tools/README.md)
- [@dbx-tools/cli-service](../packages/js/cli/service/README.md)
- [@dbx-tools/auth](../packages/js/node/auth/README.md)
- [@dbx-tools/lakebase](../packages/js/node/lakebase/README.md)
- [@dbx-tools/tunnel](../packages/js/node/tunnel/README.md)

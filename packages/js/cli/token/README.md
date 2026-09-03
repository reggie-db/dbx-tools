# `@dbx-tools/cli-token`

Local provider token broker mounted as `dbx token`.

It keeps refresh credentials inside their provider CLI, stores short-lived
access tokens only in broker memory, and gives local or containerized clients a
scope-constrained access-token endpoint. Google support delegates to Application
Default Credentials through `gcloud`; callers do not provide an OAuth client ID
or client secret.

Key features:

- scope-keyed in-memory access-token cache with proactive refresh;
- process-wide check-lock-check refresh, so concurrent callers mint once;
- Google ADC through `gcloud auth application-default print-access-token`;
- shared-password or signed-JWT client authentication;
- Docker and Podman host-gateway discovery through `--bind-docker`;
- native per-user launchd, systemd, and Windows Task Scheduler installation;
- no refresh tokens, access tokens, passwords, or signing keys in logs.

This package ships no bin. Install `@dbx-tools/cli` and use its single `dbx`
command.

## Start a foreground broker

```sh
dbx token serve --auth jwt --secret "$TOKEN_BROKER_SECRET"
```

The JWT default listens on `http://127.0.0.1:5556`. The broker accepts explicit
local-interface binds, discovers Docker and Podman gateways by default, and
rejects wildcard binds. Pass `--no-bind-docker` to keep only the configured
addresses. Pass `--auth password` to use the configured secret as a shared
password instead.
Foreground `serve` requires `--secret`; it does not read or write the common
service secret store.
When `--provider` is omitted, every provider in `TOKEN_PROVIDERS` is enabled;
that list currently contains only `google`.

Configure Google ADC once with every scope the broker may later request:

```sh
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/gmail.modify
```

Then pass default and allowed scopes:

```sh
dbx token serve \
  --provider google \
  --scope https://www.googleapis.com/auth/gmail.modify \
  --allowed-scope https://www.googleapis.com/auth/gmail.modify \
  --auth jwt \
  --secret "$TOKEN_BROKER_SECRET"
```

Clients may omit scopes. The default empty scope set calls
`gcloud auth application-default print-access-token` without `--scopes`, using
the ADC grant as configured. Explicit scopes are canonicalized, cached
separately, and rejected unless they are within both the server policy and the
client JWT grant. `--scopes` accepts a comma- or whitespace-separated list;
`--scope` remains repeatable.

## Install the user service

```sh
dbx token service install
dbx token service status
dbx token service stop
dbx token service start
dbx token service remove
```

Installation is idempotent and uses a LaunchAgent on macOS, a systemd user unit
on Linux, or Task Scheduler on Windows. JWT service installation creates a
secret when none exists. Passing `--secret` synchronizes a different value into
the same operating-system keychain or protected state file. The secret is
omitted from the rendered service command. Password service installation
requires an explicit secret. The running service holds a fail-fast file lock for
its complete lifetime, so a duplicate process exits instead of waiting.
Removal keeps the secret; pass `--purge` to remove broker state.

Service installation resolves the current `gcloud` executable with `Bun.which`
and records its absolute path in the native service command. A Node-hosted CLI
uses the operating system's executable lookup as a fallback. This keeps service
startup independent of the restricted PATH available at boot. Pass
`--gcloud <path>` to select another installed executable.

## Create a client identity

```sh
CLIENT_AUTH="$(dbx token client-jwt container-client \
  --provider google \
  --scope https://www.googleapis.com/auth/gmail.modify)"
```

`client-jwt` signs a provider- and scope-constrained client token. Pass
`--secret` for a foreground broker. When omitted, the command reads the
installed service secret without modifying it. The client name is optional,
defaults to `local-cli`, and is included in both the JWT subject and signed
protected header:

```sh
CLIENT_AUTH="$(dbx token client-jwt container-client \
  --secret "$TOKEN_BROKER_SECRET")"
```

## Request an access token

Same-machine clients use the installed service secret, port, providers, and JWT
defaults automatically:

```sh
dbx token access-token
```

Start the server:

```sh
SECRET=supersecret
dbx token serve --secret "$SECRET"
```

In another terminal:

```sh
SECRET=supersecret
CLIENT_JWT="$(dbx token client-jwt --secret "$SECRET")"
dbx token access-token --auth "$CLIENT_JWT"
```

Pass either the shared password or signed JWT through the same `--auth` option:

```sh
dbx token access-token \
  --provider google \
  --auth "$CLIENT_AUTH" \
  --scope https://www.googleapis.com/auth/gmail.modify
```

The client parses structurally valid compact JWTs as bearer tokens. Every other
value, including a dotted value that is not a valid JWT, is sent as the shared
password.

Only the Google access token is written to stdout.

The underlying API is:

```http
POST /v1/access-token
Authorization: Bearer <client-jwt>
Content-Type: application/json

{"provider":"google","scopes":["https://www.googleapis.com/auth/gmail.modify"]}
```

## Docker and Podman

Docker and Podman discovery is enabled by default. It adds bridge gateway
addresses only when they are real host interfaces and always retains
`127.0.0.1` for Docker Desktop or Podman machine forwarding. Use
`--bind-docker docker` or `--bind-docker podman` to inspect one engine, or
`--no-bind-docker` to disable discovery.

Pass the generated client JWT into the container:

```sh
docker run --rm \
  --add-host host.docker.internal:host-gateway \
  -e TOKEN_BROKER_URL=http://host.docker.internal:5556 \
  -e TOKEN_BROKER_CLIENT_AUTH="$CLIENT_AUTH" \
  your-image
```

Podman clients use `host.containers.internal`. Rootless network modes vary; if
the engine cannot forward host loopback, `--bind-docker podman` binds a detected
local gateway. Use an explicit `--bind` for a custom network. The broker never
silently binds `0.0.0.0`.

## Configuration

CLI options override environment values. Environment lookup uses the shared
config policy: `DBX_TOOLS_TOKEN_BROKER_*`, then `TOKEN_BROKER_*`, then a bare
compatibility name.

Primary variables:

- `TOKEN_BROKER_PROVIDER`;
- `TOKEN_BROKER_BIND`;
- `TOKEN_BROKER_BIND_DOCKER`;
- `TOKEN_BROKER_PORT`;
- `TOKEN_BROKER_SERVER_URL`;
- `TOKEN_BROKER_SCOPES`;
- `TOKEN_BROKER_ALLOWED_SCOPES`;
- `TOKEN_BROKER_AUTH`;
- `TOKEN_BROKER_SECRET`;
- `TOKEN_BROKER_GCLOUD`;
- `TOKEN_BROKER_STATE_DIR`;
- `TOKEN_BROKER_ALLOWED_HOSTS`;
- `TOKEN_BROKER_REFRESH_SKEW_SECONDS`;
- `TOKEN_BROKER_ACCESS_TOKEN_TTL_SECONDS`;
- `TOKEN_BROKER_CLIENT_JWT_TTL_SECONDS`;
- `TOKEN_BROKER_SERVICE_NAME`;
- `TOKEN_BROKER_CLIENT`;
- `TOKEN_BROKER_CLIENT_AUTH`.

Service-mode JWT signing secrets and passwords prefer the operating system
keychain. If it is unavailable, the broker warns and falls back to mode-`0600`
files in its state directory. Foreground mode never uses this store.

## Public modules

- `cli` - Commander program and `runCli`;
- `config` / `defaults` - typed configuration and stable defaults;
- `broker` / `provider` / `google` - refresh coordination and provider adapter;
- `server` / `client` - broker protocol;
- `auth` / `secrets` - client authorization and service-mode credentials;
- `network` - Docker and Podman bind discovery;
- `service` - native user-service lifecycle.

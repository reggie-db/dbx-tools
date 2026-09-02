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
- mTLS by default for password and JWT modes, with explicit no-auth HTTP mode;
- Docker and Podman host-gateway discovery through `--bind-docker`;
- native per-user launchd, systemd, and Windows Task Scheduler installation;
- no refresh tokens, access tokens, passwords, signing keys, or private keys in
  logs.

This package ships no bin. Install `@dbx-tools/cli` and use its single `dbx`
command.

## Start a foreground broker

```sh
dbx token serve --google --auth jwt
```

The no-auth default listens on `http://127.0.0.1:4010` and does not create or
load TLS material. Selecting `password` or `jwt` auth defaults to mTLS and
creates a private CA and server certificate under the platform application-data
directory. The CA is not added to the system trust store.

`--tls none` switches to plain HTTP and does not generate or load any TLS
certificate or key. There is no server-only HTTPS mode.

Configure Google ADC once with every scope the broker may later request:

```sh
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/gmail.modify
```

Then pass default and allowed scopes:

```sh
dbx token serve \
  --google \
  --scope https://www.googleapis.com/auth/gmail.modify \
  --allowed-scope https://www.googleapis.com/auth/gmail.modify \
  --auth jwt
```

Clients may omit scopes. The default empty scope set calls
`gcloud auth application-default print-access-token` without `--scopes`, using
the ADC grant as configured. Explicit scopes are canonicalized, cached
separately, and rejected unless they are within both the server policy and the
client JWT grant. `--scopes` accepts a comma- or whitespace-separated list;
`--scope` remains repeatable.

## Install the user service

```sh
dbx token service install --google --auth jwt --bind-docker
dbx token service status
dbx token service stop
dbx token service start
dbx token service remove
```

Installation is idempotent and uses a LaunchAgent on macOS, a systemd user unit
on Linux, or Task Scheduler on Windows. Installed services require `password` or
`jwt` application authentication in addition to the default mTLS transport.
Removal keeps certificates and secrets; pass `--purge` to remove broker state.

## Create a client identity

```sh
dbx token client-token container-client \
  --google \
  --scope https://www.googleapis.com/auth/gmail.modify \
  --output ./token-client
```

The JWT is the command's only stdout value. Diagnostics and mTLS file locations
go to stderr. The output directory contains:

- `ca.crt`;
- `client.crt`;
- `client.key`.

When JWT and mTLS are both enabled, the JWT subject must match the certificate
common name.

## Request an access token

```sh
dbx token access-token \
  --google \
  --auth jwt \
  --client container-client \
  --client-token "$TOKEN_BROKER_CLIENT_TOKEN" \
  --ca ./token-client/ca.crt \
  --cert ./token-client/client.crt \
  --key ./token-client/client.key \
  --scope https://www.googleapis.com/auth/gmail.modify
```

Only the Google access token is written to stdout.

The underlying API is:

```http
POST /v1/access-token
Authorization: Bearer <client-jwt>
Content-Type: application/json

{"provider":"google","scopes":["https://www.googleapis.com/auth/gmail.modify"]}
```

## Docker and Podman

`--bind-docker` inspects both engines by default. It adds Docker or Podman bridge
gateway addresses only when they are real host interfaces and always retains
loopback for Docker Desktop or Podman machine forwarding. Use
`--bind-docker docker` or `--bind-docker podman` to inspect one engine.

Mount the client bundle read-only and pass the JWT separately:

```sh
docker run --rm \
  --add-host host.docker.internal:host-gateway \
  -v "$PWD/token-client:/run/dbx-token:ro" \
  -e TOKEN_BROKER_URL=https://host.docker.internal:4010 \
  -e TOKEN_BROKER_CLIENT_TOKEN \
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
- `TOKEN_BROKER_PASSWORD`;
- `TOKEN_BROKER_SIGNING_SECRET`;
- `TOKEN_BROKER_TLS`;
- `TOKEN_BROKER_STATE_DIR`;
- `TOKEN_BROKER_ALLOWED_HOSTS`;
- `TOKEN_BROKER_REFRESH_SKEW_SECONDS`;
- `TOKEN_BROKER_ACCESS_TOKEN_TTL_SECONDS`;
- `TOKEN_BROKER_CLIENT_TOKEN_TTL_SECONDS`;
- `TOKEN_BROKER_SERVICE_NAME`;
- `TOKEN_BROKER_CLIENT`;
- `TOKEN_BROKER_CLIENT_TOKEN`;
- `TOKEN_BROKER_CA`;
- `TOKEN_BROKER_CERT`;
- `TOKEN_BROKER_KEY`.

Generated password, JWT signing secrets, the CA private key, and the server
private key prefer the operating system keychain. If it is unavailable, the
broker warns and falls back to mode-`0600` files in its state directory. CA and
server certificates are public and remain on disk. Client keys are exported as
mode-`0600` files because external and container clients must mount them.

## Public modules

- `cli` - Commander program and `runCli`;
- `config` / `defaults` - typed configuration and stable defaults;
- `broker` / `provider` / `google` - refresh coordination and provider adapter;
- `server` / `client` - broker protocol;
- `auth` / `secrets` / `tls` - client authorization and local credentials;
- `network` - Docker and Podman bind discovery;
- `service` - native user-service lifecycle.

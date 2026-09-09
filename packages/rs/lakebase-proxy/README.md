# dbx-tools-lakebase-proxy

Private loopback PostgreSQL proxy for Databricks Lakebase.

The proxy uses the shared `dbx-tools-databricks` Lakebase address parser and
discovery client. It accepts the same inputs as the Node parser: PostgreSQL
URLs, canonical resource paths, bare endpoint hostnames, and bare project ids.
The proxy discovers missing project, branch, endpoint, database, and principal
values, mints a fresh database credential, authenticates to Lakebase over
certificate-verified TLS, then forwards PostgreSQL protocol bytes opaquely.

## Run

Use the release binary through the shared `dbx` CLI:

```sh
dbx lakebase-proxy --port 5432
```

The first invocation downloads the matching GitHub release asset. Windows is
rejected before download because the Lakebase proxy has no Windows release.

For repository development:

```sh
cargo run -p dbx-tools-lakebase-proxy -- --port 5432
```

The listener defaults to `127.0.0.1:5432` and rejects non-loopback addresses.
Local clients use `sslmode=disable`; upstream Lakebase connections always use
verified TLS.

`LOG_LEVEL` accepts `debug`, `info`, `warn`, or `error`, case-insensitively,
and defaults to `info`. Individual connection lifecycle records are `debug`.
At `info`, the proxy emits aggregate opened, closed, failed, and active
connection counts once per minute.

```sh
psql "postgresql://localhost:5432/projects/sample-project?sslmode=disable"
```

PostgreSQL clients always send a startup user, even when a URL omits one. The
proxy treats that value as a Databricks profile only when it names a configured
profile. Otherwise it uses standard Databricks auth resolution:
`DATABRICKS_CONFIG_PROFILE`, the configured default profile, or automatic App
auth. Pass `--profile PROFILE` to force a profile. Inside a Databricks App,
automatic auth is used unless `--profile` is explicit.

## Accepted addresses

```text
projects/sample-project
projects/sample-project/branches/production
projects/sample-project/branches/production/endpoints/primary
projects/sample-project/branches/production/databases/application
endpoint.database.example.com
sample-project
postgresql://user@endpoint.database.example.com:5432/application?sslmode=require
```

Canonical resource paths and bare project ids are the normal startup database
values. A hostname triggers reverse endpoint discovery. PostgreSQL URLs are
accepted by the shared parser for configuration consumers.

## Format a connection URL

```sh
cargo run -p dbx-tools-lakebase-proxy -- url \
  --target projects/sample-project/branches/production/endpoints/primary
```

`--target` can be omitted when `LAKEBASE_ENDPOINT` is set. Output preserves the
canonical resource path and adds `sslmode=disable`.

## Resolution

- Explicit resource values win.
- A bare project selects its sole usable branch, project default branch, or
  unique branch marked default.
- An omitted endpoint requires one enabled read-write endpoint.
- An explicit database matches its resource id or PostgreSQL name.
- An omitted database prefers `databricks_postgres`, then the sole database.
- Archived, deleting, deleted, and disabled resources are excluded.
- Paginated Lakebase listings are followed.
- Bare hosts are matched against endpoint hosts across projects and branches.

Auth sessions and discovery metadata use bounded `mini-moka` caches. Database
credentials are minted for every upstream connection. One Databricks API `401`
is retried by the shared `dbx-tools-databricks` client.

## Protocol behavior

Each local connection owns one upstream connection. There is no pooling, reuse,
or multiplexing. Startup parameters are preserved except for `user` and
`database`, which become the resolved Databricks principal and PostgreSQL
database. After startup, the tunnel forwards prepared statements, COPY,
notifications, cancellation, and future protocol messages without parsing.

Local backend cancellation keys are synthetic. A matching local
`CancelRequest` opens a separate TLS connection and forwards the real upstream
key. Authentication failures use SQLSTATE `28000`, address and discovery
failures use `3D000`, protocol failures use `08P01`, and upstream connection
failures use `08001`.

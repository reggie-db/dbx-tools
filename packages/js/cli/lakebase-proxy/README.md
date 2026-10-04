# @dbx-tools/cli-lakebase-proxy

Pure Node loopback PostgreSQL proxy for Databricks Lakebase. It uses
`@dbx-tools/lakebase` for Node-owned address parsing, profile-aware resource
discovery, and per-connection database credentials. The upstream connection is
authenticated by `pg` over certificate-verified TLS, then tunneled opaquely.

```sh
dbx lakebase-proxy --profile PROFILE --port 5432
dbx lakebase-proxy url --target projects/example
```

The listener defaults to `127.0.0.1:5432` and rejects non-loopback addresses.
Local clients use `sslmode=disable`; upstream Lakebase connections always use
verified TLS. The startup `user` is treated as a Databricks profile only when it
matches a configured profile.

The initial Node implementation supports normal PostgreSQL sessions, including
the authentication modes supported by `pg`. PostgreSQL `CancelRequest`
forwarding remains explicit follow-up work before the Rust proxy can be deleted.

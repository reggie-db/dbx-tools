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

The proxy preserves startup parameters other than the resolved `user` and
`database`, supports the authentication modes implemented by `pg`, and maps
synthetic local cancellation keys onto verified-TLS upstream `CancelRequest`
connections.

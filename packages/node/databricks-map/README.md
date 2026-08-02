# @dbx-tools/databricks-map

An unfinished spike exploring graph queries over Databricks metadata - lineage,
tags, and ownership as a property graph, with Lakebase as the source of truth and
DuckDB + DuckPGQ as the query engine.

> **Status: not published, no stable surface.** This package is `private`.
> `src/graph.ts` is a placeholder and `src/lake-duck.ts` is a runnable
> exploration script rather than a library. Nothing here is exported for
> consumers, and it may be removed. Do not depend on it.

## What Exists

`src/lake-duck.ts` is a script that resolves a Lakebase host and OAuth token
through the Databricks CLI, `ATTACH`es the Postgres database, seeds demo
entities / tags / users / lineage, mirrors those tables into DuckDB memory
(DuckPGQ cannot build a property graph over attached Postgres tables), installs
`duckpgq`, and then loops on stdin - an email address runs an owner-lineage
traversal, anything else runs full-text search plus a graph query.

It requires DuckDB **1.4.x** specifically (DuckPGQ does not support 1.5):

```sh
DUCKDB_BIN=~/.local/bin/duckdb-1.4.4 \
  bun packages/node/databricks-map/src/lake-duck.ts \
  --profile DEFAULT \
  --endpoint projects/duck-base/branches/production/endpoints/primary
```

Flags: `--database`, `--alias`, `--user`, `--port`, `--tag` (first demo tag,
default `pii`), `--no-seed`, `--no-demo`, `--dry-run`.

For supported Lakebase and workspace helpers, use
[`@dbx-tools/databricks`](../databricks) and
[`@dbx-tools/appkit`](../appkit) instead.

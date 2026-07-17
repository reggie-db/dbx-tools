# @dbx-tools/appkit-env

`appkit-env`: run AppKit auto-configuration and print the environment variables
it added or changed. Snapshots `process.env`, runs
[`@dbx-tools/node-appkit`](../../node/appkit)'s `createApp.autoConfigure`, diffs,
and writes the deltas as eval-able shell `export` / Windows `set` lines (or
JSON).

```sh
# Load a resolved Lakebase Postgres connection into your current shell:
eval "$(appkit-env)"

# Or inspect what auto-config would set:
appkit-env --format json
appkit-env --format windows   # cmd `set` lines
```

## Options

```
-f, --format <export|windows|json>   output style (defaults by platform)
-q, --quiet                          suppress auto-config logs (LOG_LEVEL=error)
```

Auth + resolution use the standard Databricks SDK resolution (env vars,
`--profile`, or `databricks auth login`). `@databricks/appkit` is a runtime dep.

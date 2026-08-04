# Databricks notebooks

Runnable notebooks that exercise the `dbx-tools` Python packages on real
Databricks compute. Import one with the CLI and run it as a serverless notebook
task:

```bash
databricks workspace import /Shared/dbx-tools-bus-lakebase \
  --file packages/example/notebooks/bus-lakebase.py \
  --format SOURCE --language PYTHON --overwrite
```

| Notebook                             | What it proves                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| [`bus-lakebase.py`](bus-lakebase.py) | `dbx-tools-bus` publish/listen on Lakebase, on the driver and in a Spark UDF |

## `bus-lakebase.py`

Set the `endpoint` widget to a Lakebase endpoint (a canonical resource path, a
Postgres URI, a bare host, or a bare project id — anything
`dbx_tools.postgres.parse_address` understands). It then:

1. resolves host/database/user through `WorkspaceClient` with
   `resolve_postgres_connection`, minting credentials at connect time rather than
   baking them into a URL;
2. runs a driver-side `listen` -> `broadcast` -> assert-received round trip;
3. publishes from a Spark Python UDF on the executors and confirms the driver's
   listener receives every message.

It exits with `dbutils.notebook.exit(json.dumps(results))`, so a job run's output
is a machine-readable pass/fail per stage.

Two Databricks-runtime details it demonstrates, both explained in
[`packages/py/bus/README.md`](../../py/bus/README.md): install with `%pip` (a
`--target` install shadows `typing_extensions` and breaks the import), and drive
the async bus on its own thread because a notebook kernel already runs an event
loop.

The identity running the notebook needs a Postgres role on the Lakebase branch.
A service principal without one fails at connect with
`asyncpg.exceptions.InvalidPasswordError`, not at credential issuance — the
credential API happily returns a token for an identity that has no role.

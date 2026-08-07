# `dbx-tools-postgres`

Python Lakebase/Postgres connection setup, advisory locks, and topic fan-out for
services that already hold a Databricks `WorkspaceClient`. This package is
the Python counterpart to `@dbx-tools/postgres` plus `@dbx-tools/appkit`'s
address parsing.

Install from PyPI:

```bash
pip install dbx-tools-postgres
```

To install the current `main` branch directly from the repository instead:

```bash
pip install "dbx-tools-postgres @ git+https://github.com/reggie-db/dbx-tools.git@main#subdirectory=packages/py/postgres"
```

Key features:

- accepts the same Postgres URI, Lakebase resource path, hostname, and project-id
  address shapes as `@dbx-tools/appkit`;
- resolves missing autoscaling endpoint fields through
  `WorkspaceClient.api_client`;
- resolves provisioned Lakebase instance DNS through
  `WorkspaceClient.database`;
- injects a cached database credential on SQLAlchemy's `do_connect` event rather
  than storing an expiring password in the engine URL, using the SDK's
  provisioned-instance API or the Autoscaling `/postgres/credentials` endpoint;
- refreshes built-in credential providers ahead of expiry with a process-local
  check-lock-check load, so concurrent pool connections share one mint;
- supports sync psycopg and asyncpg SQLAlchemy engines;
- derives advisory-lock ids from the same stable structured keys as the Node
  package and holds one checked-out connection for the full critical section;
- provides blocking and try-lock context managers for session and transaction
  locks, with sync and async SQLAlchemy variants;
- fans messages out to every process on a channel with `PostgresTopicBus`, using
  the same lifecycle and wire envelope as the Node package.

```python
from databricks.sdk import WorkspaceClient
from dbx_tools.postgres import PostgresEngineConfig, create_async_engine

engine = create_async_engine(
    WorkspaceClient(),
    PostgresEngineConfig(instance_name="my-lakebase", database="databricks_postgres"),
    pool_pre_ping=True,
    pool_recycle=1800,
)
```

Pass `credential_provider=` to either engine factory to inject credentials from
another source. A custom provider owns its own cache, expiry, and refresh
serialization policy.

```python
from dbx_tools.postgres import advisory_transaction_lock

with advisory_transaction_lock(engine, ["schema-install", "v2"]) as connection:
    connection.exec_driver_sql("CREATE TABLE IF NOT EXISTS ...")
```

## Topic bus

`PostgresTopicBus` is async Postgres topic fan-out built on `LISTEN`/`NOTIFY`. Its
public lifecycle and wire shape match `@dbx-tools/postgres`'s `PostgresTopicBus`,
so Node and Python services can share a channel:

- `PostgresTopicBus(engine, options)`;
- `channelName`;
- `await start()`;
- `await broadcast(topic, TopicPublishInput(...))`;
- `await listen(topic, listener)` returning an async unsubscribe function;
- `await close()`;
- envelope fields `id`, `topic`, `type`, `metadata`, `body`, and `publishedAt`.

Channel derivation ports the Node stable-key and FNV rules, so equivalent channel
parts resolve to the same PostgreSQL identifier in Python and Node.

```python
from dbx_tools.postgres import PostgresTopicBus, TopicPublishInput

bus = PostgresTopicBus(engine, channel=["billing", "production"])

unsubscribe = await bus.listen("invoice.updated", handle_invoice)
await bus.broadcast(
    "invoice.updated",
    TopicPublishInput(type="invoice.updated", body={"invoice_id": "inv-7"}),
)
```

Delivery is live and unstored, like PostgreSQL `LISTEN`/`NOTIFY` itself. Use a
table or queue when consumers need replay or acknowledgements.

## Databricks notebooks and Spark

Verified end to end against a Lakebase endpoint on serverless notebook compute.
[`packages/example/notebooks/bus-lakebase.py`](../../example/notebooks/bus-lakebase.py)
is the runnable version of everything below.

Two things about the Databricks Python runtime change how the bus is called, and
neither is a limitation of the bus itself:

- **A notebook kernel already runs an event loop**, so `asyncio.run` in a cell
  raises `RuntimeError: asyncio.run() cannot be called from a running event
loop`. Drive the coroutine on a short-lived thread with its own loop rather
  than reaching for `nest_asyncio` — the bus holds a dedicated `LISTEN`
  connection bound to whichever loop started it, so one loop per bus lifetime is
  the invariant to preserve.
- **Install with `%pip install`, not `pip install --target`.** A `--target`
  install leaves the runtime's preloaded `typing_extensions` ahead of the new
  one on `sys.path`, and importing `dbx_tools.postgres` then fails with
  `ImportError: cannot import name 'TypeAliasType'`. `%pip` restarts the Python
  process, which resolves it.

### Publishing from a Spark UDF

Publishing from executors works. Listening from them does not, and should not be
attempted: a UDF invocation is short-lived, while `listen` keeps a connection
open until `close`.

Executors have no Databricks credentials, so they cannot build a
`WorkspaceClient`. This is where connect-time credential injection pays off — the
driver mints the Lakebase token once and the UDF closes over it, so the executor
builds a plain SQLAlchemy engine and installs the token as its provider:

```python
from sqlalchemy import URL
from sqlalchemy.ext.asyncio import create_async_engine
from dbx_tools.postgres import (
    PostgresTopicBus,
    TopicPublishInput,
    install_credential_injection,
)

# driver: resolve once, capture in the closure
resolved = resolve_postgres_connection(workspace_client, config)
token = workspace_client.api_client.do(
    "POST",
    "/api/2.0/postgres/credentials",
    body={"endpoint": resolved.endpoint},
)["token"]


@udf(returnType=StringType())
def publish(key: str) -> str:
    async def run() -> str:
        engine = create_async_engine(
            URL.create(
                "postgresql+asyncpg",
                username=resolved.user,
                host=resolved.host,
                port=resolved.port,
                database=resolved.database,
                query={"ssl": resolved.ssl_mode},
            )
        )
        install_credential_injection(engine.sync_engine, lambda: token)
        bus = PostgresTopicBus(engine, channel="app-events")
        try:
            message = await bus.broadcast(
                "row.processed", TopicPublishInput(type="row.processed", body={"key": key})
            )
            return message.id
        finally:
            await bus.close()
            await engine.dispose()

    return asyncio.run(run())
```

Constraints worth knowing before this reaches production:

- A captured token EXPIRES (about an hour). Re-mint per job run; a long-running
  streaming query needs a provider that refreshes instead of a captured string.
- Each UDF call opens and closes its own connection, so batch the publish at
  partition scope (`mapInPandas`, `foreachPartition`) rather than per row.
- `spark.sparkContext.broadcast` is unavailable on serverless (Spark Connect).
  A plain closure over driver-side values serializes with the UDF and is enough.
- Delivery stays live and unstored: if no listener is connected when the UDF
  publishes, the message is gone. Write to a table when executors produce
  results a consumer must not miss.

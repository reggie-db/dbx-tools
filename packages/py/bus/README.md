# `dbx-tools-bus`

Async Postgres topic fan-out for Python services. This package is currently an
unpublished uv-workspace package and is the Python counterpart to
`@dbx-tools/postgres`'s `PostgresTopicBus`.

Install directly from this monorepo. Its internal core and Postgres dependencies
use generated Git subdirectory references to the same repository branch:

```bash
pip install "dbx-tools-bus @ git+https://github.com/reggie-db/dbx-tools.git@main#subdirectory=packages/py/bus"
```

The public lifecycle and wire shape match Node:

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
from dbx_tools.bus import PostgresTopicBus, TopicPublishInput
from dbx_tools.postgres import PostgresEngineConfig, create_async_engine

engine = create_async_engine(workspace_client, PostgresEngineConfig(instance_name="app-db"))
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
from dbx_tools.bus import PostgresTopicBus, TopicPublishInput
from dbx_tools.postgres import install_credential_injection

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

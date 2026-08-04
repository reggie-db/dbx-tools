# Databricks notebook source
# MAGIC %md
# MAGIC # dbx-tools Python message bus on Lakebase
# MAGIC
# MAGIC Validates `dbx-tools-postgres`'s `PostgresTopicBus` against a Lakebase endpoint using
# MAGIC `WorkspaceClient`-backed connect-time credential injection.
# MAGIC
# MAGIC 1. driver publish/listen round trip
# MAGIC 2. publish from inside a Spark Python UDF (executors)

# COMMAND ----------

# MAGIC %pip install --quiet "git+https://github.com/reggie-db/dbx-tools.git@main#subdirectory=packages/py/postgres"

# COMMAND ----------

dbutils.library.restartPython()

# COMMAND ----------

import asyncio
import json
import os
import traceback

from databricks.sdk import WorkspaceClient
from dbx_tools.postgres import (
    PostgresEngineConfig,
    PostgresTopicBus,
    TopicPublishInput,
    create_async_engine,
    resolve_postgres_connection,
)

# Point this at your own Lakebase. Anything `parse_address` understands works:
# a canonical resource path, a Postgres URI, a bare host, or a bare project id.
# For a provisioned instance use `PostgresEngineConfig(instance_name=...)` instead.
dbutils.widgets.text("endpoint", os.environ.get("LAKEBASE_ENDPOINT", ""), "Lakebase endpoint")
dbutils.widgets.text("database", "databricks_postgres", "Database")
dbutils.widgets.text("topic", "demo-viewers", "Topic")

LAKEBASE_ENDPOINT = dbutils.widgets.get("endpoint").strip()
DATABASE = dbutils.widgets.get("database").strip() or "databricks_postgres"
TOPIC = dbutils.widgets.get("topic").strip() or "demo-viewers"
# The demo app leaves this at the package default, so a notebook publish shows up
# in every open browser tab of the running demo.
CHANNEL = "dbx_tools_topic_bus"

if not LAKEBASE_ENDPOINT:
    raise ValueError("Set the `endpoint` widget (or LAKEBASE_ENDPOINT) to a Lakebase endpoint")

results: dict[str, object] = {}


def run_async(factory):
    """Run a coroutine to completion from a notebook cell.

    A Databricks notebook kernel already has a running event loop, so
    `asyncio.run` raises there. Driving the coroutine on a dedicated thread with
    its own loop keeps the bus's `asyncio` lifecycle intact without needing
    `nest_asyncio`.
    """
    import threading

    outcome: dict = {}

    def target() -> None:
        try:
            outcome["value"] = asyncio.run(factory())
        except BaseException as error:
            outcome["error"] = error

    thread = threading.Thread(target=target, name="dbx-tools-bus")
    thread.start()
    thread.join()
    if "error" in outcome:
        raise outcome["error"]
    return outcome["value"]


workspace = WorkspaceClient()
resolved = resolve_postgres_connection(
    workspace,
    PostgresEngineConfig(endpoint=LAKEBASE_ENDPOINT, database=DATABASE),
)
results["identity"] = workspace.current_user.me().user_name
results["resolved"] = {
    "host": resolved.host,
    "database": resolved.database,
    "user": resolved.user,
    "endpoint": resolved.endpoint,
    "sslMode": resolved.ssl_mode,
}
print(json.dumps(results, indent=2))

# COMMAND ----------

# MAGIC %md ## 1. Driver publish + listen

# COMMAND ----------


def make_engine():
    return create_async_engine(
        workspace,
        PostgresEngineConfig(endpoint=LAKEBASE_ENDPOINT, database=DATABASE),
    )


async def driver_round_trip() -> dict:
    engine = make_engine()
    bus = PostgresTopicBus(engine, channel=CHANNEL)
    inbox: asyncio.Queue = asyncio.Queue()
    unsubscribe = await bus.listen(TOPIC, lambda message: inbox.put_nowait(message))
    try:
        published = await bus.broadcast(
            TOPIC,
            TopicPublishInput(
                type="notebook.driver",
                body={"hello": "world", "from": "databricks-driver"},
                metadata={"source": "notebook-driver"},
            ),
        )
        received = await asyncio.wait_for(inbox.get(), timeout=30)
        return {
            "channel": bus.channel_name,
            "publishedId": published.id,
            "receivedId": received.id,
            "match": received.id == published.id,
            "received": received.as_dict(),
        }
    finally:
        await unsubscribe()
        await bus.close()
        await engine.dispose()


try:
    results["driver"] = run_async(driver_round_trip)
    results["driver"]["ok"] = bool(results["driver"].get("match"))
except Exception as error:
    results["driver"] = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    traceback.print_exc()

print(json.dumps(results["driver"], indent=2, default=str))

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Publish from a Spark Python UDF
# MAGIC
# MAGIC Executors have no Databricks auth, so the driver mints a Lakebase credential and
# MAGIC passes it in as the engine's `credential_provider`. That is the whole point of
# MAGIC connect-time credential injection: the token never has to be in the URL, and the
# MAGIC provider can be any callable - including one closing over a broadcast token.

# COMMAND ----------

import uuid

from pyspark.sql.functions import col, udf
from pyspark.sql.types import StringType

RUN_TAG = uuid.uuid4().hex[:8]

# Serverless compute is Spark Connect, so `spark.sparkContext.broadcast` is not
# available. A plain closure over driver-side values is serialized with the UDF,
# which is all the executor needs.
CREDENTIAL_TOKEN = workspace.api_client.do(
    "POST",
    "/api/2.0/postgres/credentials",
    headers={"Accept": "application/json", "Content-Type": "application/json"},
    body={"endpoint": LAKEBASE_ENDPOINT},
)["token"]

CONNECTION = {
    "host": resolved.host,
    "database": resolved.database,
    "user": resolved.user,
    "port": resolved.port,
    "sslMode": resolved.ssl_mode,
}


@udf(returnType=StringType())
def publish_from_udf(partition_key: str) -> str:
    import asyncio as _asyncio
    import os as _os

    try:
        from dbx_tools.postgres import PostgresTopicBus as _Bus
        from dbx_tools.postgres import TopicPublishInput as _Input
        from dbx_tools.postgres import install_credential_injection as _inject
        from sqlalchemy import URL
        from sqlalchemy.ext.asyncio import create_async_engine as _create_async_engine
    except Exception as error:
        return f"IMPORT_ERROR {type(error).__name__}: {error}"

    async def run() -> str:
        url = URL.create(
            "postgresql+asyncpg",
            username=CONNECTION["user"],
            host=CONNECTION["host"],
            port=CONNECTION["port"],
            database=CONNECTION["database"],
            query={"ssl": CONNECTION["sslMode"]},
        )
        engine = _create_async_engine(url)
        _inject(engine.sync_engine, lambda: CREDENTIAL_TOKEN)
        bus = _Bus(engine, channel=CHANNEL)
        try:
            message = await bus.broadcast(
                TOPIC,
                _Input(
                    type="notebook.udf",
                    body={"hello": "world", "partition": partition_key, "run": RUN_TAG},
                    metadata={"source": "spark-udf", "pid": str(_os.getpid())},
                ),
            )
            return message.id
        finally:
            await bus.close()
            await engine.dispose()

    try:
        return _asyncio.run(run())
    except Exception as error:
        return f"ERROR {type(error).__name__}: {error}"


# COMMAND ----------


async def udf_round_trip() -> dict:
    engine = make_engine()
    bus = PostgresTopicBus(engine, channel=CHANNEL)
    inbox: asyncio.Queue = asyncio.Queue()

    def handle(message):
        if message.type == "notebook.udf":
            inbox.put_nowait(message)

    unsubscribe = await bus.listen(TOPIC, handle)
    try:
        frame = spark.range(3).select(col("id").cast("string").alias("partition"))
        frame = frame.withColumn("messageId", publish_from_udf(col("partition")))
        rows = await asyncio.get_running_loop().run_in_executor(None, frame.collect)
        published = [row["messageId"] for row in rows]
        received = []
        deadline = asyncio.get_running_loop().time() + 30
        while len(received) < len(published) and asyncio.get_running_loop().time() < deadline:
            try:
                received.append(await asyncio.wait_for(inbox.get(), timeout=5))
            except asyncio.TimeoutError:
                break
        return {
            "publishedIds": published,
            "receivedIds": [message.id for message in received],
            "receivedBodies": [message.body for message in received],
            "errors": [value for value in published if not value or "ERROR" in value],
        }
    finally:
        await unsubscribe()
        await bus.close()
        await engine.dispose()


try:
    udf_result = run_async(udf_round_trip)
    udf_result["ok"] = not udf_result["errors"] and set(udf_result["publishedIds"]) == set(
        udf_result["receivedIds"]
    )
    results["udf"] = udf_result
except Exception as error:
    results["udf"] = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    traceback.print_exc()

print(json.dumps(results["udf"], indent=2, default=str))

# COMMAND ----------

print(json.dumps(results, indent=2, default=str))
dbutils.notebook.exit(json.dumps(results, default=str))

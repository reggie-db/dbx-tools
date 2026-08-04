from __future__ import annotations

import asyncio
import random

from databricks.sdk import WorkspaceClient
from dbx_tools.bus import PostgresTopicBus, TopicPublishInput
from dbx_tools.postgres import create_async_engine

TOPIC = "demo-viewers"
MIN_DELAY_SECONDS = 5.0
MAX_DELAY_SECONDS = 10.0


async def main() -> None:
    workspace_client = WorkspaceClient()
    engine = create_async_engine(workspace_client, pool_pre_ping=True)
    bus = PostgresTopicBus(
        engine,
        metadata={
            "viewerId": "uv-emitter",
            "user": "uv emitter",
            "runtime": "python",
        },
    )
    sequence = 0
    try:
        while True:
            sequence += 1
            message = await bus.broadcast(
                TOPIC,
                TopicPublishInput(
                    type="demo.hello",
                    body="Hello world",
                    metadata={"sequence": sequence},
                ),
            )
            delay = random.uniform(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS)
            print(
                f"emitted {message.id}: Hello world; next message in {delay:.1f}s",
                flush=True,
            )
            await asyncio.sleep(delay)
    finally:
        await bus.close()
        await engine.dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
